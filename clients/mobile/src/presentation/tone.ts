/// The mobile client's single tone vocabulary.
///
/// This is a literal port of the desktop's `clients/desktop/src/renderer/row-tone.ts`.
/// A shared package is deliberately unavailable — clients may import only the
/// generated contract, and `common/`/`shared/`/`utils/` do not exist — so the port
/// has to be exact and guarded by a parity test rather than by a build dependency.
/// If the two copies drift, the same fact reads differently on each surface, which
/// is the exact failure the desktop union was introduced to end.
///
/// Colour communicates activity and urgency consistently across the mobile
/// surface. Quiet and settled rows remain monochrome; active rows receive a
/// restrained tint while attention and blocked tones remain visually strongest.
export type RowTone =
  /// Nothing to report. Renders no spine at all.
  | "quiet"
  /// Settled successfully. Stated, but never lit.
  | "done"
  /// An agent is producing output. Nothing is owed to the user yet.
  | "working"
  /// An agent turn stopped part-way and neither finished nor asked anything.
  | "interrupted"
  /// Finished work is waiting to be looked at.
  | "review"
  /// TermLoop itself is running an operation on this row's behalf.
  | "busy"
  /// Someone is waiting on the user right now.
  | "attention"
  /// Structurally stuck. Nothing proceeds until it is repaired.
  | "blocked";

/// Ascending urgency. Consulted wherever two independent facts want one spine and
/// only the louder of them may have it.
const rank: Record<RowTone, number> = {
  quiet: 0,
  done: 1,
  working: 2,
  interrupted: 3,
  review: 4,
  busy: 5,
  attention: 6,
  blocked: 7,
};

export function strongerTone(left: RowTone, right: RowTone): RowTone {
  return rank[right] > rank[left] ? right : left;
}

/// Descending urgency for a list. The overview orders rows by how loudly they ask
/// for the user, so the row that needs a reply is never below one that is merely
/// running.
export function toneRank(tone: RowTone): number {
  return rank[tone];
}
