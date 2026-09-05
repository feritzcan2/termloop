import { useRouter, type Href } from "expo-router";
import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { useMobileRuntime } from "@/composition/runtime-context";
import { backNavigationAction } from "@/presentation/back-navigation";
import { color, geometry, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// Every screen's frame. The native header is off across the app so the header can
/// carry the Project selector and a compact right slot at the legacy client's proven
/// 47pt height; the stack's back gesture still works, and the chevron is a real 44pt
/// target rather than a native title-bar hit-box.
export function Screen({ children, edges }: PropsWithChildren<{ edges?: readonly Edge[] }>) {
  return (
    <SafeAreaView style={styles.screen} edges={edges ?? ["top", "bottom"]}>
      {children}
    </SafeAreaView>
  );
}

export function ScreenHeader({ title, subtitle, back, backFallback = "/", center, right }: {
  title?: string | undefined;
  subtitle?: string | undefined;
  /// The label the back chevron announces, so a screen reader says where it goes
  /// rather than just "back".
  back?: string | undefined;
  /// Used when an OTA reload or deep link restored this route without history.
  backFallback?: Href | undefined;
  /// Replaces the title zone entirely — used by the Project selector.
  center?: ReactNode;
  right?: ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.header}>
      {back === undefined ? null : (
        <Pressable
          onPress={() => {
            if (backNavigationAction(router.canGoBack()) === "back") router.back();
            else router.replace(backFallback);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${back}`}
          hitSlop={12}
          style={styles.backButton}
        >
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
      )}
      {center ?? (
        <View style={styles.titleZone}>
          <Text style={text.headerTitle} numberOfLines={1}>{title}</Text>
          {subtitle === undefined ? null : (
            <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
          )}
        </View>
      )}
      {right}
    </View>
  );
}

/// The home header's identity: the product name set in the terminal's own face,
/// ending in a steady block cursor. The cursor does not blink here — the wordmark
/// is an identity, not a request, and blinking is reserved for rows that are
/// actually waiting on the user.
export function Wordmark() {
  return (
    <View style={styles.wordmarkZone} accessibilityRole="header" accessible accessibilityLabel="TermLoop">
      <Text style={styles.wordmark} numberOfLines={1}>
        termloop
        <Text style={styles.wordmarkCursor} accessibilityElementsHidden>▮</Text>
      </Text>
    </View>
  );
}

export function MockBadge() {
  const runtime = useMobileRuntime();
  if (runtime.kind !== "mock") return null;
  return (
    <View style={styles.mockBadge}>
      <Text style={styles.mockBadgeText}>MOCK</Text>
    </View>
  );
}

export function MockNotice({ detail }: { detail: string }) {
  const runtime = useMobileRuntime();
  if (runtime.kind !== "mock") return null;
  return (
    <View style={styles.mockNotice}>
      <Text style={styles.mockNoticeText}>
        <Text style={styles.mockNoticeLead}>Mock data. </Text>
        {detail}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bgApp },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: geometry.header,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.rule,
  },
  backButton: {
    width: 28,
    height: geometry.touchTarget,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  backChevron: { color: color.accentStrong, fontSize: 28, lineHeight: 32 },
  titleZone: { flex: 1, minWidth: 0 },
  subtitle: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  wordmarkZone: { flex: 1, minWidth: 0 },
  wordmark: {
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.4,
  },
  wordmarkCursor: { color: color.accent, fontWeight: "400" },
  mockBadge: {
    borderWidth: 1,
    borderColor: `${color.accentStrong}55`,
    backgroundColor: color.accentWash,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  mockBadgeText: {
    color: color.accentStrong,
    fontFamily: fontFamily.mono,
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.9,
  },
  mockNotice: {
    borderWidth: 1,
    borderColor: `${color.accentStrong}33`,
    backgroundColor: color.accentWash,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  mockNoticeText: { color: color.textSecondary, fontSize: 12, lineHeight: 17 },
  mockNoticeLead: { color: color.accentStrong, fontWeight: "700" },
});
