/**
 * Humanize a unix timestamp (seconds OR milliseconds) or Date as
 * "{nowLabel} / Nm / Nh / Nd / locale date". Returns null for non-finite input.
 */
export function relativeTime(
  value: number | Date | null | undefined,
  nowLabel = "just now"
): string | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else {
    return null;
  }
  if (!Number.isFinite(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return nowLabel;
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
