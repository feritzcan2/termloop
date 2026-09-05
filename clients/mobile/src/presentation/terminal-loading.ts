/// Terminal attachment has no byte total, so it cannot expose real download progress.
/// Advance quickly at first, then stop short of completion until output actually
/// arrives. Reaching 100 therefore always means the terminal has content to reveal.
export function nextTerminalLoadingProgress(current: number, hasContent: boolean): number {
  if (hasContent) return 100;
  if (current < 70) return Math.min(70, current + 4);
  if (current < 90) return Math.min(90, current + 2);
  if (current < 98) return current + 1;
  return 98;
}
