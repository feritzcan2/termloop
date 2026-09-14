import ssh2, { type Client, type ConnectConfig, type PasswordAuthMethod, type PublicKeyAuthMethod, type AgentAuthMethod, type BaseAgent, type KnownPublicKeys, type KeyboardInteractiveAuthMethod, type ServerHostKeyAlgorithm } from "ssh2";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, chmod, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SshSetupInput, SshSetupLogin } from "../ssh-setup-types.js";
import { parseSshSetupAddress } from "../ssh-setup-types.js";

const execute = promisify(execFile);
const { Client: SshClient, utils } = ssh2;
const hostAlgorithms: ServerHostKeyAlgorithm[] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"];
export type SetupTarget = { host: string; user: string; port: number; name: string; identityFiles: string[]; identitiesOnly?: boolean; agent?: string };
export type HostIdentity = { key: Buffer; fingerprint: string };
export type ManagedSshIdentity = { identityFile: string; knownHostsFile: string; publicKey: string };

export async function resolveSetupTarget(input: SshSetupInput): Promise<SetupTarget> {
  const parsed = parseSshSetupAddress(input);
  let output: string;
  try {
    output = (await execute("ssh", ["-G", ...(parsed.port ? ["-p", String(parsed.port)] : []), ...(parsed.user ? ["-l", parsed.user] : []), parsed.host], { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true })).stdout;
  } catch { throw new Error("OpenSSH configuration could not be read. Install OpenSSH and check your SSH configuration."); }
  const values = new Map<string, string[]>();
  for (const line of output.split("\n")) {
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const key = line.slice(0, split);
    values.set(key, [...(values.get(key) ?? []), line.slice(split + 1).trim()]);
  }
  if (["proxycommand", "proxyjump"].some((key) => values.has(key) && values.get(key)?.[0] !== "none")) {
    throw new Error("This SSH alias uses a jump host. Use the existing-server connection form, or a directly reachable address for first-time setup.");
  }
  const host = values.get("hostname")?.[0] ?? parsed.host;
  const user = values.get("user")?.[0] ?? parsed.user ?? os.userInfo().username;
  const port = Number(values.get("port")?.[0] ?? parsed.port ?? 22);
  parseSshSetupAddress({ address: host, user, sshPort: port, name: parsed.name });
  const local = os.userInfo();
  const context: SshPathContext = { home: os.homedir(), localUser: local.username, localUid: String(local.uid), localHost: os.hostname(), host, originalHost: parsed.host, user, port, hostKeyAlias: values.get("hostkeyalias")?.[0] ?? parsed.host, jump: "", env: process.env };
  const configuredAgent = values.get("identityagent")?.[0] ?? process.env.SSH_AUTH_SOCK;
  const agentSetting = resolveIdentityAgent(configuredAgent, process.env);
  const agent = agentSetting && agentSetting !== "none" ? expandSshPath(agentSetting, context) : undefined;
  return {
    host, user, port, name: parsed.name, identitiesOnly: values.get("identitiesonly")?.[0] === "yes",
    identityFiles: (values.get("identityfile") ?? []).filter((file) => file !== "none").slice(0, 8).map((file) => expandSshPath(file, context)).filter((file): file is string => file !== undefined),
    ...(agent && agent !== "none" ? { agent } : {}),
  };
}

export function resolveIdentityAgent(value: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (value === "SSH_AUTH_SOCK") return env.SSH_AUTH_SOCK;
  const variable = value?.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  return variable ? env[variable] : value;
}

export function configuredAgent(agent: BaseAgent, keys: Buffer[], identitiesOnly: boolean): BaseAgent {
  const list = agent.getIdentities.bind(agent);
  agent.getIdentities = (callback) => list((error, identities) => {
    const matched: KnownPublicKeys = [];
    const remaining: KnownPublicKeys = [];
    for (const identity of identities ?? []) {
      let value: unknown = identity;
      for (let depth = 0; depth < 2 && value && typeof value === "object" && "pubKey" in value; depth++) value = value.pubKey;
      if (value && typeof value === "object" && "getPublicSSH" in value && typeof value.getPublicSSH === "function") value = value.getPublicSSH();
      if (typeof value !== "string" && !Buffer.isBuffer(value)) continue;
      const parsed = utils.parseKey(value);
      if (parsed instanceof Error || Array.isArray(parsed)) continue;
      if (keys.some((key) => key.equals(parsed.getPublicSSH()))) matched.push(identity);
      else if (!identitiesOnly) remaining.push(identity);
    }
    callback(error, [...matched, ...remaining]);
  });
  return agent;
}

export type SshPathContext = {
  home: string; localUser: string; localUid: string; localHost: string;
  host: string; originalHost: string; user: string; port: number; hostKeyAlias: string; jump: string;
  env: Record<string, string | undefined>;
};

export function expandSshPath(value: string, context: SshPathContext): string | undefined {
  const tokens: Record<string, string> = {
    "%": "%", d: context.home, h: context.host, i: context.localUid,
    j: context.jump, k: context.hostKeyAlias, L: context.localHost.split(".")[0]!,
    l: context.localHost, n: context.originalHost, p: String(context.port),
    r: context.user, u: context.localUser,
    C: createHash("sha1").update(`${context.localHost}${context.host}${context.port}${context.user}${context.jump}`).digest("hex"),
  };
  // Expand once: neither percent characters in paths nor environment values are shell code.
  let missing = false;
  const homePrefix = /^~(?=\/|$)/.test(value);
  const expanded = (homePrefix ? context.home : "") + (homePrefix ? value.slice(1) : value).replace(/%(.?)|\$\{([^}]+)\}/g, (_match, token: string | undefined, variable: string | undefined) => {
    const replacement = variable === undefined ? tokens[token ?? ""] : context.env[variable];
    if (replacement === undefined) missing = true;
    return replacement ?? "";
  });
  if (/^~/.test(expanded)) throw new Error("SSH paths using another user's home are not supported by setup. Use an absolute IdentityFile path.");
  return missing ? undefined : expanded;
}

export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function connectionOptions(target: SetupTarget): ConnectConfig {
  return { host: target.host, port: target.port, username: target.user, readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3, algorithms: { serverHostKey: hostAlgorithms } };
}

export function discoverHostIdentity(target: SetupTarget, signal: AbortSignal): Promise<HostIdentity> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let identity: HostIdentity | undefined;
    const abort = () => { client.destroy(); reject(new Error("Setup cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", (error) => { if (!identity) reject(sshSetupError(error)); });
    client.once("close", () => { signal.removeEventListener("abort", abort); if (!identity) reject(new Error("The SSH server closed the connection.")); });
    if (signal.aborted) { abort(); return; }
    client.connect({ ...connectionOptions(target), hostVerifier: (key: Buffer) => {
      identity = { key: Buffer.from(key), fingerprint: hostFingerprint(key) };
      resolve(identity);
      return false; // Discovery never authenticates or trusts a host automatically.
    } });
  });
}

export async function authenticateSetup(target: SetupTarget, identity: HostIdentity, credentials: Omit<SshSetupLogin, "id" | "fingerprint">, signal: AbortSignal, managed?: ManagedSshIdentity): Promise<Client> {
  const attempts: (PasswordAuthMethod | PublicKeyAuthMethod | AgentAuthMethod | KeyboardInteractiveAuthMethod)[] = [];
  if (managed) {
    attempts.push({ type: "publickey", username: target.user, key: await readPrivateKey(managed.identityFile) });
  } else {
    const configuredKeys: Buffer[] = [];
    for (const file of target.identityFiles) {
      try {
        const contents = await readPrivateKey(file);
        const key = utils.parseKey(contents, credentials.passphrase);
        if (!(key instanceof Error) && !Array.isArray(key)) {
          configuredKeys.push(key.getPublicSSH());
          if (key.isPrivateKey()) attempts.push({ type: "publickey", username: target.user, key });
        }
        const publicKey = utils.parseKey(await readPrivateKey(`${file}.pub`).catch(() => Buffer.alloc(0)));
        if (!(publicKey instanceof Error) && !Array.isArray(publicKey)) configuredKeys.push(publicKey.getPublicSSH());
      } catch { /* Missing or locked keys fall back to the supplied login. */ }
    }
    if (target.agent) attempts.push({ type: "agent", username: target.user, agent: configuredAgent(ssh2.createAgent(target.agent), configuredKeys, !!target.identitiesOnly) });
    if (credentials.password) attempts.unshift({ type: "password", username: target.user, password: credentials.password });
  }
  return await new Promise((resolve, reject) => {
    const client = new SshClient();
    let passwordPromptAnswered = false;
    if (!managed) attempts.push({ type: "keyboard-interactive", username: target.user, prompt: (_name, _instructions, _language, prompts, finish) => {
      if (!prompts.length) { finish([]); return; }
      if (!passwordPromptAnswered && credentials.password && prompts.length === 1 && !prompts[0]!.echo && /^password\s*:/i.test(prompts[0]!.prompt.trim())) {
        passwordPromptAnswered = true;
        finish([credentials.password]);
        return;
      }
      reject(new Error("This server requires interactive SSH verification (such as MFA). Use Terminal to sign in; automatic setup needs an SSH key or standard password login."));
      client.destroy();
    } });
    const abort = () => { client.destroy(); reject(new Error("Setup cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", (error) => reject(sshSetupError(error)));
    client.once("close", () => { signal.removeEventListener("abort", abort); reject(new Error("The SSH connection ended. Sign in again to continue.")); });
    client.once("ready", () => { attempts.splice(0); resolve(client); });
    if (signal.aborted) { abort(); return; }
    client.connect({ ...connectionOptions(target), authHandler: attempts, hostVerifier: (key: Buffer) => key.equals(identity.key) });
  });
}

async function readPrivateKey(file: string): Promise<Buffer> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("SSH key file is invalid.");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer);
    if (bytesRead > 64 * 1024) throw new Error("SSH key file is too large.");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export function sshSetupError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error("Server address could not be found. Check the hostname.");
  if (code === "ECONNREFUSED") return new Error("SSH is not accepting connections on this port. Check the SSH port and server status.");
  if (code === "ETIMEDOUT" || /timed out/i.test(message)) return new Error("The server did not respond. Check that it is running and reachable from this computer.");
  if (/authentication methods|authentication failed/i.test(message)) return new Error("SSH sign-in failed. Enter the server user's password, or unlock your SSH key and try again.");
  if (/host denied|verification failed/i.test(message)) return new Error("The server identity changed. Restart setup and verify its fingerprint before signing in.");
  return new Error("SSH connection failed. Check the address, port and server status, then try again.");
}

export function remoteCommand(client: Client, command: string, options: { input?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    let closeChannel = () => undefined;
    const finish = (error?: Error, output = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.off("close", disconnected);
      closeChannel();
      error ? reject(error) : resolve(output);
    };
    const disconnected = () => finish(new Error("SSH disconnected during setup. Sign in again to check the server and continue."));
    const timer = setTimeout(() => finish(new Error("This setup step timed out. Check the server and try again.")), options.timeout ?? 20_000);
    client.once("close", disconnected);
    client.exec(command, (error, channel) => {
      if (error) { finish(new Error("The server could not start this setup step.")); return; }
      closeChannel = () => { channel.close(); };
      if (done) { closeChannel(); return; }
      let output = "";
      channel.on("data", (chunk: Buffer) => {
        output += String(chunk);
        if (output.length > 64 * 1024) finish(new Error("The server returned too much output for this setup step."));
      });
      let diagnostic = "";
      channel.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + String(chunk)).slice(-8192); });
      channel.on("error", () => finish(new Error("The SSH setup channel failed.")));
      channel.once("close", (code: number | undefined) => finish(code === 0 ? undefined : setupCommandError(diagnostic), output));
      channel.end(options.input ?? "");
    });
  });
}

function setupCommandError(diagnostic: string): Error {
  // Only fixed, allowlisted messages cross IPC; remote commands and secrets do not.
  if (diagnostic.includes("Server package has no compatibility information")) return new Error("This package is too old to verify compatibility. Choose a server package from the same source as this desktop. The running server has not been changed.");
  if (diagnostic.includes("Server package is not compatible with this desktop")) return new Error("This server package is not compatible with this desktop. Choose a matching package. The running server has not been changed.");
  if (/server archive (checksum mismatch|entry)|Incomplete server archive|Server archives must contain|Server package identity does not match/i.test(diagnostic)) return new Error("The server package failed validation. Download a fresh Linux x64 server package from the same release and retry.");
  if (/Could not get lock|Unable to acquire.*lock|is another process using it/i.test(diagnostic)) return new Error("Another package installation is running on the server. Wait for it to finish, then retry.");
  if (/Could not resolve|Temporary failure resolving|Name or service not known/i.test(diagnostic)) return new Error("The server could not resolve a download address. Check its DNS and internet connection, then retry.");
  if (/curl: \(28\)|timed out|Timeout was reached/i.test(diagnostic)) return new Error("A server download timed out. Check the server's internet connection and retry.");
  if (/curl: \(60\)|certificate.*(failed|expired)|SSL certificate/i.test(diagnostic)) return new Error("The server could not verify a download certificate. Check its clock and CA certificates.");
  if (/HTTP 404|returned error: 404|missing the supported server asset/i.test(diagnostic)) return new Error("No published server package was found for this desktop release. Choose a matching Linux server package in Advanced options.");
  if (/No space left|free is required/i.test(diagnostic)) return new Error("The server ran out of free space. Free disk space and retry.");
  if (/restored TermLoop/i.test(diagnostic)) return new Error("The new server failed its health check. The previous server and its data were restored.");
  if (/Failed to connect to (bus|user scope bus)|Failed to start|did not become healthy/i.test(diagnostic)) return new Error("The server's background service could not start. Check its systemd user service before retrying.");
  return new Error("The server could not complete this step. Check the setup guidance below before retrying.");
}

export function managedIdentityPaths(root: string, id: string): { identityFile: string; knownHostsFile: string } {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error("Invalid SSH identity.");
  return { identityFile: path.join(root, "ssh", id, "id_ed25519"), knownHostsFile: path.join(root, "ssh", id, "known_hosts") };
}

export async function createManagedIdentity(root: string, id: string, target: SetupTarget, identity: HostIdentity): Promise<ManagedSshIdentity> {
  const paths = managedIdentityPaths(root, id);
  await mkdir(path.dirname(paths.identityFile), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(paths.identityFile), 0o700);
  let publicKey: string;
  try {
    publicKey = await readFile(`${paths.identityFile}.pub`, "utf8");
  } catch {
    const keys = utils.generateKeyPairSync("ed25519", { comment: "TermLoop" });
    await writeFile(paths.identityFile, keys.private, { mode: 0o600, flag: "wx" });
    publicKey = keys.public;
    await writeFile(`${paths.identityFile}.pub`, publicKey, { mode: 0o600, flag: "wx" });
  }
  const parsed = utils.parseKey(identity.key);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Unsupported SSH server identity.");
  const host = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
  await writeFile(paths.knownHostsFile, `${host} ${parsed.type} ${identity.key.toString("base64")}\n`, { mode: 0o600 });
  return { ...paths, publicKey: publicKey.trim() };
}
