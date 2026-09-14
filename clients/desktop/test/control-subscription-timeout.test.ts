import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { remoteConnectionFailureMessage } from "../src/main/access-websocket.js";
import type { DesktopConnectionConfig } from "../src/main/connection-profiles.js";
import { ControlSubscription } from "../src/main/control-subscription.js";

async function unresponsiveServer(kind: "local" | "remote") {
  const sockets: Array<{ destroyed: boolean; destroy(): unknown }> = [];
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0,
    // Accept TCP and the HTTP request, but deliberately never approve the upgrade.
    verifyClient(info, _accept) {
      sockets.push(info.req.socket);
      info.req.socket.on("error", () => {});
      // An unfinished HTTP upgrade has no WebSocket to finish the server's half-close.
      info.req.socket.on("end", () => info.req.socket.end());
      info.req.socket.resume();
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const port = address.port;
  const base = {
    controlUrl: `ws://127.0.0.1:${port}/control`,
    terminalUrl: "ws://127.0.0.1:1/terminal",
    token: "test-token",
    terminalToken: "test-token",
  };
  const config: DesktopConnectionConfig = kind === "local" ? { kind, ...base } : {
    kind, ...base, profileId: `timeout-${port}`,
    credential: { deviceId: "a".repeat(32), privateKey: {}, serverFingerprint: `sha256:${"b".repeat(64)}` },
  };
  const states: Array<{ state: string; message: string | undefined }> = [];
  const subscription = new ControlSubscription(
    () => {}, undefined, async () => config,
    (state, message) => states.push({ state, message }),
  );
  return {
    sockets, config, states, subscription,
    async close() {
      subscription.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("ControlSubscription opening deadline", () => {
  it.concurrent.each(["local", "remote"] as const)("retries an unanswered %s WebSocket upgrade and cleans up on stop", async (kind) => {
    const fixture = await unresponsiveServer(kind);
    try {
      fixture.subscription.start();
      await waitUntil(() => fixture.sockets.length >= 2, 13_000);
      expect(fixture.states).toContainEqual({ state: "offline", message: expect.stringMatching(/timed out/i) });
      if (fixture.config.kind === "remote") {
        expect(remoteConnectionFailureMessage(fixture.config.profileId))
          .toBe("TermLoop server did not respond before the connection timed out");
      }
      fixture.subscription.stop();
      await waitUntil(() => fixture.sockets.every((socket) => socket.destroyed));
      const count = fixture.sockets.length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fixture.sockets).toHaveLength(count);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it.each(["local", "remote"] as const)("discards the pending %s upgrade when the user reconnects", async (kind) => {
    const fixture = await unresponsiveServer(kind);
    try {
      fixture.subscription.start();
      await waitUntil(() => fixture.sockets.length === 1);
      fixture.subscription.reconnect();
      await waitUntil(() => fixture.sockets.length === 2 && fixture.sockets[0]!.destroyed);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fixture.sockets).toHaveLength(2);
      expect(fixture.states.map(({ state }) => state)).toEqual(["connecting", "connecting"]);
    } finally {
      await fixture.close();
    }
  });
});

async function waitUntil(probe: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("subscription did not recover or release its socket");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
