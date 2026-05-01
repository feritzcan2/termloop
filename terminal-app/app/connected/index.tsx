import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  closeSession,
  getActiveAuth,
  getActiveClient,
} from "../../lib/session";
import {
  pickPrimarySurface,
  workspaceLabel,
  workspaceProjectId,
  type ProjectSummary,
  type WorkspaceSummary,
} from "../../lib/termloop-client";
import { colors } from "../../lib/theme";

type ProjectState = ProjectSummary | null | "loading";

export default function ConnectedScreen() {
  const router = useRouter();
  const client = getActiveClient();
  const auth = getActiveAuth();
  const [current, setCurrent] = useState<ProjectState>("loading");
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

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

  const onOpenWorkspace = async (ws: WorkspaceSummary) => {
    if (!client) return;
    setOpeningId(ws.id);
    try {
      const surfaces = await client.listSurfaces(ws.id);
      const surface = pickPrimarySurface(surfaces);
      if (!surface) {
        Alert.alert(
          "No surfaces",
          `Workspace "${workspaceLabel(ws)}" has no surfaces yet.`
        );
        return;
      }
      router.push({
        pathname: "/connected/terminal",
        params: {
          workspaceId: ws.id,
          surfaceId: surface.id,
          name: workspaceLabel(ws),
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
      {auth?.server_name ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Server</Text>
          <Text style={styles.bigText}>{auth.server_name}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Current project</Text>
        <Text style={styles.bigText}>
          {current === "loading" ? "…" : current ? current.name : "(none)"}
        </Text>
      </View>

      <View style={[styles.section, { flex: 1 }]}>
        <View style={styles.workspacesHeader}>
          <Text style={styles.sectionLabel}>Workspaces</Text>
          {projectFilterId && workspaces && visibleWorkspaces ? (
            <Text style={styles.workspacesHint}>
              {visibleWorkspaces.length} of {workspaces.length} for current project
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  section: { marginBottom: 16 },
  sectionLabel: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  bigText: { color: colors.text, fontSize: 18, fontWeight: "500" },
  workspacesHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  workspacesHint: { color: colors.hint, fontSize: 11 },
  empty: { color: colors.hint, fontSize: 13, paddingVertical: 12 },
  wsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  wsTextWrap: { flex: 1, minWidth: 0 },
  wsName: { color: colors.text, fontSize: 15, fontWeight: "500" },
  wsSub: { color: colors.sub, fontSize: 12, marginTop: 2 },
  disconnectBtn: { paddingVertical: 12, alignItems: "center" },
  disconnectText: { color: colors.danger, fontSize: 14 },
});
