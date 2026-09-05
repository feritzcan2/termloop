import { Pressable, StyleSheet, Text, View } from "react-native";

import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export type WorkspaceTabId = "agents" | "tasks";

interface WorkspaceTab {
  readonly id: WorkspaceTabId;
  readonly label: string;
  readonly count: number;
  readonly attentionCount: number;
}

/// The Project-level peer navigation shared with desktop: Agents and Tasks are
/// two views of one workspace, not filters mixed into the content they control.
/// Touch geometry stays native while the selected wash, attention dot, and compact
/// count follow the desktop sidebar's visual grammar.
export function WorkspaceTabs({ selected, agents, tasks, select }: {
  selected: WorkspaceTabId;
  agents: Pick<WorkspaceTab, "count" | "attentionCount">;
  tasks: Pick<WorkspaceTab, "count" | "attentionCount">;
  select: (tab: WorkspaceTabId) => void;
}) {
  const tabs: readonly WorkspaceTab[] = [
    { id: "agents", label: "Agents", ...agents },
    { id: "tasks", label: "Tasks", ...tasks },
  ];
  return (
    <View style={styles.rail} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const active = selected === tab.id;
        return (
          <Pressable
            key={tab.id}
            onPress={() => select(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${tab.label}, ${tab.count}${tab.attentionCount > 0 ? `, ${tab.attentionCount} need attention` : ""}`}
            style={({ pressed }) => [
              styles.tab,
              active ? styles.tabSelected : null,
              pressed && !active ? styles.tabPressed : null,
            ]}
          >
            <Text style={[styles.glyph, active ? styles.glyphSelected : null]} accessibilityElementsHidden>
              {tab.id === "agents" ? "◇" : "▤"}
            </Text>
            <Text style={[styles.label, active ? styles.labelSelected : null]}>{tab.label}</Text>
            <View style={[styles.count, active ? styles.countSelected : null]}>
              <Text style={[styles.countLabel, active ? styles.countLabelSelected : null]}>{tab.count}</Text>
            </View>
            {tab.attentionCount > 0 ? <View style={styles.attention} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    flexDirection: "row",
    gap: space.xs,
    minHeight: geometry.touchTarget,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    borderRadius: radius.control,
    backgroundColor: color.bgSidebar,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: space.sm,
    borderRadius: 6,
  },
  tabPressed: { backgroundColor: color.bgHover },
  tabSelected: { backgroundColor: color.accentWash },
  glyph: { color: color.textMuted, fontSize: 15, lineHeight: 17 },
  glyphSelected: { color: color.accentStrong },
  label: {
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 12.5,
    fontWeight: "700",
  },
  labelSelected: { color: color.text },
  count: {
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: color.bgHover,
  },
  countSelected: { backgroundColor: color.accentWash },
  countLabel: {
    color: color.textMuted,
    fontFamily: fontFamily.mono,
    fontSize: 10.5,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  countLabelSelected: { color: color.accentStrong },
  attention: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.attention,
    shadowColor: color.attention,
    shadowOpacity: 0.45,
    shadowRadius: 4,
  },
});
