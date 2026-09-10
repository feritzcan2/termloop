import type { TerminalSpan } from "./terminal-screen";
import { webLinkRanges, webUrl } from "./web-links";

export interface LinkedTerminalSpan extends TerminalSpan {
  readonly url?: string;
}

/** Match across ANSI color boundaries without changing any rendered characters. */
export function terminalLinkSpans(spans: readonly TerminalSpan[]): LinkedTerminalSpan[] {
  const ranges = webLinkRanges(spans.map((span) => span.text).join(""));
  const result: LinkedTerminalSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const end = offset + span.text.length;
    const explicit = span.style.hyperlink && webUrl(span.style.hyperlink);
    if (explicit) {
      result.push({ ...span, url: explicit });
    } else {
      let position = offset;
      for (const range of ranges) {
        if (range.end <= offset || range.start >= end) continue;
        const start = Math.max(offset, range.start);
        const stop = Math.min(end, range.end);
        if (position < start) result.push({ text: span.text.slice(position - offset, start - offset), style: span.style });
        result.push({ text: span.text.slice(start - offset, stop - offset), style: span.style, url: range.url });
        position = stop;
      }
      if (position < end) result.push({ text: span.text.slice(position - offset), style: span.style });
    }
    offset = end;
  }
  return result;
}
