import { useTheme, createThemedStyles } from "@/theme/context";
import type { TaskDto } from "@termloop/contract/current";
import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { EmptyState, SecondaryButton } from "@/components/primitives";
import { openExternalLink } from "@/components/external-link";
import type { AgentRow, TaskRow } from "@/presentation/attention-overview";
import { buildTaskBrowserItems, compactBranchName, filterTaskItems, taskFilters, type TaskBrowserItem, type TaskFilter } from "@/presentation/task-browser";
import { taskChangeLabel } from "@/presentation/task-presentation";
import { geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export interface TaskBrowserProps {
  rows: readonly TaskRow[];
  tasks: readonly TaskDto[];
  agents: readonly AgentRow[];
  refreshing: boolean;
  refresh: () => void;
  openTask: (taskId: string) => void;
  openChanges: (taskId: string) => void;
  openAgent: (sessionId: string) => void;
  openTemplates: () => void;
  openSteward: () => void;
}

export function TaskBrowser(props: TaskBrowserProps) {
  const { color } = useTheme();
  const styles = useStyles();
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const list = useRef<FlatList<TaskBrowserItem>>(null);
  const items = useMemo(() => buildTaskBrowserItems(props.rows, props.tasks, props.agents), [props.rows, props.tasks, props.agents]);
  const visible = useMemo(() => filterTaskItems(items, filter, query), [items, filter, query]);
  const resetScroll = () => list.current?.scrollToOffset({ offset: 0, animated: false });
  const reset = () => { setFilter("all"); setQuery(""); resetScroll(); };

  return (
    <FlatList
      style={styles.screen}
      ListHeaderComponent={(
        <View style={styles.toolbar}>
          <View style={styles.heading}>
            <View style={styles.headingCopy}>
              <Text style={styles.title} accessibilityRole="header">Your tasks</Text>
              <Text style={styles.subtitle}>{items.length} open · Needs attention first</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Workflow templates" onPress={props.openTemplates} style={styles.templates}>
              <Text style={styles.templatesLabel}>Templates</Text>
              <Text style={styles.templatesArrow} accessibilityElementsHidden>↗</Text>
            </Pressable>
          </View>
          {items.length === 0 ? null : (
            <>
              <View style={styles.search}>
                <TextInput
                  accessibilityLabel="Search tasks"
                  placeholder="Search tasks, branches or issues"
                  placeholderTextColor={color.textMuted}
                  value={query}
                  onChangeText={(value) => { setQuery(value); resetScroll(); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  style={styles.searchInput}
                />
                {query.length === 0 ? null : (
                  <Pressable accessibilityRole="button" accessibilityLabel="Clear task search" onPress={() => { setQuery(""); resetScroll(); }} style={styles.clear}>
                    <Text style={styles.clearGlyph}>×</Text>
                  </Pressable>
                )}
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.filters} contentContainerStyle={styles.filterContent}>
                {taskFilters.map((option) => {
                  const count = option.id === "all" ? items.length : items.filter((item) => item.filter === option.id).length;
                  const selected = filter === option.id;
                  const signal = count > 0 && option.id === "attention" ? color.attention
                    : count > 0 && option.id === "active" ? color.success : undefined;
                  return (
                    <Pressable
                      key={option.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${option.label}, ${count} tasks`}
                      accessibilityState={{ selected }}
                      onPress={() => { setFilter(option.id); resetScroll(); }}
                      style={[styles.filter, signal && !selected ? { backgroundColor: `${signal}1F`, borderColor: signal } : null, selected ? styles.filterSelected : null]}
                    >
                      {signal ? <View style={[styles.filterDot, { backgroundColor: selected ? color.onAccent : signal }]} /> : null}
                      <Text style={[styles.filterLabel, signal ? { color: signal } : null, selected ? styles.filterLabelSelected : null]}>{option.label}</Text>
                      <Text style={[styles.filterCount, signal ? { color: signal } : null, selected ? styles.filterLabelSelected : null]}>{count}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {query.trim().length > 0 || filter !== "all" ? (
                <Text style={styles.resultCount} accessibilityLiveRegion="polite">{visible.length} of {items.length} tasks</Text>
              ) : null}
            </>
          )}
        </View>
      )}
      ref={list}
      data={visible}
      keyExtractor={(item) => item.row.taskId}
      renderItem={({ item }) => <TaskCard item={item} openTask={props.openTask} openAgent={props.openAgent} openChanges={props.openChanges} />}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshing={props.refreshing}
      onRefresh={props.refresh}
      ListEmptyComponent={items.length === 0 ? (
        <EmptyState title="A place for your next task" body="Tasks you create on your Mac appear here. Ask the Steward to help plan what comes next.">
          <SecondaryButton label="Talk to Steward" onPress={props.openSteward} />
        </EmptyState>
      ) : (
        <EmptyState title={query.trim() ? "No matching tasks" : "No tasks in this view"} body="Try a different search or show all open tasks.">
          <SecondaryButton label="Show all tasks" onPress={reset} />
        </EmptyState>
      )}
    />
  );
}

/// Mirrors the desktop sidebar's Task card: a tone spine, one identity line
/// (status dot, ticket key, status pill, scope), a compact title and brief, a
/// mono meta line, and the Task's live agents as their own rows underneath.
function TaskCard({ item, openTask, openChanges, openAgent }: {
  item: TaskBrowserItem;
  openTask: TaskBrowserProps["openTask"];
  openChanges: TaskBrowserProps["openChanges"];
  openAgent: TaskBrowserProps["openAgent"];
}) {
  const { color, toneColor, toneWash } = useTheme();
  const styles = useStyles();
  const { row, task, card, agents } = item;
  const lit = row.tone !== "quiet" && row.tone !== "done";
  const tint = lit ? toneColor[row.tone] : color.textSecondary;
  const waiting = row.attention?.tone === "attention" || row.attention?.tone === "review" ? row.attention : undefined;
  const waitingAgent = waiting ? agents.find((agent) => agent.sessionId === waiting.sessionId) ?? item.agent : undefined;
  const shownAgents = agents.slice(0, 3);
  const detail = row.stage.id !== "ready" ? row.stage.summary : item.statusDetail ?? item.brief;
  return (
    <View style={[styles.card, lit ? { borderLeftColor: tint } : null]}>
      {/* Header and meta rows sit beside the details button, never inside it,
          so the Jira key and the changes signal stay independently reachable. */}
      <View style={styles.ids}>
        <View style={[styles.dot, { backgroundColor: lit ? tint : color.borderStrong }, lit ? { shadowColor: tint } : null]} />
        {card.key ? (
          task.jira_url ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={`Open ${card.key} in Jira`}
              hitSlop={10}
              onPress={() => { void openExternalLink(task.jira_url!); }}
            >
              <Text style={styles.key}>{card.key}</Text>
            </Pressable>
          ) : <Text style={styles.key}>{card.key}</Text>
        ) : null}
        <View style={[styles.pill, { backgroundColor: lit ? toneWash[row.tone] : color.bgHover }]}>
          <Text style={[styles.pillLabel, { color: tint }]} numberOfLines={1}>{item.status}</Text>
        </View>
        {card.scope ? <Text style={styles.scope} numberOfLines={1}>{card.scope}</Text> : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.status}. ${task.title}. ${item.statusDetail ?? row.stage.summary}`}
        accessibilityHint="Open task details"
        onPress={() => openTask(task.id)}
        style={({ pressed }) => [styles.cardMain, pressed ? styles.pressed : null]}
      >
        <View style={styles.titleRow}>
          <Text style={styles.cardTitle} numberOfLines={2}>{card.title}</Text>
          <Text style={styles.chevron} accessibilityElementsHidden>›</Text>
        </View>
        {detail ? <Text style={styles.brief} numberOfLines={2}>{detail}</Text> : null}
      </Pressable>
      <View style={styles.meta}>
        <Text style={[styles.metaBranch, task.branch ? null : styles.metaDim]} numberOfLines={1}>
          {task.branch ? compactBranchName(task.branch.name) : "No branch"}
        </Text>
        {item.changeCount === undefined ? null : (
          <>
            <Text style={styles.metaSep}>·</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Review ${taskChangeLabel(item.changeCount)} for ${task.title}`}
              hitSlop={12}
              onPress={() => openChanges(task.id)}
            >
              <Text style={styles.metaSignal}>{taskChangeLabel(item.changeCount)}</Text>
            </Pressable>
          </>
        )}
      </View>
      {waiting && waitingAgent ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.agentActionLabel}: ${waitingAgent.title} for ${task.title}`}
          onPress={() => openAgent(waitingAgent.sessionId)}
          style={({ pressed }) => [styles.nextStep, { backgroundColor: toneWash[waiting.tone], borderColor: toneColor[waiting.tone] }, pressed ? styles.actionPressed : null]}
        >
          <Text style={[styles.nextStepGlyph, { color: toneColor[waiting.tone] }]} accessibilityElementsHidden>▶</Text>
          <Text style={[styles.nextStepLabel, { color: toneColor[waiting.tone] }]} numberOfLines={1}>
            {waiting.label} · open {waiting.agent}
          </Text>
        </Pressable>
      ) : null}
      {shownAgents.length === 0 ? null : (
        <View style={styles.children}>
          {shownAgents.map((agent) => {
            const agentLit = agent.tone !== "quiet" && agent.tone !== "done";
            const agentTint = agentLit ? toneColor[agent.tone] : color.textSecondary;
            const brand = agent.agentId === "claude" ? color.agentClaude : agent.agentId === "codex" ? color.agentCodex : color.accent;
            return (
              <Pressable
                key={agent.sessionId}
                accessibilityRole="button"
                accessibilityLabel={`Open ${agent.accessibleName}`}
                onPress={() => openAgent(agent.sessionId)}
                style={({ pressed }) => [styles.agentRow, pressed ? styles.pressed : null]}
              >
                <View style={[styles.agentDot, { backgroundColor: brand }, agentLit ? { borderColor: agentTint } : null]} />
                <Text style={styles.agentName} numberOfLines={1}>{agent.title}</Text>
                <Text style={[styles.agentState, { color: agentTint }]} numberOfLines={1}>{agent.stateLabel}</Text>
              </Pressable>
            );
          })}
          {agents.length > shownAgents.length ? (
            <Text style={styles.moreAgents}>+{agents.length - shownAgents.length} more — open the task</Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  screen: { flex: 1 },
  toolbar: { gap: space.md, paddingBottom: space.xs },
  heading: { flexDirection: "row", alignItems: "center", gap: space.sm },
  headingCopy: { flex: 1 },
  title: { color: color.text, fontSize: 23, fontWeight: "700", letterSpacing: -0.6 },
  subtitle: { color: color.textSecondary, fontSize: 12, marginTop: 4 },
  templates: { minHeight: geometry.touchTarget, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: space.sm },
  templatesLabel: { color: color.accentStrong, fontSize: 13, fontWeight: "600" },
  templatesArrow: { color: color.accentStrong, fontSize: 15 },
  search: { minHeight: 46, flexDirection: "row", alignItems: "center", backgroundColor: color.bgRaised, borderRadius: radius.card, borderWidth: 1, borderColor: color.border },
  searchInput: { flex: 1, minWidth: 0, minHeight: 46, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 14, color: color.text },
  clear: { minWidth: geometry.touchTarget, minHeight: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  clearGlyph: { fontSize: 22, color: color.textSecondary },
  filters: { flexGrow: 0 },
  filterContent: { gap: 6 },
  filter: { minHeight: geometry.touchTarget, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: color.bgRaised, borderWidth: 1, borderColor: "transparent" },
  filterDot: { width: 6, height: 6, borderRadius: 3 },
  filterSelected: { backgroundColor: color.accentStrong },
  filterLabel: { fontSize: 13, fontWeight: "600", color: color.textSecondary },
  filterCount: { fontSize: 12, fontVariant: ["tabular-nums"], color: color.textMuted },
  filterLabelSelected: { color: color.onAccent },
  resultCount: { color: color.textSecondary, fontSize: 12 },
  listContent: { padding: space.screen, paddingTop: space.md, paddingBottom: space.xl + 64, gap: space.sm, flexGrow: 1 },
  card: { backgroundColor: color.bgRaised, borderRadius: radius.card, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: color.border, borderLeftWidth: radius.spine, borderLeftColor: color.border },
  cardMain: { paddingHorizontal: space.md, paddingVertical: 4, gap: 4 },
  ids: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 20, paddingHorizontal: space.md, paddingTop: 10 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  dot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.5, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } },
  key: { color: color.warning, fontFamily: fontFamily.mono, fontSize: 11.5, fontWeight: "700" },
  pill: { flexShrink: 1, paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
  pillLabel: { fontSize: 10.5, fontWeight: "700", letterSpacing: 0.2 },
  scope: { flexShrink: 1, maxWidth: 110, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: color.borderStrong, color: color.textSecondary, fontSize: 10, fontWeight: "600" },
  chevron: { color: color.textMuted, fontSize: 20, lineHeight: 20 },
  cardTitle: { flex: 1, color: color.text, fontSize: 15, fontWeight: "600", lineHeight: 20, letterSpacing: -0.2 },
  brief: { color: color.textSecondary, fontSize: 12.5, lineHeight: 17 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.md, paddingTop: 2, paddingBottom: 10 },
  metaBranch: { flexShrink: 1, color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 11 },
  metaDim: { color: color.textMuted },
  metaSep: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  metaSignal: { color: color.accent, fontFamily: fontFamily.mono, fontSize: 11, fontWeight: "600" },
  nextStep: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40, marginHorizontal: space.md, marginBottom: 10, paddingHorizontal: space.md, borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth },
  nextStepGlyph: { fontSize: 10 },
  nextStepLabel: { flex: 1, fontSize: 13, fontWeight: "700" },
  children: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.rule, paddingVertical: 2 },
  agentRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: geometry.touchTarget, paddingHorizontal: space.md },
  agentDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: "transparent" },
  agentName: { flex: 1, minWidth: 0, color: color.text, fontSize: 13, fontWeight: "500" },
  agentState: { maxWidth: "45%", fontSize: 11.5, fontWeight: "600" },
  moreAgents: { color: color.textMuted, fontSize: 11.5, paddingHorizontal: space.md, paddingBottom: 8, paddingLeft: space.md + 19 },
  actionPressed: { opacity: 0.75 },
  pressed: { backgroundColor: color.accentWash },
}));
