import { describe, expect, it, vi } from "vitest";
import { withTerminalReconnect } from "../src/renderer/composition/terminal-reconnect.js";

function fixture() {
  const reconnect = vi.fn(async (_profileId: string) => {});
  const reattach = vi.fn();
  const base = { subscribe: vi.fn(), snapshot: vi.fn(), read: vi.fn(), recover: vi.fn() };
  const port = withTerminalReconnect(base, (id) => id === "missing" ? undefined : { connectionProfileId: id === "local-session" ? "local" : "remote" }, reconnect, reattach);
  return { port, base, reconnect, reattach };
}

describe("terminal force reconnect", () => {
  it.each(["local-session", "remote-session"])("routes by the terminal's computer and reattaches only that source: %s", async (id) => {
    const f = fixture();
    await f.port.reconnect!(id);
    const profile = id === "local-session" ? "local" : "remote";
    expect(f.reconnect).toHaveBeenCalledExactlyOnceWith(profile);
    expect(f.reattach).toHaveBeenCalledExactlyOnceWith(profile);
    expect(f.base.recover).not.toHaveBeenCalled();
  });

  it("shares an in-flight reset across terminals on the same computer", async () => {
    const f = fixture();
    let finish!: () => void;
    f.reconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.port.reconnect!("one");
    const second = f.port.reconnect!("two");
    await Promise.resolve();
    expect(f.reconnect).toHaveBeenCalledOnce();
    expect(f.reattach).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(f.reattach).toHaveBeenCalledOnce();
  });

  it("surfaces errors and permits a subsequent retry", async () => {
    const f = fixture();
    f.reconnect.mockRejectedValueOnce(new Error("Computer offline"));
    await expect(f.port.reconnect!("one")).rejects.toThrow("Computer offline");
    expect(f.reattach).not.toHaveBeenCalled();
    await f.port.reconnect!("one");
    expect(f.reconnect).toHaveBeenCalledTimes(2);
    expect(f.reattach).toHaveBeenCalledOnce();
  });

  it("never resets the local computer for an unknown session", async () => {
    const f = fixture();
    await expect(f.port.reconnect!("missing")).rejects.toThrow("no longer available");
    expect(f.reconnect).not.toHaveBeenCalled();
  });
});
