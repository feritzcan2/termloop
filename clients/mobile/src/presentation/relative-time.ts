/// Age, in the narrowest form a row can afford. `now` is a parameter rather than a
/// call to the clock so the formatter stays pure and testable, and so a whole
/// screen renders against one instant instead of drifting mid-list.
///
/// Deliberately coarse: a row states how stale a fact is, not when it happened.
/// The exact instant is never the question a glance is asking.
export function relativeAge(epochMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - epochMs) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/// The same fact in a sentence, for accessible names and for the connection card
/// where a bare token would read as a code.
export function relativeAgeSentence(epochMs: number | null, nowMs: number): string {
  if (epochMs === null) return "never connected";
  const age = relativeAge(epochMs, nowMs);
  return age === "now" ? "just now" : `${age} ago`;
}
