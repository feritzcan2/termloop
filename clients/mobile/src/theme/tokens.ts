/// The mobile client's colour and geometry vocabulary.
///
/// Mobile uses the desktop shell's surface and accent vocabulary while retaining
/// phone-native geometry. The same Project should therefore feel like the same
/// workspace on both clients, without shrinking 44pt targets or 56pt rows to the
/// desktop sidebar's pointer-sized controls.

export const color = {
  bgApp: "#1e2325",
  bgRaised: "#2b3032",
  bgSidebar: "#303537",
  bgHover: "#353a3c",
  /// Darker than every chrome surface. The terminal is a screen within the
  /// screen, and it reads as one only if nothing around it is deeper.
  bgTerminal: "#282c34",

  border: "#353a3c",
  borderStrong: "#434749",
  rule: "rgba(255,255,255,0.08)",

  text: "#dededf",
  textSecondary: "#9aa0a1",
  textMuted: "#5b6062",

  accent: "#7c5cff",
  accentStrong: "#a48cff",
  accentWash: "rgba(124,92,255,0.12)",

  success: "#5cc995",
  warning: "#d9aa5f",
  danger: "#e1757e",

  agentClaude: "#c78cf2",
  agentCodex: "#66b3ff",

  onAccent: "#f7f5ff",
  scrim: "rgba(8,10,11,0.76)",
} as const;

/// Tone hues. `quiet` renders no spine at all and `done` is stated but never lit,
/// so neither has a colour here — a settled row must not compete with the one row
/// that is actually waiting on the user.
export const toneColor = {
  working: "#5cc995",
  interrupted: "#e5b454",
  review: "#66b3ff",
  busy: "#e67a14",
  attention: "#ff8f6b",
  blocked: "#c93d36",
} as const;

/** Subtle row fields make live state glanceable without turning the list neon. */
export const toneWash = {
  working: "rgba(92,201,149,0.10)",
  interrupted: "rgba(229,180,84,0.10)",
  review: "rgba(102,179,255,0.12)",
  busy: "rgba(230,122,20,0.11)",
  attention: "rgba(255,143,107,0.14)",
  blocked: "rgba(201,61,54,0.14)",
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
