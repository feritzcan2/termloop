/// The mobile client's colour and geometry vocabulary.
///
/// Mobile is deliberately light-only. Cool paper surfaces keep dense terminal and
/// worktree content calm in daylight, while a single indigo accent carries selection
/// and primary action. Phone-native geometry remains independent from the palette.

export const color = {
  bgApp: "#F7F8FC",
  bgRaised: "#FFFFFF",
  bgSidebar: "#F0F2F8",
  bgHover: "#E7EAF2",
  /// A quiet code canvas: distinct from cards without becoming a dark island.
  bgTerminal: "#F3F5F9",

  border: "#DDE2EC",
  borderStrong: "#C5CCDA",
  rule: "rgba(23,32,51,0.10)",

  text: "#172033",
  textSecondary: "#536079",
  textMuted: "#697386",

  accent: "#5B4CE2",
  accentStrong: "#4034B8",
  accentWash: "rgba(91,76,226,0.10)",

  success: "#147A53",
  successWash: "rgba(20,122,83,0.10)",
  warning: "#986000",
  danger: "#BE344B",
  dangerBorder: "#E28A99",
  dangerWash: "rgba(190,52,75,0.10)",
  attention: "#C04B28",

  agentClaude: "#8F48BA",
  agentCodex: "#1769AA",

  onAccent: "#FFFFFF",
  shadow: "#16213D",
  scrim: "rgba(23,32,51,0.34)",
  mediaScrim: "rgba(16,24,40,0.74)",
  onMedia: "#FFFFFF",
} as const;

/// Tone hues. `quiet` renders no spine at all and `done` is stated but never lit,
/// so neither has a colour here — a settled row must not compete with the one row
/// that is actually waiting on the user.
export const toneColor = {
  working: "#147A53",
  interrupted: "#986000",
  review: "#1769AA",
  busy: "#A84F12",
  attention: "#C04B28",
  blocked: "#BE344B",
} as const;

/** Subtle row fields make live state glanceable without turning the list neon. */
export const toneWash = {
  working: "rgba(20,122,83,0.09)",
  interrupted: "rgba(152,96,0,0.09)",
  review: "rgba(23,105,170,0.09)",
  busy: "rgba(168,79,18,0.09)",
  attention: "rgba(192,75,40,0.10)",
  blocked: "rgba(190,52,75,0.10)",
} as const;

export const radius = {
  control: 8,
  card: 12,
  sheet: 20,
  pill: 999,
  /// 3 rather than the desktop's 2: touch legibility is bought with width, not
  /// with more colour.
  spine: 3,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  screen: 14,
} as const;

export const geometry = {
  /// iOS's own minimum, and the reason every row and control below states a
  /// minHeight instead of relying on padding.
  touchTarget: 44,
  header: 47,
  sessionRowMinHeight: 56,
  taskRowMinHeight: 85,
  sheetHandle: { width: 36, height: 4 },
  jumpToBottom: 38,
  /// The filter row is measured rather than left to flexbox. As a bare flex child of a
  /// column screen it shared the leftover space with the list below it and stretched its
  /// chips into full-height capsules.
  filterBar: 48,
} as const;

export const terminalGeometry = {
  /// The `Aa` control cycles these three, and the line height is round(size×1.35)
  /// at each step rather than a single ratio that only looks right at one size.
  fontSizes: [11, 13, 15] as const,
  lineHeights: [15, 18, 20] as const,
  contentPadding: 12,
  composerInputMin: 44,
  composerInputMax: 96,
  keyRowHeight: 39,
  /// Narrow enough that the nine keys fit a 390pt phone without scrolling, which is what
  /// stops the last key sitting half-cut against the edge. Still 39pt tall, so the target
  /// stays thumb-sized in the direction that matters for a key row.
  keyMinWidth: 36,
  /// Bounded on purpose. The phone holds a window, not the session's history, and
  /// the view states the cap where it bites instead of dropping bytes silently.
  maxLines: 600,
} as const;
