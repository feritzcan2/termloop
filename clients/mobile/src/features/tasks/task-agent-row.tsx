import type { TaskDto } from "@termloop/contract/current";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentAvatar } from "../../components/agent-avatar";
import { JiraIssueLink } from "../../components/external-link";
import { ToneSpine } from "../../components/tone-spine";
import type { AgentRow } from "../../presentation/attention-overview";
import { color, space, toneColor, toneWash } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** One task-led row; Jira remains an independent touch target beside navigation. */
export function TaskAgentRow({ row, task, age, onPress, onLongPress }: {
  row: AgentRow;
  task: TaskDto;
  age: string | undefined;
  onPress(): void;
  onLongPress(): void;
}) {
  const tone = row.tone;
  const tint = tone === "quiet" || tone === "done" ? color.textSecondary : toneColor[tone];
  const wash = tone === "quiet" || tone === "done" ? undefined : toneWash[tone];
  return <View style={[styles.row, { backgroundColor: wash }]}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}. ${row.accessibleName}`}
      accessibilityHint="Open agent. Long press for actions."
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={[{ name: "longpress", label: "Show actions" }]}
      onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "longpress") onLongPress(); }}
      style={({ pressed }) => [styles.main, pressed ? styles.pressed : null]}
    >
      <ToneSpine tone={row.tone} />
      <View style={styles.copy}>
        <Text style={styles.kind}>TASK</Text>
        <Text style={styles.title} numberOfLines={3}>{task.title}</Text>
        <View style={styles.agent}>
          <AgentAvatar agentId={row.agentId} active={row.attachable} />
          <Text style={styles.agentName} numberOfLines={1}>{row.title}</Text>
        </View>
      </View>
    </Pressable>
    <View style={styles.actions}>
      <JiraIssueLink url={task.jira_url} />
      <Text style={[styles.state, { color: tint }]}>{row.stateLabel}</Text>
      {age ? <Text style={styles.age}>{age}</Text> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  main: { flex: 1, minWidth: 0, flexDirection: "row", gap: 10, padding: space.md, minHeight: 76 },
  pressed: { backgroundColor: color.bgHover },
  copy: { flex: 1, minWidth: 0, gap: 5 },
  kind: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 9, fontWeight: "600", letterSpacing: 0.7 },
  title: { color: color.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  agent: { flexDirection: "row", alignItems: "center", gap: 6 },
  agentName: { flex: 1, color: color.textSecondary, fontSize: 12 },
  actions: { maxWidth: "35%", alignItems: "flex-end", paddingRight: space.sm, paddingVertical: space.sm, gap: 3 },
  state: { fontSize: 11, fontWeight: "600", textAlign: "right", paddingHorizontal: space.sm },
  age: { color: color.textMuted, fontSize: 10, paddingHorizontal: space.sm },
});
