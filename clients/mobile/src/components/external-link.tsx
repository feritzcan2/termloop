import type { ReactNode } from "react";
import { Alert, Linking, Pressable, StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";

import { taskJiraIssueKey } from "@/presentation/dto-readers";
import { webUrl } from "@/presentation/web-links";
import { color, geometry, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export async function openExternalLink(value: string): Promise<void> {
  const url = webUrl(value);
  if (url === undefined) return;
  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert("Could not open link", "Try opening the link again, or copy it into your browser.");
  }
}

export function ExternalLink({ url, children, style }: { url: string; children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text
    accessibilityRole="link"
    accessibilityLabel={url}
    accessibilityHint="Open outside TermLoop"
    onPress={() => { void openExternalLink(url); }}
    style={[style, styles.inline]}
  >{children}</Text>;
}

export function JiraIssueLink({ url }: { url: string | null | undefined }) {
  if (!url || !webUrl(url)) return null;
  const key = taskJiraIssueKey(url);
  return <Pressable
    accessibilityRole="link"
    accessibilityLabel={`Open ${key} in Jira`}
    accessibilityHint="Open outside TermLoop"
    onPress={() => { void openExternalLink(url); }}
    style={({ pressed }) => [styles.issue, pressed ? styles.pressed : null]}
  >
    <Text style={styles.issueLabel}>{key} ↗</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  inline: { color: color.accentStrong, textDecorationLine: "underline" },
  issue: { minHeight: geometry.touchTarget, justifyContent: "center", alignSelf: "flex-start", paddingHorizontal: space.sm },
  issueLabel: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  pressed: { opacity: 0.65 },
});
