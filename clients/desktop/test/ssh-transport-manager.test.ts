import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../src/platform/ssh-runtime.js", () => ({ spawnSshTunnel: mocks.spawn }));
import { SshTransportManager } from "../src/main/transports/ssh.js";

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
const request = { host: "server.example", remotePort: 43717 };

describe("SSH transport ownership", () => {
  it("shares setup and replaces an exited tunnel only after backoff", async () => {
    vi.useFakeTimers();
    let exit!: () => void;
    const first = { localPort: 40001, onExit: (listener: () => void) => { exit = listener; }, stop: vi.fn() };
    const second = { localPort: 40002, onExit() {}, stop: vi.fn() };
    mocks.spawn.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new SshTransportManager();
    try {
      expect(await Promise.all([manager.baseUrl("profile", request), manager.baseUrl("profile", request)]))
        .toEqual(["ws://127.0.0.1:40001", "ws://127.0.0.1:40001"]);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      exit();
      await expect(manager.baseUrl("profile", request)).rejects.toThrow("reconnecting");
      await vi.advanceTimersByTimeAsync(1000);
      await expect(manager.baseUrl("profile", request)).resolves.toBe("ws://127.0.0.1:40002");
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
    } finally {
      manager.stop();
    }
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it.each(["remove", "stop"] as const)("closes late setup after %s instead of retaining it", async (action) => {
    let finish!: (tunnel: unknown) => void;
    mocks.spawn.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const manager = new SshTransportManager();
    const pending = manager.baseUrl("profile", request).catch((error: unknown) => error);
    if (action === "remove") manager.remove("profile");
    else manager.stop();
    const tunnel = { localPort: 40001, onExit: vi.fn(), stop: vi.fn() };
    finish(tunnel);
    await expect(pending).resolves.toMatchObject({ message: "SSH tunnel request was superseded" });
    expect(tunnel.stop).toHaveBeenCalledOnce();
    expect(tunnel.onExit).not.toHaveBeenCalled();
  });
});
