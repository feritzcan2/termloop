import { useTheme, createThemedStyles } from "@/theme/context";
import type { TaskDto } from "@termloop/contract/current";
import { Pressable, Text, View } from "react-native";

import { openExternalLink } from "@/components/external-link";
import { ToneSpine, WaitingCursor } from "@/components/tone-spine";
import type { AgentRow } from "@/presentation/attention-overview";
import { taskJiraIssueKey } from "@/presentation/dto-readers";
import { geometry, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// One Agent row, shaped like the desktop sidebar's Session row: a tone rail,
/// the agent's presence dot, one title line, and a mono state line
/// (state · runner · folder). An attached Task is a third, quiet line, and its
/// Jira key stays a separate touch target outside the row's own button.
export function AgentSessionRow({ row, task, title, accessibleName, age, onPress, onLongPress }: {
  row: AgentRow;
  /// The Task this Agent works in, when no surrounding frame already names it.
  task?: TaskDto | undefined;
  title: string;
  accessibleName: string;
  age: string | undefined;
  onPress(): void;
  onLongPress(): void;
}) {
  const { color, toneColor, toneWash } = useTheme();
  const styles = useStyles();
  const lit = row.tone !== "quiet" && row.tone !== "done";
  const tint = lit ? toneColor[row.tone] : color.textSecondary;
  const asking = row.tone === "attention" || row.tone === "blocked";
  const brand = row.agentId === "claude" ? color.agentClaude : row.agentId === "codex" ? color.agentCodex : color.accent;
  const issueKey = task?.jira_url ? taskJiraIssueKey(task.jira_url) : undefined;
  return <View style={[styles.row, lit ? { backgroundColor: toneWash[row.tone] } : null]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task ? `${accessibleName}. Task ${task.title}` : accessibleName}
      accessibilityHint="Open agent. Long press for actions."
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={[{ name: "longpress", label: "Show actions" }]}
      onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "longpress") onLongPress(); }}
      style={({ pressed }) => [styles.main, pressed ? styles.pressed : null]}
    >
      <ToneSpine tone={row.tone} />
      <View style={styles.presence}>
        <View style={[
          styles.dot,
          { backgroundColor: brand, opacity: row.attachable ? 1 : 0.4 },
          lit ? { borderColor: tint } : null,
        ]} />
      </View>
      <View style={styles.copy}>
        <View style={styles.identity}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {age ? <Text style={styles.age}>{age}</Text> : null}
        </View>
        <View style={styles.stateLine}>
          <Text style={[styles.state, { color: lit ? tint : color.text }]} numberOfLines={1}>{row.stateLabel}</Text>
          {asking ? <WaitingCursor tint={tint} /> : null}
          {row.runner ? <>
            <Text style={styles.sep}>·</Text>
            <Text style={[styles.runner, { color: brand }]} numberOfLines={1}>{row.runner}</Text>
          </> : null}
          {row.folder ? <>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.folder} numberOfLines={1}>{row.folder}</Text>
          </> : null}
        </View>
        {task ? <View style={styles.taskLine}>
          <Text style={styles.taskGlyph} accessibilityElementsHidden>↳</Text>
          <Text style={styles.task} numberOfLines={1}>{task.title}</Text>
        </View> : null}
      </View>
      <Text style={styles.chevron} accessibilityElementsHidden>›</Text>
    </Pressable>
    {task?.jira_url && issueKey ? (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Open ${issueKey} in Jira`}
        accessibilityHint="Open outside TermLoop"
        onPress={() => { void openExternalLink(task.jira_url!); }}
        style={({ pressed }) => [styles.key, pressed ? styles.keyPressed : null]}
      >
        <Text style={styles.keyLabel}>{issueKey}</Text>
      </Pressable>
    ) : null}
  </View>;
}

const useStyles = createThemedStyles(({ color }) => ({
  row: { flexDirection: "row", alignItems: "stretch" },
  main: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 10, paddingRight: space.sm, paddingVertical: 10, minHeight: geometry.sessionRowMinHeight },
  pressed: { backgroundColor: color.bgHover },
  presence: { width: 12, alignItems: "center", alignSelf: "flex-start", paddingTop: 5 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: "transparent" },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  identity: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, color: color.text, fontSize: 15, fontWeight: "600", letterSpacing: -0.1 },
  age: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, fontVariant: ["tabular-nums"] },
  stateLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  state: { flexShrink: 0, maxWidth: "55%", fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700" },
  sep: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  runner: { flexShrink: 0, maxWidth: "35%", fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "600" },
  folder: { flexShrink: 1, color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11 },
  taskLine: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  taskGlyph: { color: color.textMuted, fontSize: 11 },
  task: { flex: 1, color: color.textSecondary, fontSize: 12 },
  chevron: { color: color.textMuted, fontSize: 15 },
  key: { justifyContent: "center", paddingHorizontal: space.sm, minWidth: geometry.touchTarget, alignItems: "center" },
  keyPressed: { opacity: 0.6 },
  keyLabel: { color: color.warning, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "700" },
}));
