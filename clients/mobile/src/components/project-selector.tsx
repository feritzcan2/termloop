import { useRouter } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { StatusDot } from "@/components/primitives";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { buildLocatedProjectSummaries } from "@/presentation/attention-overview";
import type { ProjectSummary } from "@/presentation/attention-overview";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { projectSelectorGroups } from "@/presentation/project-selector-model";
import { color, geometry, radius, space, toneColor } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The persistent Project switch, in the header of every Project-scoped screen.
///
/// It carries each Project's loudest tone, which is the one cross-Project read in the
/// client. Without it, switching Projects is a blind guess: the user leaves a screen
/// that told them exactly who was waiting and lands on a name.
///
/// Switching while attached to a terminal detaches that stream and lands on the new
/// Project's overview. Detach is not termination — the PTY keeps running on the Mac —
/// and the alternative, keeping a foreign Project's terminal open under a switched
/// header, is a screen that lies about its own scope.
export function ProjectSelector({ current, variant }: {
  current: ProjectSummary | undefined;
  /// `mini` hugs its content for the terminal's second header line, where the Session
  /// identity owns the primary row.
  variant?: "full" | "mini" | undefined;
}) {
  const router = useRouter();
  const connections = useConnections();
  const overview = useOverview();
  const [open, setOpen] = useState(false);
  const mini = variant === "mini";
  const label = current?.project.name ?? "All Projects";
  const projects = buildLocatedProjectSummaries(connections.connections.flatMap((connection) => {
    const snapshot = overview.byConnection.get(connection.id);
    return snapshot?.overview === undefined ? [] : [{
      connection,
      overview: snapshot.overview,
      reviewReadySessionIds: snapshot.reviewReadySessionIds,
    }];
  }));
  const groups = projectSelectorGroups(connections.connections, projects);

  return (
    <View style={mini ? styles.miniWrap : styles.wrap}>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Project ${label}. Switch project.`}
        accessibilityState={{ expanded: open }}
        style={[styles.trigger, mini && styles.triggerMini]}
      >
        <ProjectAvatar name={label} size={mini ? 17 : 21} />
        <Text style={[styles.triggerLabel, mini && styles.triggerLabelMini]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.chevron, mini && styles.chevronMini]}>⌄</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={styles.scrim}
          accessibilityRole="button"
          accessibilityLabel="Close project list"
          onPress={() => setOpen(false)}
        >
          <Pressable style={styles.menu} onPress={() => undefined}>
            <ScrollView bounces={false}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: current === undefined }}
                accessibilityLabel={`All Projects, ${projects.length} projects across ${connections.connections.length} computers`}
                onPress={() => {
                  setOpen(false);
                  if (current !== undefined) router.replace("/");
                }}
                style={({ pressed }) => [
                  styles.item,
                  current === undefined && styles.itemSelected,
                  pressed && current !== undefined ? styles.itemPressed : null,
                ]}
              >
                <ProjectAvatar name="All Projects" size={21} />
                <View style={styles.itemBody}>
                  <Text style={styles.itemTitle}>All Projects</Text>
                  <Text style={styles.itemDetail} numberOfLines={1}>
                    {projects.length} {projects.length === 1 ? "project" : "projects"} · {connections.connections.length} {connections.connections.length === 1 ? "computer" : "computers"}
                  </Text>
                </View>
              </Pressable>
              {groups.map(({ connection, projects: connectionProjects }) => {
                const presentation = connectionPresentation(connection.availability);
                return (
                  <View key={connection.id}>
                    <View style={styles.menuDivider} />
                    <View
                      style={styles.computerHeader}
                      accessibilityLabel={`${connection.name}, ${presentation.label}, ${connectionProjects.length} projects`}
                    >
                      <ProjectAvatar name={connection.name} size={19} />
                      <View style={styles.itemBody}>
                        <Text style={styles.computerName} numberOfLines={1}>{connection.name}</Text>
                        <Text style={styles.computerStatus} numberOfLines={1}>
                          {presentation.label} · {connectionProjects.length} {connectionProjects.length === 1 ? "project" : "projects"}
                        </Text>
                      </View>
                      <StatusDot kind={presentation.dot} />
                    </View>
                    {connectionProjects.length === 0 ? (
                      <View style={styles.emptyComputer}>
                        <Text style={styles.emptyComputerText}>
                          {connection.availability === "online"
                            ? "No projects on this Mac."
                            : `No cached projects. ${presentation.summary}`}
                        </Text>
                      </View>
                    ) : connectionProjects.map(({ summary }) => {
                      const selected = connection.id === connections.selectedId
                        && summary.project.id === current?.project.id;
                      return (
                        <Pressable
                          key={`${connection.id}:${summary.project.id}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${summary.project.name}, ${connection.name} üzerinde, ${summary.summaryLine}`}
                          onPress={() => {
                            setOpen(false);
                            if (!selected) {
                              connections.select(connection.id);
                              router.replace({
                                pathname: "/project/[projectId]",
                                params: { projectId: summary.project.id, connectionId: connection.id },
                              });
                            }
                          }}
                          style={({ pressed }) => [
                            styles.projectItem,
                            selected && styles.itemSelected,
                            pressed && !selected ? styles.itemPressed : null,
                          ]}
                        >
                          <ProjectAvatar name={summary.project.name} size={21} />
                          <View style={styles.itemBody}>
                            <Text style={styles.itemTitle} numberOfLines={1}>{summary.project.name}</Text>
                            <Text style={styles.itemDetail} numberOfLines={1}>{summary.summaryLine}</Text>
                          </View>
                          {summary.tone === "quiet" || summary.tone === "done" ? null : (
                            <View style={[styles.toneDot, { backgroundColor: toneColor[summary.tone] }]} />
                          )}
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/// Two letters of the Project name, so a switcher row is identifiable before it is
/// read. Derived rather than stored: a Project has no avatar in the domain and adding
/// one to durable state to decorate a menu would be the wrong place to put it.
export function ProjectAvatar({ name, size }: { name: string; size: number }) {
  const initials = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("") || "?";
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: Math.round(size / 4) }]}>
      <Text style={[styles.avatarText, { fontSize: Math.round(size * 0.42) }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /// `flex: 1` with a stretched trigger made the header one wide box with a chevron
  /// stranded at the far right. The control hugs its label instead, so the header reads
  /// as chevron, project, action rather than as a text field.
  wrap: { flex: 1, minWidth: 0, alignItems: "flex-start" },
  miniWrap: { alignSelf: "flex-start", maxWidth: "100%" },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    gap: 7,
    height: 34,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: radius.control,
    backgroundColor: color.bgHover,
  },
  /// Borderless on the terminal's second line. There the Session identity owns the
  /// primary row, and a second bordered pill under it reads as two competing controls.
  triggerMini: {
    height: 24,
    gap: 6,
    paddingLeft: 0,
    paddingRight: 4,
    backgroundColor: "transparent",
  },
  triggerLabel: {
    flexShrink: 1,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    fontWeight: "600",
  },
  triggerLabelMini: { fontSize: 11.5, color: color.textSecondary },
  chevron: { color: color.textMuted, fontSize: 14, lineHeight: 16 },
  chevronMini: { fontSize: 12 },
  scrim: { flex: 1, backgroundColor: color.scrim, paddingTop: 96, paddingHorizontal: space.md },
  menu: {
    maxHeight: "70%",
    padding: 5,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.card,
    backgroundColor: color.bgSidebar,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: geometry.touchTarget,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.control,
  },
  itemSelected: { backgroundColor: color.accentWash },
  itemPressed: { backgroundColor: color.bgHover },
  computerHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
  },
  computerName: { ...text.rowTitle, fontFamily: fontFamily.mono, fontSize: 12.5 },
  computerStatus: { color: color.textSecondary, fontSize: 10.5 },
  projectItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: geometry.touchTarget,
    marginLeft: 16,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
    borderRadius: radius.control,
  },
  emptyComputer: { minHeight: 32, justifyContent: "center", paddingLeft: 52, paddingRight: space.sm },
  emptyComputerText: { color: color.textMuted, fontSize: 10.5 },
  itemBody: { flex: 1, minWidth: 0, gap: 1 },
  itemTitle: { ...text.rowTitle, fontFamily: fontFamily.mono, fontSize: 13 },
  itemDetail: { color: color.textSecondary, fontSize: 11 },
  toneDot: { width: 7, height: 7, borderRadius: 4 },
  menuDivider: { height: StyleSheet.hairlineWidth, marginVertical: 4, marginHorizontal: 5, backgroundColor: color.border },
  /// Outlined and washed rather than filled, matching the agent avatar's language:
  /// identity chips are labels, and only true actions get the solid accent fill.
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: `${color.accent}66`,
    backgroundColor: color.accentWash,
  },
  avatarText: { color: color.accentStrong, fontFamily: fontFamily.mono, fontWeight: "800" },
});
