import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationHistory } from "../src/renderer/ui/ConversationHistory.js";
import { TerminalStatus } from "../src/renderer/ui/TerminalStatus.js";
import type { ConversationPort, TerminalPresentationPort } from "../src/renderer/terminal-presentation.js";

const conversation: ConversationPort = { supported: () => true, subscribe: () => () => {}, snapshot: () => undefined,
  open: vi.fn(), close: vi.fn(), older: vi.fn(), newer: vi.fn(), retry: vi.fn() };

describe("saved message presentation", () => {
  it("offers saved messages in an ordinary live agent terminal", () => {
    const port: TerminalPresentationPort = { subscribe: () => () => {}, snapshot: () => ({ phase: "live" }), read: vi.fn(), recover: vi.fn(), conversation };
    const markup = renderToStaticMarkup(createElement(TerminalStatus, { sessionId: "s", port }));
    expect(markup).toContain("Earlier messages");
    expect(markup).toContain("no longer in terminal scrollback");
  });

  it("renders full multiline messages as inert text with explicit pagination and limits", () => {
    const markup = renderToStaticMarkup(createElement(ConversationHistory, { sessionId: "s", port: conversation, state: {
      loading: false, hasNewer: true, page: { status: "available", next_before: 50, incomplete: true,
        messages: [{ role: "assistant", text: "## Heading\n\n<script>never execute</script>\nLast paragraph", truncated: true }] },
    } }));
    expect(markup).toContain("## Heading\n\n&lt;script&gt;");
    expect(markup).toContain("Last paragraph");
    expect(markup).toContain("Some records could not be read completely");
    expect(markup).toContain("This long message is shortened");
    expect(markup).toContain("Older messages");
    expect(markup).toContain("Newer messages");
    expect(markup).toContain("Return to terminal");
  });
});
