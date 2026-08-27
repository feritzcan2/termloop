import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import type { RowTone } from "@/presentation/tone";
import { color, geometry, radius, space, toneColor } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The small shared vocabulary every screen is built from. Kept in one file because
/// each piece is a handful of lines and splitting them would cost more navigation
/// than it saves.

/// A grouped surface. Depth is stated by surface value, not by an outline — the
/// only borders in this client are the ones that mean something: inputs and the
/// terminal frame. Children separate with dividers rather than gaps, so a group
/// reads as one object.
export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function CardDivider() {
  return <View style={styles.divider} />;
}

/// A section header in the prompt register: `❯ needs you`. The glyph is the
/// accent's one appearance per section, so the eye can hop prompt to prompt the
/// way it hops prompt to prompt in a scrollback.
export function SectionHeader({ label, trailing }: { label: string; trailing?: ReactNode }) {
  return (
    <View style={styles.sectionHeader} accessibilityRole="header">
      <View style={styles.sectionLabel}>
        <Text style={styles.prompt} accessibilityElementsHidden>❯</Text>
        <Text style={text.eyebrow}>{label}</Text>
      </View>
      {trailing}
    </View>
  );
}

export function Chip({ label, count, selected, onPress }: {
  label: string;
  count?: number | undefined;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
      {count === undefined ? null : (
        <Text style={[styles.chipCount, selected && styles.chipCountSelected]}>{count}</Text>
      )}
    </Pressable>
  );
}

export type DotKind = "connected" | "connecting" | "offline" | "needsAttention";

const dotColor: Record<DotKind, string> = {
  connected: color.success,
  connecting: color.warning,
  offline: color.textMuted,
  needsAttention: color.danger,
};

/// Connection reachability, which is a different question from a row's tone and so
/// has its own vocabulary. An unreachable Mac is hollow rather than coloured, because
/// "cannot be read" is an absence and should look like one.
export function StatusDot({ kind }: { kind: DotKind }) {
  const filled = kind !== "offline";
  return (
    <View
      style={[
        styles.dot,
        filled ? { backgroundColor: dotColor[kind] } : { borderColor: dotColor[kind], borderWidth: 1.5 },
      ]}
    />
  );
}

/// The one state word a row or header prints. Tinted by tone, never filled — a filled
/// pill reads as an action, and none of these are actionable from the phone.
export function StatePill({ tone, label }: { tone: RowTone; label: string }) {
  const tint = tone === "quiet" || tone === "done" ? color.textSecondary : toneColor[tone];
  return (
    <View style={[styles.pill, { borderColor: `${tint}59` }]}>
      <Text style={[text.pill, { color: tint }]} numberOfLines={1}>{label.toUpperCase()}</Text>
    </View>
  );
}

export type BannerKind = "info" | "warning" | "danger" | "gap";

const bannerTint: Record<BannerKind, string> = {
  info: color.accentStrong,
  warning: color.warning,
  danger: color.danger,
  gap: color.textSecondary,
};

/// A tinted strip with a leading bar — the row spine's vocabulary applied to a
/// message, so state colour means the same thing whether it marks a row or a
/// sentence.
export function Banner({ kind, message, action, onAction, onDismiss }: {
  kind: BannerKind;
  message: string;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const tint = bannerTint[kind];
  return (
    <View style={[styles.banner, { backgroundColor: `${tint}14` }]}>
      <View style={[styles.bannerBar, { backgroundColor: tint }]} />
      <Text style={[styles.bannerText, { color: tint }]}>{message}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={styles.bannerAction} hitSlop={10}>
          <Text style={[styles.bannerActionText, { color: tint }]}>{action}</Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={styles.bannerDismiss}
          hitSlop={12}
        >
          <Text style={[styles.bannerDismissGlyph, { color: tint }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ title, body, children }: PropsWithChildren<{ title: string; body: string }>) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
      {children}
    </View>
  );
}

/// A muted sentence where a section's normal body would be. Used wherever a fact is
/// genuinely unavailable: the screen says so in the place the fact belongs, rather
/// than hiding the section and leaving the reader to wonder.
export function UnavailableNote({ children }: PropsWithChildren) {
  return <Text style={styles.unavailable}>{children}</Text>;
}

export function PrimaryButton({ label, onPress, disabled }: {
  label: string;
  onPress: () => void;
  disabled?: boolean | undefined;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled === true }}
      style={({ pressed }) => [
        styles.primary,
        pressed && !disabled ? styles.primaryPressed : null,
        disabled ? styles.primaryDisabled : null,
      ]}
    >
      <Text style={[styles.primaryLabel, disabled ? styles.primaryLabelDisabled : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.secondary, pressed ? styles.secondaryPressed : null]}
    >
      <Text style={styles.secondaryLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card,
    backgroundColor: color.bgRaised,
    overflow: "hidden",
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.rule },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 24,
    /// Flush with the card beneath it. A 2pt inset read as a misalignment at every
    /// section, because the prompt and the card edge are the two verticals the eye
    /// actually lines up.
    paddingHorizontal: 0,
  },
  sectionLabel: { flexDirection: "row", alignItems: "center", gap: 7 },
  prompt: {
    color: color.accent,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "800",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    /// Without this a chip inherits `stretch` from a horizontal ScrollView's content
    /// container and grows to the full height of whatever space flexbox handed that
    /// container — which turned a 32pt pill into a 390pt capsule.
    alignSelf: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: color.bgRaised,
  },
  chipSelected: { backgroundColor: color.accentWash },
  chipLabel: {
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 12.5,
    fontWeight: "600",
    textTransform: "lowercase",
  },
  chipLabelSelected: { color: color.accentStrong },
  chipCount: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11.5, fontWeight: "700", fontVariant: ["tabular-nums"] },
  chipCountSelected: { color: color.accentStrong },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  /// Vertical padding lives on the text, not the container, so the leading bar
  /// runs the strip's full height instead of floating as an inset dash.
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.control,
    paddingRight: 4,
    overflow: "hidden",
  },
  bannerBar: { width: radius.spine, alignSelf: "stretch", marginRight: 2, marginLeft: 0 },
  bannerText: { flex: 1, fontSize: 12, lineHeight: 16, paddingVertical: 8 },
  bannerAction: { minHeight: 30, justifyContent: "center", paddingHorizontal: 6 },
  bannerActionText: { fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
  bannerDismiss: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  bannerDismissGlyph: { fontSize: 13, fontWeight: "700" },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  emptyTitle: { color: color.text, fontFamily: fontFamily.mono, fontSize: 14, fontWeight: "700" },
  emptyBody: {
    color: color.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    maxWidth: 280,
  },
  unavailable: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  primary: {
    minHeight: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    backgroundColor: color.accent,
  },
  primaryPressed: { backgroundColor: color.accentStrong },
  primaryDisabled: { backgroundColor: color.bgHover },
  primaryLabel: {
    color: color.onAccent,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  primaryLabelDisabled: { color: color.textMuted },
  secondary: {
    minHeight: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
  },
  secondaryPressed: { backgroundColor: color.bgHover },
  secondaryLabel: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 13, fontWeight: "600" },
});
