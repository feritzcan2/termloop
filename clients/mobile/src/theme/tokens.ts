/// The mobile client's colour and geometry vocabulary.
///
/// Mobile is deliberately light-only. Muted slate surfaces reduce glare while keeping
/// dense terminal and worktree content readable, and a saturated blue accent carries
/// selection and primary action. Phone-native geometry remains independent from the palette.

export const color = {
  bgApp: "#DFE4EC",
  bgRaised: "#ECEFF4",
  bgSidebar: "#D4DAE5",
  bgHover: "#C3CCD9",
  /// A quiet code canvas: comfortably dimmer than cards without becoming a dark island.
  bgTerminal: "#D0D7E2",

  border: "#B7C0CF",
  borderStrong: "#929FB2",
  rule: "rgba(23,32,51,0.16)",

  text: "#172033",
  textSecondary: "#536079",
  textMuted: "#596579",

  accent: "#0B609B",
  accentStrong: "#083D66",
  accentWash: "rgba(11,96,155,0.16)",

  success: "#0B6845",
  successWash: "rgba(11,104,69,0.15)",
  warning: "#7D4D00",
  danger: "#A7273E",
  dangerBorder: "#E28A99",
  dangerWash: "rgba(167,39,62,0.15)",
  attention: "#9F3517",

  agentClaude: "#8C3E0B",
  agentCodex: "#0B625B",

  onAccent: "#FFFFFF",
  shadow: "#10192C",
  scrim: "rgba(23,32,51,0.42)",
  mediaScrim: "rgba(16,24,40,0.74)",
  onMedia: "#FFFFFF",
} as const;

/// Tone hues. `quiet` renders no spine at all and `done` is stated but never lit,
/// so neither has a colour here — a settled row must not compete with the one row
/// that is actually waiting on the user.
export const toneColor = {
  working: "#0B6845",
  interrupted: "#7D4D00",
  review: "#125F9C",
  busy: "#8C3E0B",
  attention: "#9F3517",
  blocked: "#A7273E",
} as const;

/** Subtle row fields make live state glanceable without turning the list neon. */
export const toneWash = {
  working: "rgba(11,104,69,0.14)",
  interrupted: "rgba(125,77,0,0.14)",
  review: "rgba(18,95,156,0.14)",
  busy: "rgba(140,62,11,0.14)",
  attention: "rgba(159,53,23,0.15)",
  blocked: "rgba(167,39,62,0.15)",
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
