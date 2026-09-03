import { describe, expect, it, vi } from "vitest";

import {
  configureWebSocketHeartbeat,
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

  it("uses an application probe for React Native and accepts any reply as liveness", () => {
    const phone = fakeSocket();
    const probe = vi.fn();
    const timedOut = [];
    trackWebSocketHeartbeat(phone, { connectionId: 3, channel: "mobile" }, { probe });
    const sockets = new Set([phone]);

    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    phone.message();
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));

    expect(probe).toHaveBeenCalledTimes(2);
    expect(phone.ping).not.toHaveBeenCalled();
    expect(phone.terminate).toHaveBeenCalledTimes(1);
    expect(timedOut).toEqual([{ connectionId: 3, channel: "mobile" }]);
  });

  it("does not disconnect an older React Native client until it negotiates application probes", () => {
    const phone = fakeSocket();
    const timedOut = [];
    trackWebSocketHeartbeat(phone, { connectionId: 4, channel: "mobile" }, { enforceTimeout: false });
    const sockets = new Set([phone]);

    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    expect(phone.terminate).not.toHaveBeenCalled();

    configureWebSocketHeartbeat(phone, { enforceTimeout: true, probe: phone.ping });
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));
    sweepWebSocketHeartbeats(sockets, (context) => timedOut.push(context));

    expect(phone.terminate).toHaveBeenCalledTimes(1);
    expect(timedOut).toEqual([{ connectionId: 4, channel: "mobile" }]);
  });
});

function fakeSocket() {
  let onPong = () => {};
  let onMessage = () => {};
  return {
    on(event, listener) {
      if (event === "pong") onPong = listener;
      if (event === "message") onMessage = listener;
    },
    pong() { onPong(); },
    message() { onMessage(); },
    ping: vi.fn(),
    terminate: vi.fn(),
  };
}
