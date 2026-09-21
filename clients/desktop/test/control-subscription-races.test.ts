import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createControlSocket } from "../src/main/access-websocket.js";
import { ControlSubscription } from "../src/main/control-subscription.js";
import type { DesktopConnectionConfig } from "../src/main/connection-profiles.js";

vi.mock("../src/main/access-websocket.js", () => ({ createControlSocket: vi.fn() }));

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn((raw: string) => {
    const { id } = JSON.parse(raw);
    this.emit("message", Buffer.from(JSON.stringify({ id, ok: true, result: { stateRevision: 1, observationSequence: 0 } })));
  });
  close = vi.fn(() => { this.readyState = 3; this.emit("close"); });
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

it.each(["restart", "reconnect", "stop"])("ignores a pending connection failure after %s", async (action) => {
  let rejectOld!: (error: Error) => void;
  const old = new Promise<DesktopConnectionConfig>((_resolve, reject) => { rejectOld = reject; });
  const resolve = vi.fn<() => Promise<DesktopConnectionConfig | undefined>>()
    .mockReturnValueOnce(old).mockResolvedValue({ kind: "local", controlUrl: "ws://fixture/control", terminalUrl: "ws://fixture/terminal", token: "fixture", terminalToken: "fixture" });
  const states: string[] = [];
  const socket = new Socket();
  vi.mocked(createControlSocket).mockReturnValue(socket as unknown as ReturnType<typeof createControlSocket>);
  const subscription = new ControlSubscription(() => {}, undefined, resolve, (state) => states.push(state));
  try {
    subscription.start();
    if (action === "reconnect") subscription.reconnect();
    else {
      subscription.stop();
      if (action === "restart") subscription.start();
    }
    await vi.advanceTimersByTimeAsync(0);
    if (action !== "stop") {
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toBe("connected");
    }
    const before = [...states];
    rejectOld(new Error("Late SSH failure"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(states).toEqual(before);
    expect(resolve).toHaveBeenCalledTimes(action === "stop" ? 1 : 2);
    expect(socket.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { subscription.stop(); }
});
