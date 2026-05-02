import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { saveLastTerminal } from "../../lib/last-terminal";
import {
  closeSession,
  getActiveAuth,
  getActiveClient,
  getActiveConnectionId,
} from "../../lib/session";
import {
  pickTerminalSurface,
  surfaceLabel,
  workspaceLabel,
  workspaceProjectId,
  type ProjectSummary,
  type WorkspaceSummary,
} from "../../lib/termloop-client";
import { colors, radii } from "../../lib/theme";

type ProjectState = ProjectSummary | null | "loading";

export default function ConnectedScreen() {
  const router = useRouter();
  const client = getActiveClient();
  const auth = getActiveAuth();
  const [current, setCurrent] = useState<ProjectState>("loading");
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      router.replace("/");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const [cur, ws] = await Promise.all([
          client.currentProject(),
          client.listWorkspaces(),
        ]);
        if (!alive) return;
        setCurrent(cur);
        setWorkspaces(ws);
      } catch (err) {
        if (alive)
          Alert.alert("Failed to load", String((err as Error).message ?? err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, router]);

  const onDisconnect = async () => {
    await closeSession();
    router.replace("/");
  };

  const openProjectPicker = async () => {
    if (!client) return;
    setPickerOpen(true);
    if (projects === null) {
      try {
        const list = await client.listProjects();
        setProjects(list);
      } catch (err) {
        Alert.alert(
          "Failed to load projects",
          String((err as Error).message ?? err)
        );
        setProjects([]);
      }
    }
  };

  const onPickProject = async (p: ProjectSummary) => {
    if (!client) return;
    if (current !== "loading" && current?.id === p.id) {
      setPickerOpen(false);
      return;
    }
    setSwitchingId(p.id);
    try {
      await client.switchProject(p.id);
      const [cur, ws] = await Promise.all([
        client.currentProject(),
        client.listWorkspaces(),
      ]);
      setCurrent(cur);
      setWorkspaces(ws);
      // Force a fresh project list on next picker open — the Mac may have
      // added/renamed projects since first fetch.
      setProjects(null);
      setPickerOpen(false);
    } catch (err) {
      Alert.alert(
        "Failed to switch project",
        String((err as Error).message ?? err)
      );
    } finally {
      setSwitchingId(null);
    }
  };

  const onOpenWorkspace = async (ws: WorkspaceSummary) => {
    if (!client) return;
    setOpeningId(ws.id);
    try {
      const surfaces = await client.listSurfaces(ws.id);
      const surface = pickTerminalSurface(surfaces);
      if (!surface) {
        Alert.alert(
          "No terminal surface",
          surfaces.length === 0
            ? `Workspace "${workspaceLabel(ws)}" has no surfaces yet.`
            : `Workspace "${workspaceLabel(ws)}" has no terminal surface to open.`
        );
        return;
      }
      const wsName = workspaceLabel(ws);
      const surfaceName = surfaceLabel(surface);
      const connectionId = getActiveConnectionId();
      if (connectionId) {
        await saveLastTerminal({
          connectionId,
          workspaceId: ws.id,
          surfaceId: surface.id,
          workspaceName: wsName,
          surfaceName,
        }).catch(() => {});
      }
      router.push({
        pathname: "/connected/terminal",
        params: {
          workspaceId: ws.id,
          surfaceId: surface.id,
          name: wsName,
          surfaceName,
        },
      });
    } catch (err) {
      Alert.alert(
        "Failed to open",
        String((err as Error).message ?? err)
      );
    } finally {
      setOpeningId(null);
    }
  };

  const projectFilterId =
    current === "loading" || current === null ? null : current.id;

  const visibleWorkspaces = useMemo<WorkspaceSummary[] | null>(() => {
    if (workspaces === null) return null;
    if (!projectFilterId) return workspaces;
    return workspaces.filter(
      (ws) => workspaceProjectId(ws) === projectFilterId
    );
  }, [workspaces, projectFilterId]);

  if (!client) return null;

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <View style={styles.headerCard}>
        {auth?.server_name ? (
          <View style={styles.headerRow}>
            <View style={styles.statusDot} />
            <View style={styles.headerTextWrap}>
              <Text style={styles.sectionLabel}>Connected to</Text>
              <Text style={styles.bigText} numberOfLines={1}>
                {auth.server_name}
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.projectCard,
          pressed && styles.projectCardPressed,
        ]}
        onPress={openProjectPicker}
        disabled={current === "loading"}
      >
        <View style={styles.projectLabelRow}>
          <Text style={styles.sectionLabel}>Current project</Text>
          <Text style={styles.projectChevron}>Change ›</Text>
        </View>
        <Text style={styles.bigText} numberOfLines={1}>
          {current === "loading" ? "…" : current ? current.name : "(none)"}
        </Text>
        {current !== "loading" && current?.path ? (
          <Text style={styles.projectPath} numberOfLines={1}>
            {current.path}
          </Text>
        ) : null}
      </Pressable>

      <View style={styles.workspacesWrap}>
        <View style={styles.workspacesHeader}>
          <Text style={styles.sectionLabel}>Workspaces</Text>
          {projectFilterId && workspaces && visibleWorkspaces ? (
            <Text style={styles.workspacesHint}>
              {visibleWorkspaces.length} of {workspaces.length} in current project
            </Text>
          ) : null}
        </View>
        {visibleWorkspaces === null ? (
          <ActivityIndicator />
        ) : (
          <FlatList
            data={visibleWorkspaces}
            keyExtractor={(w) => w.id}
            ListEmptyComponent={
              <Text style={styles.empty}>No workspaces.</Text>
            }
            renderItem={({ item }) => {
              const isOpening = openingId === item.id;
              return (
                <Pressable
                  style={styles.wsRow}
                  onPress={() => onOpenWorkspace(item)}
                  disabled={openingId !== null}
                >
                  <View style={styles.wsTextWrap}>
                    <Text style={styles.wsName} numberOfLines={1}>
                      {workspaceLabel(item)}
                    </Text>
                    {item.agent ? (
                      <Text style={styles.wsSub} numberOfLines={1}>
                        {item.agent}
                      </Text>
                    ) : null}
                  </View>
                  {isOpening && <ActivityIndicator />}
                </Pressable>
              );
            }}
          />
        )}
      </View>

      <Pressable style={styles.disconnectBtn} onPress={onDisconnect}>
        <Text style={styles.disconnectText}>Disconnect</Text>
      </Pressable>

      <Modal
        animationType="slide"
        transparent
        visible={pickerOpen}
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setPickerOpen(false)}
        >
          <Pressable style={styles.modalSheet} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Switch project</Text>
            {projects === null ? (
              <ActivityIndicator style={{ marginVertical: 24 }} />
            ) : projects.length === 0 ? (
              <Text style={styles.empty}>No projects available.</Text>
            ) : (
              <FlatList
                data={projects}
                keyExtractor={(p) => p.id}
                renderItem={({ item }) => {
                  const isCurrent =
                    current !== "loading" && current?.id === item.id;
                  const isSwitching = switchingId === item.id;
                  return (
                    <Pressable
                      style={styles.projectItem}
                      onPress={() => onPickProject(item)}
                      disabled={switchingId !== null}
                    >
                      <View style={styles.wsTextWrap}>
                        <Text style={styles.wsName} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {item.path ? (
                          <Text style={styles.wsSub} numberOfLines={1}>
                            {item.path}
                          </Text>
                        ) : null}
                      </View>
                      {isSwitching ? (
                        <ActivityIndicator />
                      ) : isCurrent ? (
                        <Text style={styles.projectCurrent}>Current</Text>
                      ) : null}
                    </Pressable>
                  );
                }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 12 },

  sectionLabel: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  bigText: { color: colors.text, fontSize: 18, fontWeight: "600" },

  headerCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  headerTextWrap: { flex: 1, gap: 2 },

  projectCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  projectCardPressed: {
    backgroundColor: colors.bgRaised,
    borderColor: colors.borderStrong,
  },
  projectLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  projectChevron: { color: colors.primary, fontSize: 13, fontWeight: "500" },
  projectPath: { color: colors.sub, fontSize: 12 },

  workspacesWrap: { flex: 1, gap: 8 },
  workspacesHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  workspacesHint: { color: colors.hint, fontSize: 11 },

  empty: { color: colors.hint, fontSize: 13, paddingVertical: 12 },

  wsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  wsTextWrap: { flex: 1, minWidth: 0 },
  wsName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  wsSub: { color: colors.sub, fontSize: 12, marginTop: 2 },

  disconnectBtn: {
    paddingVertical: 12,
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.dangerDim,
    backgroundColor: colors.dangerDim,
  },
  disconnectText: { color: colors.danger, fontSize: 14, fontWeight: "500" },

  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    maxHeight: "70%",
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: 12,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginBottom: 12,
  },
  projectItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  projectCurrent: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.successDim,
    borderWidth: 1,
    borderColor: colors.successBorder,
    overflow: "hidden",
  },
});
