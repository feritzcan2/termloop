import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ToneSpine, WaitingCursor } from "@/components/tone-spine";
import type { RowTone } from "@/presentation/tone";
import { color, geometry, space, toneColor, toneWash } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The list row every surface uses.
///
/// Two lines, and the second one is position-stable: the state line is always the
/// second line whether it is a state word, a Task title, or a path. A row whose
/// second line means something different depending on what happened forces the reader
/// to parse before they can compare, which defeats the point of a scannable list.
///
/// The whole row is one touch target at 56pt minimum, not a title with a small
/// chevron hot-spot.
export interface RowProps {
  tone: RowTone;
  title: string;
  /// Optional place label above identity, used when rows from several Macs share
  /// one list and the user needs context without choosing a computer first.
  eyebrow?: string | undefined;
  /// The state word, printed before the rest of the state line and tinted by tone.
  state?: string | undefined;
  detail?: string | undefined;
  trailing?: ReactNode;
  /// Right-aligned on the identity line: an age, a count.
  meta?: string | undefined;
  accessibleName: string;
  onPress?: (() => void) | undefined;
  onLongPress?: (() => void) | undefined;
  minHeight?: number | undefined;
  /// Set when the row is informational and has nothing to open, so the chevron is not
  /// promised.
  disabled?: boolean | undefined;
}

/// The tones that are actually asking for the user, and therefore blink the
/// waiting cursor. Everything else states itself and stays still.
function isAsking(tone: RowTone): tone is "attention" | "blocked" {
  return tone === "attention" || tone === "blocked";
}

export function Row(props: RowProps) {
  const {
    tone, title, eyebrow, state, detail, trailing, meta,
    accessibleName, onPress, onLongPress, minHeight, disabled,
  } = props;
  const interactive = onPress !== undefined && disabled !== true;
  return (
    <Pressable
      onPress={interactive ? onPress : undefined}
      onLongPress={onLongPress}
      disabled={!interactive}
      accessibilityRole={interactive ? "button" : "text"}
      accessibilityLabel={accessibleName}
      style={({ pressed }) => [
        styles.row,
        rowWash(tone),
        { minHeight: minHeight ?? geometry.sessionRowMinHeight },
        pressed && interactive ? styles.pressed : null,
      ]}
    >
      <ToneSpine tone={tone} />
      <View style={styles.body}>
        {eyebrow === undefined ? null : (
          <Text style={styles.eyebrow} numberOfLines={1}>{eyebrow}</Text>
        )}
        <View style={styles.identity}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {meta === undefined ? null : <Text style={styles.meta}>{meta}</Text>}
        </View>
        <Text style={styles.state} numberOfLines={2}>
          {state === undefined ? null : (
            /// The state word carries the row's tone, so the spine and the words agree
            /// rather than making the reader match a colour to a label.
            <Text style={[text.stateWord, { color: stateTint(tone) }]}>{state}</Text>
          )}
          {state !== undefined && isAsking(tone) ? <WaitingCursor tint={toneColor[tone]} /> : null}
          {state !== undefined && detail !== undefined ? "  ·  " : null}
          {detail}
        </Text>
      </View>
      {trailing}
      {interactive ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
  );
}

function rowWash(tone: RowTone): { backgroundColor: string } | undefined {
  return tone === "quiet" || tone === "done" ? undefined : { backgroundColor: toneWash[tone] };
}

/// A settled row states its word in ordinary text. Only a row that is asking for
/// something spends a colour on it.
function stateTint(tone: RowTone): string {
  return tone === "quiet" || tone === "done" ? color.text : toneColor[tone];
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 10,
    paddingRight: 10,
    paddingVertical: 11,
  },
  pressed: { backgroundColor: color.bgHover },
  body: { flex: 1, minWidth: 0, gap: 3 },
  eyebrow: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  identity: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { ...text.rowTitle, flex: 1, fontSize: 15, letterSpacing: -0.1 },
  meta: {
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  state: { color: color.textSecondary, fontSize: 12.5, lineHeight: 17 },
  /// Small and muted. The row is the target; the chevron only says a row opens, and a
  /// heavy one competes with the title on every single line.
  chevron: { color: color.textMuted, fontSize: 15, lineHeight: 17, marginLeft: 2 },
});
