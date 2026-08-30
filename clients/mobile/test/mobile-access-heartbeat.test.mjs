import { describe, expect, it, vi } from "vitest";

import {
  sweepWebSocketHeartbeats,
  trackWebSocketHeartbeat,
} from "../scripts/mobile-access-heartbeat.mjs";

describe("mobile access downstream heartbeat", () => {
  it("terminates a silent socket after one missed pong and retains a responsive one", () => {
    const silent = fakeSocket();
    const responsive = fakeSocket();
    const timedOut = [];
    trackWebSocketHeartbeat(silent, { connectionId: 1, channel: "terminal" });
    trackWebSocketHeartbeat(responsive, { connectionId: 2, channel: "control" });
    const sockets = new Set([silent, responsive]);

    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    responsive.pong();
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));

    expect(silent.ping).toHaveBeenCalledTimes(1);
    expect(silent.terminate).toHaveBeenCalledTimes(1);
    expect(responsive.ping).toHaveBeenCalledTimes(2);
    expect(responsive.terminate).not.toHaveBeenCalled();
    expect(timedOut).toEqual([{ connectionId: 1, channel: "terminal" }]);
  });
});

function fakeSocket() {
  let onPong = () => {};
  return {
    on(event, listener) {
      if (event === "pong") onPong = listener;
    },
    pong() { onPong(); },
    ping: vi.fn(),
    terminate: vi.fn(),
  };
}
