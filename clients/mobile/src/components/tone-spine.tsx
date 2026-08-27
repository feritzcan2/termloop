import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, Text, View } from "react-native";

import type { RowTone } from "@/presentation/tone";
import { fontFamily } from "@/theme/typography";
import { radius, toneColor } from "@/theme/tokens";

/// The row's strongest tone marker. The surrounding row uses only a restrained
/// wash, while this spine carries the precise state colour. Urgency is not a
/// glow here — it is the waiting cursor below, placed next to the state word.
///
/// `quiet` and `done` render nothing. A settled row is stated in words, never in
/// colour.
export function ToneSpine({ tone }: { tone: RowTone }) {
  const background = tone === "quiet" || tone === "done" ? undefined : toneColor[tone];
  if (background === undefined) return <View style={styles.spine} />;
  return <View style={[styles.spine, { backgroundColor: background }]} />;
}

/// The client's signature mark. A terminal shows a blinking block cursor at the
/// exact moment it is waiting on the user, and that is precisely what an
/// attention or blocked row is doing — so those rows blink a `▮` beside their
/// state word. The square-wave blink is the terminal's own cadence, not a fade.
/// With Reduce Motion on, the cursor holds steady instead of blinking; presence
/// is the signal, motion is only emphasis.
export function WaitingCursor({ tint }: { tint: string }) {
  const [lit, setLit] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setLit(true);
      return;
    }
    /// 530ms is the canonical terminal blink half-period.
    const interval = setInterval(() => setLit((value) => !value), 530);
    return () => clearInterval(interval);
  }, [reduceMotion]);

  return (
    <Text
      accessibilityElementsHidden
      style={[styles.cursor, { color: tint, opacity: lit ? 1 : 0.18 }]}
    >
      {" ▮"}
    </Text>
  );
}

const styles = StyleSheet.create({
  spine: {
    width: radius.spine,
    borderRadius: radius.spine,
    alignSelf: "stretch",
    marginVertical: 2,
  },
  cursor: { fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "700" },
});
