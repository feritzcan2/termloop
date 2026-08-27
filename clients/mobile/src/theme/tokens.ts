/// The mobile client's colour and geometry vocabulary.
///
/// The chrome is a deliberate fork from the desktop's `app.css`: the phone is a
/// pager for terminals, and its identity comes from the terminal's own world —
/// ink with a faint phosphor cast, a teal prompt accent (ANSI cyan, the one hue
/// the six-tone state vocabulary leaves free), and depth stated by surface value
/// rather than by borders. Agent hues stay identical to the desktop because they
/// are cross-client semantics, not chrome. Geometry keeps the phone-proven legacy
/// numbers: 44pt targets and 56pt rows survive a thumb, 2px spines do not.

export const color = {
  bgApp: "#0c1110",
  bgRaised: "#131917",
  bgSidebar: "#161d1b",
  bgHover: "#1b2320",
  /// Darker than every chrome surface. The terminal is a screen within the
  /// screen, and it reads as one only if nothing around it is deeper.
  bgTerminal: "#090d0c",

  border: "#212a27",
  borderStrong: "#313d39",
  rule: "rgba(190,255,235,0.07)",

  text: "#e9efeb",
  textSecondary: "#93a49d",
  textMuted: "#5a6a63",

  accent: "#3ecfad",
  accentStrong: "#7fe6cc",
  accentWash: "rgba(62,207,173,0.11)",

  success: "#4cc98a",
  warning: "#dfb35c",
  danger: "#ef7c82",

  agentClaude: "#c78cf2",
  agentCodex: "#6bb2ff",

  /// Dark on the teal accent. White fails contrast on a light phosphor fill.
  onAccent: "#062019",
  scrim: "rgba(2,6,5,0.72)",
} as const;

/// Tone hues. `quiet` renders no spine at all and `done` is stated but never lit,
/// so neither has a colour here — a settled row must not compete with the one row
/// that is actually waiting on the user.
export const toneColor = {
  working: color.success,
  interrupted: "#dfb35c",
  review: color.agentCodex,
  busy: "#e8813f",
  attention: "#ff8e62",
  blocked: "#ef5350",
} as const;

/** Subtle row fields make live state glanceable without turning the list neon. */
export const toneWash = {
  working: "rgba(76,201,138,0.10)",
  interrupted: "rgba(223,179,92,0.10)",
  review: "rgba(107,178,255,0.12)",
  busy: "rgba(232,129,63,0.11)",
  attention: "rgba(255,142,98,0.14)",
  blocked: "rgba(239,83,80,0.13)",
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
