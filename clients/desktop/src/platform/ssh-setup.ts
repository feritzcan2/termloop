import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Client } from "ssh2";
import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import type { ConnectionProfileConnectInput, ConnectionProfileConnectResult } from "../connection-profile-types.js";
import type { SshSetupInput, SshSetupLogin, SshSetupState } from "../ssh-setup-types.js";
import {
  authenticateSetup, createManagedIdentity, discoverHostIdentity, remoteCommand, resolveSetupTarget,
  type HostIdentity, type SetupTarget,
} from "./ssh-setup-connection.js";
import { inspectMachineScript, inspectServerScript, installNodeScript, prepareUserScript, remoteCliCommand, serverUserCommand, shellQuote } from "./ssh-setup-scripts.js";

type Operation = {
  owner: number;
  state: SshSetupState;
  target?: SetupTarget;
  identity?: HostIdentity;
  client?: Client;
  serverUser?: string;
  admin?: "root" | "sudo" | "user";
  abort: AbortController;
  expires: ReturnType<typeof setTimeout>;
  work?: Promise<void> | undefined;
  sourceArchive?: string;
  remotePort?: number;
  serverFingerprint?: string;
  reviewed?: boolean;
  completed?: boolean;
  connected?: ConnectionProfileConnectResult;
  connecting?: Promise<ConnectionProfileConnectResult> | undefined;
};

export class SshSetupManager {
  #operations = new Map<string, Operation>();
  constructor(private readonly root: string, private readonly assets: string, private readonly version: string, private readonly protocol = CONTRACT_IDENTITY as string) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Server setup requires a stable desktop version.");
  }

  async start(owner: number, input: SshSetupInput): Promise<SshSetupState> {
    if ([...this.#operations.values()].some((op) => op.owner === owner && (op.work || op.connecting || op.state.phase === "checking"))) throw new Error("A server setup is already running. Return to it to continue.");
    this.cancelOwner(owner);
    if (this.#operations.size >= 8) throw new Error("Too many server setup attempts are open.");
    const id = randomUUID();
    const operation: Operation = {
      owner, abort: new AbortController(),
      state: { id, name: "", host: "", user: "", sshPort: 22, fingerprint: "", phase: "checking", message: "Checking the SSH server…", steps: [] },
      expires: setTimeout(() => this.cancel(owner, id), 30 * 60_000),
    };
    operation.expires.unref();
    this.#operations.set(id, operation);
    try {
      const target = await resolveSetupTarget(input);
      const identity = await discoverHostIdentity(target, operation.abort.signal);
      this.#check(operation);
      operation.target = target;
      operation.identity = identity;
      Object.assign(operation.state, { phase: "identity", message: "Verify this server's fingerprint against the record from your server provider.", name: target.name, host: target.host, user: target.user, sshPort: target.port, fingerprint: identity.fingerprint });
      return this.status(owner, id);
    } catch (error) {
      this.cancel(owner, id);
      throw error;
    }
  }

  current(owner: number): SshSetupState | null {
    const operation = [...this.#operations.values()].find((op) => op.owner === owner && !op.completed);
    return operation ? this.status(owner, operation.state.id) : null;
  }

  status(owner: number, id: string): SshSetupState {
    const operation = this.#get(owner, id);
    return { ...operation.state, busy: !!operation.work || !!operation.connecting || operation.state.phase === "checking", steps: [...operation.state.steps] };
  }

  async login(owner: number, input: SshSetupLogin): Promise<SshSetupState> {
    const operation = this.#get(owner, input?.id);
    if (!["identity", "login", "error"].includes(operation.state.phase) || operation.work) throw new Error("Finish the current setup step first.");
    if (input.fingerprint !== operation.identity?.fingerprint) throw new Error("Confirm this server's displayed fingerprint before signing in.");
    for (const secret of [input.password, input.passphrase]) {
      if (secret !== undefined && (typeof secret !== "string" || secret.length > 8192 || secret.includes("\0"))) throw new Error("Invalid SSH credentials.");
    }
    operation.client?.end();
    delete operation.client;
    delete operation.admin;
    delete operation.serverUser;
    operation.reviewed = false;
    operation.state.phase = "login";
    const work = this.#login(operation, input);
    operation.work = work;
    try { await work; } finally { operation.work = undefined; }
    return this.status(owner, input.id);
  }

  async #login(operation: Operation, input: SshSetupLogin): Promise<void> {
    try {
      operation.client = await authenticateSetup(operation.target!, operation.identity!, input, operation.abort.signal);
      this.#check(operation);
      const machine = (await remoteCommand(operation.client, `sh -c ${shellQuote(inspectMachineScript)}`)).trim().split("\n");
      const [os, arch, uid, user, service, packages, admin, free] = machine;
      if (os !== "Linux" || arch !== "x86_64" || service !== "systemd") throw new Error("Automatic setup currently supports Linux x64 servers with systemd.");
      if (!["root", "sudo", "user"].includes(admin ?? "")) throw new Error("The server's administration access could not be checked.");
      if (!/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(user ?? "")) throw new Error("The server returned an invalid account name.");
      if (!Number.isFinite(Number(free)) || Number(free) < 2 * 1024 * 1024) throw new Error("At least 2 GiB of free space is needed to set up this server.");
      operation.admin = admin as "root" | "sudo" | "user";
      operation.serverUser = uid === "0" ? "termloop-admin" : user!;
      const installed = (await remoteCommand(operation.client, inspectServerScript(operation.serverUser, operation.admin!))).trim().split("\n");
      operation.state.installed = installed[0] === "installed";
      operation.state.needsAdmin = admin === "user" && installed[2] !== "linger";
      if (operation.state.needsAdmin) throw new Error("Background services need administrator access. Sign in as root or a user with passwordless sudo to finish first-time setup.");
      if (packages !== "apt") throw new Error("Automatic setup currently supports Debian and Ubuntu. Use the existing-server connection form for other Linux distributions.");
      operation.state.phase = "review";
      operation.reviewed = true;
      operation.state.message = operation.state.installed ? "Check and prepare this TermLoop installation, then connect." : `Install TermLoop ${this.version} and connect to this server.`;
      operation.state.steps = [
        `Set up SSH key access for ${operation.serverUser}`,
        ...(operation.state.installed ? ["Check the existing server and start it if needed"] : ["Install Node.js and the TermLoop server", "Start TermLoop automatically, including after a reboot"]),
        "Enable automatic stable updates and keep the previous release for recovery",
        "Verify desktop compatibility and connect",
      ];
    } catch (error) {
      this.#check(operation);
      operation.state.phase = operation.client ? "error" : "login";
      operation.state.message = error instanceof Error ? error.message : "Server sign-in failed.";
    }
  }

  async selectArchive(owner: number, id: string, archive: string): Promise<SshSetupState> {
    const operation = this.#get(owner, id);
    if (operation.work || !operation.reviewed || !["review", "error"].includes(operation.state.phase)) throw new Error("Finish signing in and checking the server before choosing a server package.");
    const metadata = await stat(archive);
    if (!metadata.isFile() || metadata.size > 256 * 1024 * 1024 || !archive.endsWith(".tar.gz")) throw new Error("Choose a TermLoop server .tar.gz package smaller than 256 MiB.");
    operation.sourceArchive = archive;
    operation.state.phase = "review";
    operation.state.message = `Use server package: ${path.basename(archive)}. Compatibility will be checked before changing the running server.`;
    return this.status(owner, id);
  }

  install(owner: number, id: string): SshSetupState {
    const operation = this.#get(owner, id);
    if (operation.state.phase !== "review" || !operation.reviewed || operation.work || !operation.client) throw new Error("Review the server setup before installing.");
    operation.state.phase = "installing";
    operation.work = this.#install(operation).catch((error: unknown) => {
      if (operation.abort.signal.aborted) return;
      operation.state.phase = "error";
      operation.state.message = `${operation.state.message.replace(/…$/, "")}: ${error instanceof Error ? error.message : "Server setup failed. Sign in again to retry."}`;
    }).finally(() => { operation.work = undefined; });
    return this.status(owner, id);
  }

  async #install(operation: Operation): Promise<void> {
    const { client, target, identity, serverUser, admin } = operation;
    if (!client || !target || !identity || !serverUser || !admin) throw new Error("Sign in again to continue.");
    const step = (message: string) => { this.#check(operation); operation.state.message = message; };
    step("Preparing SSH access and background services…");
    const managed = await createManagedIdentity(this.root, operation.state.id, target, identity);
    await remoteCommand(client, prepareUserScript(serverUser, admin, managed.publicKey), { timeout: 10 * 60_000 });
    step("Checking the new SSH key…");
    const verified = await authenticateSetup({ ...target, user: serverUser }, identity, {}, operation.abort.signal, managed);
    try { await remoteCommand(verified, "true"); } finally { verified.end(); }
    step("Preparing Node.js…");
    await remoteCommand(client, installNodeScript(serverUser, admin), { timeout: 8 * 60_000 });
    step("Installing the compatible TermLoop release…");
    const stage = `.local/share/termloop-server/.setup-${operation.state.id}`;
    try {
      await remoteCommand(client, serverUserCommand(serverUser, admin, `umask 077
mkdir -p "$HOME/${stage}"
touch "$HOME/${stage}/.desktop-ssh-setup"
find "$HOME/.local/share/termloop-server" -maxdepth 1 -type d -name '.setup-*' -mmin +1440 -exec sh -c 'test ! -f "$1/.desktop-ssh-setup" || rm -rf -- "$1"' sh {} ';'`));
      for (const file of ["termloop-server-manager.mjs", "server-release.mjs"]) {
        const contents = await readFile(path.join(this.assets, file), "utf8");
        await remoteCommand(client, serverUserCommand(serverUser, admin, `umask 077; base64 -d > "$HOME/${stage}/${file}"`), { input: Buffer.from(contents).toString("base64") });
      }
      let option = `--version=${this.version}`;
      if (operation.sourceArchive) {
        // Transfer over the independently verified owner connection, avoiding root-owned uploads.
        const owner = await authenticateSetup({ ...target, user: serverUser }, identity, {}, operation.abort.signal, managed);
        try {
          await uploadArchive(owner, operation.sourceArchive, `${stage}/source.tar.gz`, operation.abort.signal);
        } finally { owner.end(); }
        option = `--source-archive="$HOME/${stage}/source.tar.gz"`;
      }
      await remoteCommand(client, serverUserCommand(serverUser, admin, `node "$HOME/${stage}/termloop-server-manager.mjs" install ${option} --expected-protocol=${this.protocol} >/dev/null\nsystemctl --user start termloop-next.service\nsystemctl --user enable --now termloop-next-update.timer\nfor attempt in $(seq 1 45); do\n  node "$HOME/.local/share/termloop-server/current/termloopctl" version --json --runtime "$XDG_RUNTIME_DIR/termloop-next/runtime.json" >/dev/null 2>&1 && exit 0\n  sleep 1\ndone\nexit 1`), { timeout: 15 * 60_000 });
    } finally {
      if (!operation.abort.signal.aborted) await remoteCommand(client, serverUserCommand(serverUser, admin, `rm -rf -- "$HOME/${stage}"`)).catch(() => undefined);
    }
    step("Checking server compatibility…");
    const version = parseObject(await remoteCommand(client, remoteCliCommand(serverUser, admin, "version")));
    if (typeof version.version === "string") operation.state.version = version.version.slice(0, 40);
    if (version.protocolVersion !== this.protocol) throw new Error("This server build is not compatible with this desktop build. Use a matching stable desktop release, or choose a server package built from the same source in Advanced options.");
    step("Enabling the secure connection…");
    const access = parseObject(await remoteCommand(client, remoteCliCommand(serverUser, admin, "access-enable")));
    if (access.enabled !== true || access.listening !== true || typeof access.port !== "number" || access.port < 1024 || access.port > 65535 || !/^sha256:[0-9a-f]{64}$/.test(String(access.server_fingerprint))) throw new Error("TermLoop is installed but its connection service is not ready. Sign in again to retry.");
    await remoteCommand(client, remoteCliCommand(serverUser, admin, "ping"));
    this.#check(operation);
    operation.remotePort = access.port;
    operation.serverFingerprint = String(access.server_fingerprint);
    operation.state.user = serverUser;
    operation.state.phase = "ready";
    operation.state.message = "Server verified. Finish connecting to add its projects and agent accounts.";
  }

  connectionInput(owner: number, id: string): ConnectionProfileConnectInput {
    const operation = this.#get(owner, id);
    if (operation.state.phase !== "ready" || !operation.remotePort || !operation.serverFingerprint) throw new Error("Finish server verification before connecting.");
    return { name: operation.state.name, expectedServerFingerprint: operation.serverFingerprint, transport: { kind: "ssh", host: operation.state.host, user: operation.state.user, sshPort: operation.state.sshPort, remotePort: operation.remotePort, managedIdentity: id } };
  }

  connect(owner: number, id: string, save: (input: ConnectionProfileConnectInput) => Promise<ConnectionProfileConnectResult>, verify: (profileId: string) => Promise<unknown>): Promise<ConnectionProfileConnectResult> {
    const operation = this.#get(owner, id);
    const input = this.connectionInput(owner, id);
    operation.connecting ??= (async () => {
      operation.connected ??= await save(input);
      this.#check(operation);
      await verify(operation.connected.profile.id);
      this.#check(operation);
      operation.client?.end();
      operation.completed = true;
      return operation.connected;
    })().finally(() => { operation.connecting = undefined; });
    return operation.connecting;
  }

  cancel(owner: number, id: string): void {
    const operation = this.#operations.get(id);
    if (!operation || operation.owner !== owner) return;
    clearTimeout(operation.expires);
    operation.abort.abort();
    operation.client?.destroy();
    this.#operations.delete(id);
  }

  cancelOwner(owner: number): void {
    for (const [id, operation] of this.#operations) if (operation.owner === owner) this.cancel(owner, id);
  }

  #get(owner: number, id: string): Operation {
    const operation = this.#operations.get(id);
    if (!operation || operation.owner !== owner) throw new Error("This setup attempt has ended. Start again to continue.");
    return operation;
  }

  #check(operation: Operation): void {
    if (operation.abort.signal.aborted) throw new Error("Setup cancelled.");
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Return a bounded, credential-free diagnostic. */ }
  throw new Error("The server returned an invalid status response.");
}

async function uploadArchive(client: Client, local: string, remote: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.destroy(); reject(new Error("Server package upload timed out.")); }, 5 * 60_000);
    const abort = () => { clearTimeout(timer); client.destroy(); reject(new Error("Setup cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    const finish = (error?: Error | null) => { clearTimeout(timer); signal.removeEventListener("abort", abort); error ? reject(new Error("Server package could not be uploaded.")) : resolve(); };
    if (signal.aborted) { abort(); return; }
    client.sftp((error, sftp) => {
      if (error) { finish(error); return; }
      sftp.fastPut(local, remote, { mode: 0o600 }, (error) => { sftp.end(); finish(error); });
    });
  });
}
