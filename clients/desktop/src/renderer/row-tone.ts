/// The sidebar's single tone vocabulary.
///
/// Task rows and Session rows share the `.row-rail` spine and the same reader,
/// but until this module they fed that spine from two independent unions, so the
/// same fact resolved to two different hues: an agent that was working lit its
/// own Session spine orange and its parent Task spine green, and `attention` was
/// amber on a Session row and salmon on a Task row — told apart only by an
/// ancestor-specificity override in `app.css`. One union means one rule per tone
/// and no surface can invent a hue for a fact another surface already names.
///
/// Colour carries exactly one meaning across both surfaces: "this row wants
/// something from you". A settled row resolves to `quiet` and stays monochrome so
/// it never competes with the one row that is actually blocked or waiting.
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
///
/// A structural blocker outranks a waiting agent, and a waiting agent outranks an
/// operation TermLoop started — otherwise a row being provisioned would draw the
/// eye while the one that actually needs a reply stayed grey.
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
