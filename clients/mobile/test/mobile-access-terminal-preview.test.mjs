import http from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import {
  encodeTerminalFrame,
  notificationPreview,
  readTerminalNotificationPreview,
  terminalNotificationDetails,
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

  it("drops agent footer and status-line chrome below the answer", () => {
    const preview = notificationPreview([Buffer.from([
      "I finished the reconnect fix.",
      "ctx █▒▒▒▒▒▒▒▒▒▒ 10% (100k/1.0M) · 5h",
      "10% (2h15m) · wk 62% (10h35m)",
      "· $7.14 · v2.1.322 · 🕚 11:24",
      "▶▶ auto mode on (shift+tab to cycle) · PR #182",
    ].join("\r\n"))], "needsReview");
    expect(preview).toBe("I finished the reconnect fix.");
  });

  it("recognizes a provider approval dialog and keeps what is being approved", () => {
    const details = terminalNotificationDetails([Buffer.from([
      "I will push the branch now.",
      "Bash command",
      "git push origin develop",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "2. No, and tell Claude what to do differently (esc)",
    ].join("\r\n"))], "needsInput");
    expect(details).toEqual({
      preview: "Bash command\ngit push origin develop\nDo you want to proceed?",
      permissionPrompt: true,
    });
    const codex = terminalNotificationDetails([Buffer.from(
      "Would you like to run the following command?\r\n$ pnpm test\r\n› 1. Yes, proceed",
    )], "needsInput");
    expect(codex.permissionPrompt).toBe(true);
  });

  it("ignores an approval question that scrolled far above the current screen", () => {
    const lines = ["Do you want to proceed?", ...Array.from({ length: 20 }, (_, index) => `step ${index} done`), "Which branch should I use?"];
    const details = terminalNotificationDetails([Buffer.from(lines.join("\r\n"))], "needsInput");
    expect(details).toEqual({ preview: "Which branch should I use?", permissionPrompt: false });
    expect(terminalNotificationDetails([Buffer.from("Do you want to proceed?")], "needsReview").permissionPrompt).toBe(false);
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
      expect(preview).toEqual({ preview: "Can you confirm the release?", permissionPrompt: false });
    } finally {
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
