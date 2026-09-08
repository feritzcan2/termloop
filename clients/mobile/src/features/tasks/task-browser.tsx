import type { TaskDto } from "@termloop/contract/current";
import { useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { EmptyState, SecondaryButton } from "@/components/primitives";
import type { AgentRow, TaskRow } from "@/presentation/attention-overview";
import { buildTaskBrowserItems, filterTaskItems, taskFilters, type TaskBrowserItem, type TaskFilter } from "@/presentation/task-browser";
import { taskChangeLabel } from "@/presentation/task-presentation";
import { color, geometry, radius, space, toneColor } from "@/theme/tokens";
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
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const list = useRef<FlatList<TaskBrowserItem>>(null);
  const items = useMemo(() => buildTaskBrowserItems(props.rows, props.tasks, props.agents), [props.rows, props.tasks, props.agents]);
  const visible = useMemo(() => filterTaskItems(items, filter, query), [items, filter, query]);
  const resetScroll = () => list.current?.scrollToOffset({ offset: 0, animated: false });
  const reset = () => { setFilter("all"); setQuery(""); resetScroll(); };

  return (
    <View style={styles.screen}>
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
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${option.label}, ${count} tasks`}
                    accessibilityState={{ selected }}
                    onPress={() => { setFilter(option.id); resetScroll(); }}
                    style={[styles.filter, selected ? styles.filterSelected : null]}
                  >
                    <Text style={[styles.filterLabel, selected ? styles.filterLabelSelected : null]}>{option.label}</Text>
                    <Text style={[styles.filterCount, selected ? styles.filterLabelSelected : null]}>{count}</Text>
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
      <FlatList
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
    </View>
  );
}

function TaskCard({ item, openTask, openChanges, openAgent }: {
  item: TaskBrowserItem;
  openTask: TaskBrowserProps["openTask"];
  openChanges: TaskBrowserProps["openChanges"];
  openAgent: TaskBrowserProps["openAgent"];
}) {
  const { row, task, agent } = item;
  const tint = row.tone === "quiet" || row.tone === "done" ? color.textSecondary : toneColor[row.tone];
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${task.title}. ${item.status}. ${row.stage.summary}`}
        accessibilityHint="Open task details"
        onPress={() => openTask(task.id)}
        style={({ pressed }) => [styles.cardBody, pressed ? styles.pressed : null]}
      >
        <View style={styles.cardMeta}>
          <View style={styles.status}>
            <View style={[styles.statusDot, { backgroundColor: tint }]} />
            <Text style={[styles.statusLabel, { color: tint }]}>{item.status}</Text>
          </View>
          {item.issueKey ? <Text style={styles.issue} numberOfLines={1}>{item.issueKey}</Text> : null}
        </View>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={3}>{task.title}</Text>
          <Text style={styles.chevron} accessibilityElementsHidden>›</Text>
        </View>
        <Text style={styles.cardDetail} numberOfLines={2}>
          {row.stage.id !== "ready" ? row.stage.summary : task.brief?.trim() || "Open this task to see its agents and progress."}
        </Text>
        {task.branch === null ? null : <Text style={styles.branch} numberOfLines={1}>{task.branch.name}</Text>}
      </Pressable>
      {agent === undefined && item.changeCount === undefined ? null : (
        <View style={styles.cardActions}>
          {agent === undefined ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${agent.title} for ${task.title}`} onPress={() => openAgent(agent.sessionId)} style={({ pressed }) => [styles.cardAction, pressed ? styles.pressed : null]}>
              <Text style={styles.agentAction} numberOfLines={1}>{row.attention?.tone === "attention" ? "Reply to agent" : row.attention?.tone === "review" ? "Review agent" : "Open agent"}</Text>
              <Text style={styles.actionArrow} accessibilityElementsHidden>↗</Text>
            </Pressable>
          )}
          {item.changeCount === undefined ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel={`Review ${taskChangeLabel(item.changeCount)} for ${task.title}`} onPress={() => openChanges(task.id)} style={({ pressed }) => [styles.cardAction, pressed ? styles.pressed : null]}>
              <Text style={styles.changesAction}>{taskChangeLabel(item.changeCount)}</Text>
              <Text style={styles.actionArrow} accessibilityElementsHidden>›</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  toolbar: { paddingTop: space.md, paddingHorizontal: space.screen, gap: space.md, paddingBottom: space.sm },
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
  filter: { minHeight: geometry.touchTarget, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: color.bgRaised },
  filterSelected: { backgroundColor: color.accentStrong },
  filterLabel: { fontSize: 13, fontWeight: "600", color: color.textSecondary },
  filterCount: { fontSize: 12, fontVariant: ["tabular-nums"], color: color.textMuted },
  filterLabelSelected: { color: color.onAccent },
  resultCount: { color: color.textSecondary, fontSize: 12 },
  listContent: { padding: space.screen, paddingTop: space.sm, paddingBottom: space.xl + 64, gap: space.md, flexGrow: 1 },
  card: { backgroundColor: color.bgRaised, borderRadius: 16, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  cardBody: { padding: space.lg, gap: 9 },
  cardMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  status: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  issue: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, maxWidth: "40%" },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardTitle: { flex: 1, color: color.text, fontSize: 17, fontWeight: "600", lineHeight: 23, letterSpacing: -0.2 },
  chevron: { color: color.textMuted, fontSize: 23 },
  cardDetail: { color: color.textSecondary, fontSize: 13, lineHeight: 19 },
  branch: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11, marginTop: 2 },
  cardActions: { flexDirection: "row", flexWrap: "wrap", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.rule },
  cardAction: { flexGrow: 1, minHeight: 48, paddingHorizontal: space.lg, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  agentAction: { color: color.accentStrong, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  changesAction: { color: color.textSecondary, fontSize: 13, fontWeight: "500" },
  actionArrow: { color: color.accentStrong, fontSize: 16 },
  pressed: { backgroundColor: color.accentWash },
});
