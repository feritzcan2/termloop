/** Only web destinations are opened from projected text. Preserve the exact URL. */
export function webUrl(value: string): string | undefined {
  const url = value.trim();
  if (!/^https?:\/\//i.test(url) || /[\s\u0000-\u001f\u007f]/u.test(url)) return undefined;
  try {
    return new URL(url).hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface WebLinkRange {
  start: number;
  end: number;
  url: string;
}

/** Keep punctuation outside links, including Markdown delimiters and prose brackets. */
export function webLinkRanges(text: string): WebLinkRange[] {
  const links: WebLinkRange[] = [];
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu)) {
    const start = match.index;
    if (start > 0 && /[\p{L}\p{N}_@]/u.test(text[start - 1]!)) continue;
    let label = match[0];
    while (label.length > 0) {
      if (/[.,!?;:]$/u.test(label)) { label = label.slice(0, -1); continue; }
      const closing = label.at(-1)!;
      const opening = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[closing];
      if (opening && label.split(closing).length > label.split(opening).length) {
        label = label.slice(0, -1);
        continue;
      }
      break;
    }
    const url = webUrl(/^www\./i.test(label) ? `https://${label}` : label);
    if (url) links.push({ start, end: start + label.length, url });
  }
  return links;
}
