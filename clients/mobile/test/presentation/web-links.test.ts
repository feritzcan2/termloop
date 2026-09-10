import { describe, expect, it } from "vitest";
import { webLinkRanges, webUrl } from "../../src/presentation/web-links";
import { taskJiraIssueKey } from "../../src/presentation/dto-readers";
import { terminalLinkSpans } from "../../src/presentation/terminal-links";
import { DEFAULT_TERMINAL_STYLE, TerminalScreenProjection } from "../../src/presentation/terminal-screen";

describe("web links in mobile output", () => {
  it("recognizes prose and Markdown destinations, preserving queries, fragments and balanced brackets", () => {
    const text = "See [issue](https://example.atlassian.net/browse/KAN-321?focusedCommentId=42#comment-42), (https://example.com/a_(b)). Also www.example.com/docs!";
    const links = webLinkRanges(text);
    expect(links.map((link) => link.url)).toEqual([
      "https://example.atlassian.net/browse/KAN-321?focusedCommentId=42#comment-42",
      "https://example.com/a_(b)", "https://www.example.com/docs",
    ]);
    expect(links.map((link) => text.slice(link.start, link.end))).toEqual([
      links[0]!.url, links[1]!.url, "www.example.com/docs",
    ]);
    expect(taskJiraIssueKey(links[0]!.url)).toBe("KAN-321");
    expect(taskJiraIssueKey("https://example.atlassian.net/browse/KAN-321/")).toBe("KAN-321");
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "termloop://force-update", "https://", "https://example.com/line\nbreak"])("does not open %s as a web destination", (value) => {
    expect(webUrl(value)).toBeUndefined();
  });

  it("retains IPv6 hosts and ignores email and word fragments", () => {
    expect(webLinkRanges("(http://[::1]:8080/path). test@www.example.com prefixhttps://example.com").map((link) => link.url))
      .toEqual(["http://[::1]:8080/path"]);
  });

  it("links the full address across color changes while preserving all characters and styles", () => {
    const blue = { ...DEFAULT_TERMINAL_STYLE, foreground: "blue", bold: true };
    const spans = [{ text: "See https://example.", style: DEFAULT_TERMINAL_STYLE }, { text: "com/docs, then continue.", style: blue }];
    const linked = terminalLinkSpans(spans);
    expect(linked.map((span) => span.text).join("")).toBe(spans.map((span) => span.text).join(""));
    expect(linked.filter((span) => span.url).map((span) => [span.text, span.url])).toEqual([
      ["https://example.", "https://example.com/docs"], ["com/docs", "https://example.com/docs"],
    ]);
    expect(linked.at(-1)).toMatchObject({ text: ", then continue.", style: blue });
    expect(linked.at(-1)?.url).toBeUndefined();
  });

  it.each(["\u0007", "\u001b\\"])("preserves OSC 8 labels across transport frames and SGR resets with terminator %j", (terminator) => {
    const projection = new TerminalScreenProjection();
    const encoder = new TextEncoder();
    projection.write(encoder.encode("\u001b]8;id=review;https://example.com/re"));
    const screen = projection.write(encoder.encode(`view${terminator}Open \u001b[1mreview\u001b[0m now\u001b]8;;${terminator} done`));
    const spans = terminalLinkSpans(screen!.lines[0]!.spans);
    expect(spans.map((span) => span.text).join("")).toBe("Open review now done");
    expect(spans.filter((span) => span.url).map((span) => span.text).join("")).toBe("Open review now");
    expect(spans.filter((span) => span.url).every((span) => span.url === "https://example.com/review")).toBe(true);
    expect(spans.at(-1)?.url).toBeUndefined();
    const cleared = projection.write(encoder.encode("\u001bcPlain"));
    expect(cleared!.lines[0]!.spans.every((span) => !span.style.hyperlink)).toBe(true);
  });

  it("does not retain stale link destinations after a redraw or turn non-web OSC links into app actions", () => {
    const projection = new TerminalScreenProjection();
    const encoder = new TextEncoder();
    projection.write(encoder.encode("\u001b]8;;https://example.com/old\u0007Label\u001b]8;;\u0007"));
    const updated = projection.write(encoder.encode("\u001b[1;1H\u001b]8;;https://example.com/new\u0007Label\u001b]8;;\u0007"));
    expect(updated!.lines[0]!.spans[0]!.style.hyperlink).toBe("https://example.com/new");
    const file = projection.write(encoder.encode("\u001b[1;1H\u001b]8;;file:///tmp/file\u0007Local\u001b]8;;\u0007"));
    expect(terminalLinkSpans(file!.lines[0]!.spans).every((span) => !span.url)).toBe(true);
  });
});
