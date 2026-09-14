import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), connect: vi.fn(), createServer: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock("node:net", () => ({ default: { connect: mocks.connect, createServer: mocks.createServer } }));

class SshChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn(() => true);
  exit(stderr: string, close = true) {
    this.stderr.write(stderr);
    this.exitCode = 255;
    this.emit("exit", 255, null);
    if (close) this.emit("close", 255, null);
  }
}

const request = { host: "review.example", remotePort: 43717 };
let children: SshChild[];
let sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  children = [];
  sockets = [];
  let port = 40000;
  mocks.createServer.mockImplementation(() => {
    const listener = Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: ++port }),
      close: (done: () => void) => done(),
    });
    return listener;
  });
  mocks.connect.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    sockets.push(socket);
    queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
    return socket;
  });
  mocks.execFile.mockImplementation((_program, _args, _options, done) => done(null, "", ""));
  mocks.spawn.mockImplementation(() => {
    const child = new SshChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
});

async function launch() {
  const { spawnSshTunnel } = await import("../src/platform/ssh-runtime.js");
  const outcome = spawnSshTunnel(request).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  return { outcome, spawnSshTunnel };
}

describe("SSH runtime failures and ownership", () => {
  it.each([
    ["Permission denied (publickey).", "sshAuthenticationFailed"],
    ["Too many authentication failures", "sshAuthenticationFailed"],
    ["Could not resolve hostname review.example: ad veya servis bilinmiyor", "sshHostUnresolved"],
    ["No ED25519 host key is known for review.example and you have requested strict checking.\nHost key verification failed.", "sshHostKeyUnknown"],
    ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nOffending ECDSA key in /private/known_hosts:12\nHost key verification failed.", "sshHostKeyMismatch"],
    ["Host key verification failed.", "sshHostKeyRejected"],
    ["unexpected failure: private-user@private-host with secret detail", "sshForwardFailed"],
  ])("classifies %s without disclosing subprocess output", async (stderr, code) => {
    const { outcome } = await launch();
    children[0]!.exit(stderr);
    const error = await outcome as Error & { code: string };
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(stderr);
    expect(error.message).not.toMatch(/private-user|private-host|known_hosts:12/);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(children[0]!.kill).toHaveBeenCalledOnce();
  });

  it("reads stderr delivered after exit before classifying the failure", async () => {
    const { outcome } = await launch();
    children[0]!.exit("", false);
    await vi.advanceTimersByTimeAsync(100);
    children[0]!.stderr.write("No ED25519 host key is known for review.example and you have requested strict checking.\nHost key verification failed.");
    children[0]!.emit("close", 255, null);
    await expect(outcome).resolves.toMatchObject({ code: "sshHostKeyUnknown" });
    expect(children[0]!.listenerCount("close")).toBe(0);
  });

  it("bounds readiness even if a loopback probe never emits an event", async () => {
    mocks.connect.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      sockets.push(socket);
      return socket;
    });
    const { outcome } = await launch();
    await vi.advanceTimersByTimeAsync(10_250);
    await expect(outcome).resolves.toMatchObject({ code: "sshReadinessTimedOut" });
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    expect(sockets[0]!.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the wait for final stderr when a descendant keeps the stream open", async () => {
    const { outcome } = await launch();
    children[0]!.exit("Permission denied (publickey).", false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(outcome).resolves.toMatchObject({ code: "sshAuthenticationFailed" });
    expect(children[0]!.listenerCount("close")).toBe(0);
  });

  it("retries local bind failures on new ports, with a three-attempt bound", async () => {
    const { outcome } = await launch();
    for (let index = 0; index < 3; index++) {
      children[index]!.exit("bind 127.0.0.1: Address already in use");
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(outcome).resolves.toMatchObject({ code: "sshForwardFailed" });
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    const forwards = mocks.spawn.mock.calls.map(([, args]) => args[args.indexOf("-L") + 1]);
    expect(new Set(forwards).size).toBe(3);
    expect(mocks.execFile).toHaveBeenCalledOnce();
  });

  it("does not retry an authentication failure that also mentions a bind failure", async () => {
    const { outcome } = await launch();
    children[0]!.exit("Address already in use\nPermission denied (publickey).");
    await expect(outcome).resolves.toMatchObject({ code: "sshAuthenticationFailed" });
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("does not pass the foreground option to older OpenSSH, and caches the probe", async () => {
    mocks.execFile.mockImplementation((_program, _args, _options, done) => done(
      new Error("exit 255"), "", "command-line: line 0: Bad configuration option: forkafterauthentication",
    ));
    const { outcome, spawnSshTunnel } = await launch();
    children[0]!.exit("unavailable");
    await outcome;
    const second = spawnSshTunnel(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    children[1]!.exit("unavailable");
    await second;
    expect(mocks.execFile).toHaveBeenCalledOnce();
    for (const [, args] of mocks.spawn.mock.calls) {
      expect(args).not.toContain("ForkAfterAuthentication=no");
      expect(args).toContain("ControlPath=none");
    }
    const probe = mocks.execFile.mock.calls[0]!;
    expect(probe[1]).toContain("-G");
    expect(probe[1]).toContain("-F");
    expect(probe[2]).toMatchObject({ timeout: 2000, windowsHide: true });
  });

  it("keeps supported SSH in the foreground and reports exit once", async () => {
    mocks.connect.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    });
    const { outcome } = await launch();
    const tunnel = await outcome as { onExit(listener: () => void): void; stop(): void };
    const exited = vi.fn();
    tunnel.onExit(exited);
    expect(mocks.spawn.mock.calls[0]![1]).toContain("ForkAfterAuthentication=no");
    expect(mocks.spawn.mock.calls[0]![1]).toContain("ControlPath=none");
    expect(vi.getTimerCount()).toBe(0);
    tunnel.stop();
    expect(children[0]!.kill).toHaveBeenCalledOnce();
    children[0]!.emit("error", new Error("post-spawn failure"));
    children[0]!.exit("closed");
    expect(exited).toHaveBeenCalledOnce();
  });

  it("reports a missing SSH client and allows retry after it becomes available", async () => {
    mocks.execFile.mockImplementationOnce((_program, _args, _options, done) => done(
      Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }), "", "",
    ));
    const { outcome, spawnSshTunnel } = await launch();
    await expect(outcome).resolves.toMatchObject({ code: "sshUnavailable" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    const second = spawnSshTunnel(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    children[0]!.exit("other failure");
    await second;
  });

  it("does not fall back to a potentially backgrounded tunnel after a probe timeout", async () => {
    mocks.execFile.mockImplementationOnce((_program, _args, _options, done) => done(
      new Error("probe timeout"), "", "",
    ));
    const { outcome } = await launch();
    await expect(outcome).resolves.toMatchObject({ code: "sshForwardFailed" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
