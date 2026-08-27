import http from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import {
  encodeTerminalFrame,
  notificationPreview,
  readTerminalNotificationPreview,
} from "../scripts/mobile-access-terminal-preview.mjs";

const esc = String.fromCharCode(0x1b);
const sessionId = "11111111-2222-4333-8444-555555555555";

describe("mobile terminal notification preview", () => {
  it("extracts the latest question from styled redraw output", () => {
    const preview = notificationPreview([Buffer.from(
      `${esc}[2J${esc}[1;1HWorking${esc}[K\r\nI updated the reconnect path.${esc}[35m\r\nShould I add the retry test?${esc}[0m`,
    )], "needsInput");
    expect(preview).toBe("Should I add the retry test?");
  });

  it("bounds content and redacts obvious credential shapes", () => {
    const secret = `sk-${"a".repeat(48)}`;
    const preview = notificationPreview([
      Buffer.from(`Finished the change with ${secret}. ${"result ".repeat(100)}`),
    ], "needsReview");
    expect(preview).toContain("[secret]");
    expect(preview).not.toContain(secret);
    expect(preview.length).toBeLessThanOrEqual(420);
  });

  it("attaches briefly and reads bounded replay from the real binary framing shape", async () => {
    const server = http.createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => {
      let authenticated = false;
      socket.on("message", (data) => {
        if (!authenticated) {
          authenticated = true;
          expect(data.toString()).toBe(`TL01${"t".repeat(64)}`);
          socket.send(Buffer.from("TLOK"));
          return;
        }
        socket.send(encodeTerminalFrame(
          sessionId,
          17,
          1n,
          6,
          Buffer.from(`${esc}[1;1HCan you confirm the release?`),
        ));
      });
    });
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    try {
      const preview = await readTerminalNotificationPreview({
        terminalUrl: `ws://127.0.0.1:${port}/terminal`,
        terminalToken: "t".repeat(64),
      }, {
        kind: "needsInput",
        sessionId,
        runtimeEpoch: 17,
      });
      expect(preview).toBe("Can you confirm the release?");
    } finally {
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
