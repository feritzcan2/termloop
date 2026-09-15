import { afterEach, describe, expect, it } from "vitest";
import ssh2, { Server, utils, type Connection } from "ssh2";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSshSetupAddress } from "../src/ssh-setup-types.js";
import { authenticateSetup, configuredAgent, resolveIdentityAgent, expandSshPath, createManagedIdentity, discoverHostIdentity, hostFingerprint, managedIdentityPaths, remoteCommand, type SetupTarget } from "../src/platform/ssh-setup-connection.js";
import { inspectMachineScript, prepareUserScript, installNodeScript, serverUserCommand, shellQuote } from "../src/platform/ssh-setup-scripts.js";
import { sshTunnelArgs, spawnSshTunnel } from "../src/platform/ssh-runtime.js";
import { supportsPosixFileModes } from "../src/platform/test-support.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function server(command: (text: string) => { output?: string; stderr?: string; code?: number; hang?: boolean } = () => ({ output: "ok" }), keyboard?: "password" | "mfa") {
  const keys = utils.generateKeyPairSync("ed25519");
  const sockets = new Set<Connection>();
  let authCount = 0;
  const listener = new Server({ hostKeys: [keys.private] }, (connection) => {
    sockets.add(connection);
    connection.on("error", () => undefined);
    connection.on("close", () => sockets.delete(connection));
    connection.on("authentication", (context) => {
      authCount++;
      if (keyboard) {
        if (context.method !== "keyboard-interactive") { context.reject(["keyboard-interactive"]); return; }
        context.prompt([{ prompt: keyboard === "password" ? "Password:" : "Verification code:", echo: false }], (answers) => answers[0] === "test-only-password" ? context.accept() : context.reject());
        return;
      }
      if (context.method === "password" && context.password === "test-only-password") context.accept();
      else if (context.method === "publickey") {
        const key = utils.parseKey(context.key.data);
        if (!(key instanceof Error) && !Array.isArray(key) && (!context.signature || key.verify(context.blob!, context.signature, context.hashAlgo))) context.accept();
        else context.reject();
      } else context.reject(["password", "publickey"]);
    });
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept, _reject, request) => {
        const channel = accept();
        channel.on("data", () => undefined);
        const response = command(request.command);
        if (response.output) channel.write(response.output);
        if (response.stderr) channel.stderr.write(response.stderr);
        if (!response.hang) { channel.exit(response.code ?? 0); channel.end(); }
      });
    }));
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.end(); await new Promise<void>((resolve) => listener.close(() => resolve())); });
  const address = listener.address();
  if (typeof address === "string" || !address) throw new Error("No SSH listener");
  const target: SetupTarget = { host: "127.0.0.1", user: "testuser", port: address.port, name: "Test server", identityFiles: [] };
  return { target, keys, authCount: () => authCount };
}

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "termloop ssh setup test "));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("SSH setup address parsing", () => {
  it.each([
    ["ssh root@89.58.51.102", { host: "89.58.51.102", user: "root" }],
    ["ssh -p 2202 user@server.example", { host: "server.example", user: "user", port: 2202 }],
    ["ssh://user@[2001:db8::1]:2222", { host: "2001:db8::1", user: "user", port: 2222 }],
    ["netcup-termloop", { host: "netcup-termloop" }],
  ])("accepts %s", (address, expected) => expect(parseSshSetupAddress({ address })).toMatchObject(expected));
  it.each(["ssh -oProxyCommand=bad host", "host;touch /tmp/no", "$(whoami)", "ssh://user:secret@host", "ssh://host/path", "-host", "user@@host", "ssh -p 0 host", "ssh -p 65536 host", "ssh host && echo no"]) ("rejects command syntax or invalid credentials in %s", (address) => expect(() => parseSshSetupAddress({ address })).toThrow());
});

describe("SSH setup transport", () => {
  it("discovers a fingerprint without authenticating and rejects a changed host key", async () => {
    const fixture = await server();
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    expect(identity.fingerprint).toBe(hostFingerprint(identity.key));
    expect(fixture.authCount()).toBe(0);
    const wrong = { ...identity, key: Buffer.from("untrusted-key") };
    await expect(authenticateSetup(fixture.target, wrong, { password: "test-only-password" }, signal)).rejects.toThrow(/identity changed/);
    expect(fixture.authCount()).toBe(0);
  });

  it("uses a password only after host verification, with safe authentication failures", async () => {
    const fixture = await server();
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    await expect(authenticateSetup(fixture.target, identity, { password: "wrong-secret-value" }, signal)).rejects.toThrow(/sign-in failed/);
    const client = await authenticateSetup(fixture.target, identity, { password: "test-only-password" }, signal);
    try { expect(await remoteCommand(client, "true")).toBe("ok"); } finally { client.end(); }
  });

  it("bounds output, times out hung commands, and never returns remote stderr", async () => {
    const fixture = await server((command) => command === "large" ? { output: "x".repeat(70_000) } : command === "hang" ? { hang: true } : { code: 1, stderr: "private-server-secret" });
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    const client = await authenticateSetup(fixture.target, identity, { password: "test-only-password" }, signal);
    try {
      await expect(remoteCommand(client, "large")).rejects.toThrow(/too much output/);
      await expect(remoteCommand(client, "hang", { timeout: 20 })).rejects.toThrow(/timed out/);
      await expect(remoteCommand(client, "error")).rejects.toThrow(/^The server could not complete this step\. Check the setup guidance below before retrying\.$/);
    } finally { client.end(); }
  });

  it("writes a restricted, reusable key and uses the pinned identity with real OpenSSH", async () => {
    const fixture = await server();
    const root = await temporaryDirectory();
    const id = "b65f4086-e46c-4aef-9eab-57f96fcaa629";
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    const managed = await createManagedIdentity(root, id, fixture.target, identity);
    // Windows exposes synthetic mode bits; OpenSSH below checks actual key access
    // on every host, while POSIX hosts also enforce owner-only file permissions.
    if (supportsPosixFileModes) expect((await stat(managed.identityFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(managed.knownHostsFile, "utf8")).toContain(`[127.0.0.1]:${fixture.target.port}`);
    expect((await createManagedIdentity(root, id, fixture.target, identity)).publicKey).toBe(managed.publicKey);
    const client = await authenticateSetup(fixture.target, identity, {}, signal, managed);
    client.end();
    const tunnel = await spawnSshTunnel({ host: fixture.target.host, user: fixture.target.user, sshPort: fixture.target.port, remotePort: 43717, ...managed });
    tunnel.stop();
    expect(() => managedIdentityPaths(root, "../../private")).toThrow(/Invalid/);
    const args = sshTunnelArgs({ host: fixture.target.host, sshPort: fixture.target.port, remotePort: 43717, ...managed }, 51000);
    expect(args).toContain(`UserKnownHostsFile="${managed.knownHostsFile}"`);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentitiesOnly=yes");
  });

  it.each([
    ["E: Could not get lock /var/lib/dpkg/lock-private", "Another package installation is running"],
    ["curl: (6) Could not resolve host: private.example", "could not resolve a download address"],
    ["curl: (28) Operation timed out", "download timed out"],
    ["curl: (60) SSL certificate problem", "could not verify a download certificate"],
    ["HTTP 404 at a private URL", "No published server package"],
    ["No space left on device", "ran out of free space"],
    ["Failed to connect to bus", "background service could not start"],
    ["Update failed; restored TermLoop 2.0.4: did not become healthy", "previous server and its data were restored"],
    ["Server package is not compatible with this desktop", "running server has not been changed"],
    ["Unexpected or duplicate server archive entry: private-file", "server package failed validation"],
  ])("explains a failed setup step without exposing stderr: %s", async (stderr, message) => {
    const fixture = await server(() => ({ code: 1, stderr: `${stderr}\nprivate-server-secret` }));
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    const client = await authenticateSetup(fixture.target, identity, { password: "test-only-password" }, signal);
    try {
      const error = await remoteCommand(client, "failed-step").catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("private");
    } finally { client.end(); }
  });

  it("cancels an authenticated connection and its active command", async () => {
    const fixture = await server(() => ({ hang: true }));
    const abort = new AbortController();
    const identity = await discoverHostIdentity(fixture.target, abort.signal);
    const client = await authenticateSetup(fixture.target, identity, { password: "test-only-password" }, abort.signal);
    const pending = remoteCommand(client, "hang");
    abort.abort();
    await expect(pending).rejects.toThrow(/disconnected/);
  });
});

describe("Linux setup scripts", () => {
  it("keeps shell arguments quoted and preserves existing password and firewall access", () => {
    const key = utils.generateKeyPairSync("ed25519").public;
    for (const admin of ["root", "sudo", "user"] as const) {
      const script = [inspectMachineScript, prepareUserScript("termloop-admin", admin, key), installNodeScript("termloop-admin", admin)].join("\n");
      expect(script).not.toMatch(/PasswordAuthentication|PermitRootLogin|ufw |passwd /);
      expect(serverUserCommand("termloop-admin", admin, "false\necho should-not-run")).toContain("set -eu");
    }
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(() => prepareUserScript("termloop-admin", "root", "ssh-ed25519 bad\ncommand")).toThrow();
  });
});


describe("OpenSSH configured identity paths", () => {
  const context = { home: "/Users/local person", localUser: "local", localUid: "501", localHost: "mac.example", host: "server.example", originalHost: "my-alias", user: "remote", port: 2222, hostKeyAlias: "pinned-host", jump: "", env: { KEY_DIR: "/keys with spaces" } };
  it("expands home, connection tokens and environment variables without shell expansion", () => {
    expect(expandSshPath("%d/.ssh/%n_%r_%p", context)).toBe("/Users/local person/.ssh/my-alias_remote_2222");
    expect(expandSshPath("~/.ssh/key", context)).toBe("/Users/local person/.ssh/key");
    expect(expandSshPath("${KEY_DIR}/%h-%%-%u-%i-%L-%l-%k-%j", context)).toBe("/keys with spaces/server.example-%-local-501-mac-mac.example-pinned-host-");
    expect(expandSshPath("%C", context)).toMatch(/^[a-f0-9]{40}$/);
    expect(expandSshPath("/keys/$(not-a-command)", context)).toBe("/keys/$(not-a-command)");
    expect(expandSshPath("${KEY_DIR}", { ...context, env: { KEY_DIR: "%d/unchanged" } })).toBe("%d/unchanged");
  });
  it("ignores paths with unavailable variables instead of opening a different key", () => {
    expect(expandSshPath("${MISSING}/key", context)).toBeUndefined();
    expect(expandSshPath("/key/%Z", context)).toBeUndefined();
    expect(() => expandSshPath("~another/.ssh/key", context)).toThrow(/absolute IdentityFile/);
  });
});


describe("SSH authentication choices", () => {
  it("resolves IdentityAgent variable syntax", () => {
    const env = { SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", CUSTOM_AGENT: "/custom/socket" };
    expect(resolveIdentityAgent("SSH_AUTH_SOCK", env)).toBe(env.SSH_AUTH_SOCK);
    expect(resolveIdentityAgent("$SSH_AUTH_SOCK", env)).toBe(env.SSH_AUTH_SOCK);
    expect(resolveIdentityAgent("$CUSTOM_AGENT", env)).toBe(env.CUSTOM_AGENT);
    expect(resolveIdentityAgent("$MISSING", env)).toBeUndefined();
  });

  it("restricts agent keys with IdentitiesOnly and prioritizes configured keys otherwise", async () => {
    const selected = utils.generateKeyPairSync("ed25519").public;
    const unrelated = utils.generateKeyPairSync("ed25519").public;
    const key = utils.parseKey(selected);
    if (key instanceof Error || Array.isArray(key)) throw new Error("Invalid fixture");
    for (const only of [true, false]) {
      const agent = ssh2.createAgent("/unused-test-agent");
      agent.getIdentities = (callback) => callback(null, [unrelated, selected]);
      const filtered = configuredAgent(agent, [key.getPublicSSH()], only);
      const result = await new Promise((resolve, reject) => filtered.getIdentities((error, keys) => error ? reject(error) : resolve(keys)));
      expect(result).toEqual(only ? [selected] : [selected, unrelated]);
    }
  });

  it("supports a PAM keyboard-interactive password prompt", async () => {
    const fixture = await server(undefined, "password");
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    const client = await authenticateSetup(fixture.target, identity, { password: "test-only-password" }, signal);
    expect(await remoteCommand(client, "true")).toBe("ok");
    client.end();
  });

  it("explains interactive MFA without submitting the password as a verification code", async () => {
    const fixture = await server(undefined, "mfa");
    const signal = new AbortController().signal;
    const identity = await discoverHostIdentity(fixture.target, signal);
    await expect(authenticateSetup(fixture.target, identity, { password: "test-only-password" }, signal)).rejects.toThrow(/interactive SSH verification/);
  });
});
