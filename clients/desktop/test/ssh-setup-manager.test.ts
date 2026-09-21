import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import { SshSetupManager } from "../src/platform/ssh-setup.js";
import * as connection from "../src/platform/ssh-setup-connection.js";
import { ConnectionProfileLifecycle } from "../src/main/connection-profile-lifecycle.js";

vi.mock("../src/platform/ssh-setup-connection.js", () => ({
  resolveSetupTarget: vi.fn(), discoverHostIdentity: vi.fn(), authenticateSetup: vi.fn(), createManagedIdentity: vi.fn(), remoteCommand: vi.fn(),
}));

const target = { host: "server.example", user: "root", port: 22, name: "New server", identityFiles: [] };
const fingerprint = "SHA256:test-fingerprint";
const client = { end: vi.fn(), destroy: vi.fn() };
let manager: SshSetupManager;
let machine: string;
let protocol: string;

beforeEach(() => {
  vi.clearAllMocks();
  machine = "Linux\nx86_64\n0\nroot\nsystemd\napt\nroot\n104857600\n";
  protocol = CONTRACT_IDENTITY;
  manager = new SshSetupManager("/tmp/ssh-setup-manager-fixture", path.resolve("../../tools/server"), "2.0.4");
  vi.mocked(connection.resolveSetupTarget).mockResolvedValue(target);
  vi.mocked(connection.discoverHostIdentity).mockResolvedValue({ fingerprint, key: Buffer.from("fixture-host-key") });
  vi.mocked(connection.authenticateSetup).mockResolvedValue(client as never);
  vi.mocked(connection.createManagedIdentity).mockResolvedValue({ identityFile: "/tmp/fixture-key", knownHostsFile: "/tmp/fixture-known-hosts", publicKey: "ssh-ed25519 AAAA" });
  vi.mocked(connection.remoteCommand).mockImplementation(async (_client, command) => {
    if (command.includes("uname -s")) return machine;
    if (command.includes("echo installed")) return "missing\nstopped\nno-linger\n";
    if (command.includes("termloop-server-manager.mjs") && command.includes(" install ")) return "";
    if (command.includes("termloopctl\" version")) return JSON.stringify({ product: "TermLoop", version: "2.0.4", protocolVersion: protocol });
    if (command.includes("access-enable")) return JSON.stringify({ enabled: true, listening: true, port: 43717, server_fingerprint: `sha256:${"a".repeat(64)}` });
    return "";
  });
});
afterEach(() => manager.cancelOwner(1));

async function readyForInstall() {
  const state = await manager.start(1, { address: "ssh root@server.example" });
  return manager.login(1, { id: state.id, fingerprint, password: "fixture-password" });
}

describe("SSH setup orchestration", () => {
  it("requires exact host approval, ownership, authenticated inspection and install intent", async () => {
    const state = await manager.start(1, { address: "server.example" });
    expect(() => manager.status(2, state.id)).toThrow(/ended/);
    expect(() => manager.install(1, state.id)).toThrow(/Review/);
    await expect(manager.login(1, { id: state.id, fingerprint: "wrong", password: "secret" })).rejects.toThrow(/Confirm/);
    expect(connection.authenticateSetup).not.toHaveBeenCalled();
    expect(connection.remoteCommand).not.toHaveBeenCalled();
    const reviewed = await manager.login(1, { id: state.id, fingerprint });
    expect(reviewed.phase).toBe("review");
    expect(connection.createManagedIdentity).not.toHaveBeenCalled();
    expect(JSON.stringify(reviewed)).not.toContain("password");
    expect(() => manager.connectionInput(1, state.id)).toThrow(/verification/);
  });

  it("sets up a non-root owner, verifies a separate key login, then checks protocol and sharing", async () => {
    const reviewed = await readyForInstall();
    expect(manager.install(1, reviewed.id).phase).toBe("installing");
    await vi.waitFor(() => expect(manager.status(1, reviewed.id).phase).toBe("ready"));
    const input = manager.connectionInput(1, reviewed.id);
    expect(input.transport).toMatchObject({ host: "server.example", user: "termloop-admin", sshPort: 22, remotePort: 43717, managedIdentity: reviewed.id });
    expect(connection.authenticateSetup).toHaveBeenNthCalledWith(2, expect.objectContaining({ user: "termloop-admin" }), expect.anything(), {}, expect.any(AbortSignal), expect.anything());
    expect(input.expectedServerFingerprint).toBe(`sha256:${"a".repeat(64)}`);
    expect(JSON.stringify(manager.status(1, reviewed.id))).not.toContain("fixture-password");
  });

  it("does not make a mismatched server connectable", async () => {
    protocol = `sha256:${"b".repeat(64)}`;
    const reviewed = await readyForInstall();
    manager.install(1, reviewed.id);
    await vi.waitFor(() => expect(manager.status(1, reviewed.id).phase).toBe("error"));
    expect(manager.status(1, reviewed.id).message).toContain("not compatible");
    expect(() => manager.connectionInput(1, reviewed.id)).toThrow(/verification/);
    expect(vi.mocked(connection.remoteCommand).mock.calls.some(([, command]) => command.includes("access-enable"))).toBe(false);
  });

  it("keeps login retryable and discards old inspection after authentication fails", async () => {
    const state = await manager.start(1, { address: "server.example" });
    vi.mocked(connection.authenticateSetup).mockRejectedValueOnce(new Error("SSH sign-in failed."));
    const failed = await manager.login(1, { id: state.id, fingerprint });
    expect(failed.phase).toBe("login");
    expect(() => manager.install(1, state.id)).toThrow(/Review/);
    expect((await manager.login(1, { id: state.id, fingerprint })).phase).toBe("review");
  });

  it.each([
    ["Darwin\narm64\n501\nuser\nunsupported\nother\nuser\n104857600", "Linux x64"],
    ["Linux\nx86_64\n1000\nuser\nsystemd\napt\nuser\n104857600", "administrator access"],
    ["Linux\nx86_64\n0\nroot\nsystemd\napt\nroot\n10", "2 GiB"],
  ])("blocks unsupported prerequisites before changes", async (output, message) => {
    machine = output;
    const result = await readyForInstall();
    expect(result.phase).toBe("error");
    expect(result.message).toContain(message);
    expect(() => manager.install(1, result.id)).toThrow(/Review/);
    await expect(manager.selectArchive(1, result.id, "/tmp/package.tar.gz")).rejects.toThrow(/checking/);
    expect(connection.createManagedIdentity).not.toHaveBeenCalled();
  });

  it("cancels a superseded setup and invalidates its authority", async () => {
    const old = await readyForInstall();
    const next = await manager.start(1, { address: "another.example" });
    expect(next.id).not.toBe(old.id);
    expect(client.destroy).toHaveBeenCalled();
    expect(() => manager.status(1, old.id)).toThrow(/ended/);
    expect(() => manager.install(1, old.id)).toThrow(/ended/);
  });

  it("retains owner-scoped progress and refuses to replace an active installation", async () => {
    expect(manager.current(1)).toBeNull();
    const reviewed = await readyForInstall();
    expect(manager.current(1)?.id).toBe(reviewed.id);
    expect(manager.current(2)).toBeNull();
    manager.install(1, reviewed.id);
    await expect(manager.start(1, { address: "another.example" })).rejects.toThrow(/already running/);
    expect(manager.current(1)?.id).toBe(reviewed.id);
    await vi.waitFor(() => expect(manager.current(1)?.phase).toBe("ready"));
  });

  it("rejects a non-apt host even when TermLoop is already installed", async () => {
    machine = "Linux\nx86_64\n0\nroot\nsystemd\nother\nroot\n104857600";
    const original = vi.mocked(connection.remoteCommand).getMockImplementation()!;
    vi.mocked(connection.remoteCommand).mockImplementation(async (client, command, options) => command.includes("echo installed") ? "installed\nrunning\nlinger" : original(client, command, options));
    const result = await readyForInstall();
    expect(result.installed).toBe(true);
    expect(result.phase).toBe("error");
    expect(result.message).toContain("Debian and Ubuntu");
    expect(connection.createManagedIdentity).not.toHaveBeenCalled();
  });

  it("does not duplicate a saved profile if final connectivity verification needs a retry", async () => {
    const reviewed = await readyForInstall();
    manager.install(1, reviewed.id);
    await vi.waitFor(() => expect(manager.status(1, reviewed.id).phase).toBe("ready"));
    const result = { profile: { id: "profile-id", name: "New server", transport: "ssh" as const, scope: "full" as const, endpoint: "server", enabled: true, persistence: "encrypted" as const } };
    const save = vi.fn(async () => result);
    const verify = vi.fn().mockRejectedValueOnce(new Error("Temporary connection failure")).mockResolvedValue(undefined);
    await expect(manager.connect(1, reviewed.id, save, verify)).rejects.toThrow(/Temporary/);
    await expect(manager.connect(1, reviewed.id, save, verify)).resolves.toEqual(result);
    expect(save).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(manager.current(1)).toBeNull();
  });

  it("retains a saved profile across registry refresh failure and repeated connection retries", async () => {
    const reviewed = await readyForInstall();
    manager.install(1, reviewed.id);
    await vi.waitFor(() => expect(manager.status(1, reviewed.id).phase).toBe("ready"));
    let enrolled = 0;
    const profiles = {
      connect: vi.fn(async () => ({ profile: { id: `profile-${++enrolled}`, name: "SSH", transport: "ssh" as const, scope: "full" as const, endpoint: "fixture", enabled: true, persistence: "encrypted" as const } })),
      setEnabled: vi.fn(), remove: vi.fn(),
    };
    const resources = { stopProfile: vi.fn() };
    const lifecycle = new ConnectionProfileLifecycle(profiles, { ...resources, summaries: vi.fn().mockRejectedValue(new Error("Refresh failed")) }, resources, resources);
    const save = lifecycle.connect.bind(lifecycle);
    const verify = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    for (let attempt = 0; attempt < 2; attempt++) await expect(manager.connect(1, reviewed.id, save, verify)).rejects.toThrow("Offline");
    await expect(manager.connect(1, reviewed.id, save, verify)).resolves.toMatchObject({ profile: { id: "profile-1" } });
    expect(profiles.connect).toHaveBeenCalledOnce();
    expect(verify.mock.calls).toEqual([["profile-1"], ["profile-1"], ["profile-1"]]);
    expect(manager.current(1)).toBeNull();
  });
});
