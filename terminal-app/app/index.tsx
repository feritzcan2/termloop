import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
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
  deleteConnection,
  listConnections,
  markConnected,
  type SavedConnection,
} from "../lib/connections";
import { openSession } from "../lib/session";
import { colors } from "../lib/theme";

interface Row {
  conn: SavedConnection;
  lastLabel: string;
}

export default function ConnectionListScreen() {
  const router = useRouter();
  const [items, setItems] = useState<SavedConnection[] | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listConnections()
        .then((list) => {
          if (!alive) return;
          setItems((prev) => (sameIds(prev, list) ? prev : list));
        })
        .catch(() => {
          if (alive) setItems([]);
        });
      return () => {
        alive = false;
      };
    }, [])
  );

  const rows = useMemo<Row[]>(
    () =>
      (items ?? []).map((conn) => ({
        conn,
        lastLabel: conn.lastConnectedAt
          ? ` · last ${new Date(conn.lastConnectedAt).toLocaleString()}`
          : "",
      })),
    [items]
  );

  const onConnect = useCallback(
    async (conn: SavedConnection) => {
      setConnectingId(conn.id);
      try {
        const { client } = await openSession(conn);
        const pong = await client.ping();
        if (!pong.pong) throw new Error("ping failed");
        await markConnected(conn.id);
        router.push("/connected");
      } catch (err) {
        Alert.alert("Connection failed", String((err as Error).message ?? err));
      } finally {
        setConnectingId(null);
      }
    },
    [router]
  );

  const onDelete = useCallback((conn: SavedConnection) => {
    Alert.alert("Delete connection?", conn.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteConnection(conn.id);
          setItems(await listConnections());
        },
      },
    ]);
  }, []);

  if (items === null) {
    return (
      <SafeAreaView style={styles.center} edges={["bottom"]}>
        <ActivityIndicator />
      </SafeAreaView>
    );
  }

  const empty = rows.length === 0;

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <View style={styles.ctaWrap}>
        <Pressable
          style={styles.primaryBtn}
          onPress={() => router.push("/connections/scan")}
        >
          <Text style={styles.primaryBtnText}>Scan pairing QR</Text>
        </Pressable>
        <Pressable
          style={styles.secondaryBtn}
          onPress={() => router.push("/connections/new")}
        >
          <Text style={styles.secondaryBtnText}>Manual setup</Text>
        </Pressable>
      </View>

      {empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Pair with TermLoop on your Mac</Text>
          <Text style={styles.emptyHint}>
            Open TermLoop, choose Pair Mobile, and scan the QR code shown there.
          </Text>
        </View>
      ) : (
        <View style={styles.listWrap}>
          <Text style={styles.listLabel}>Saved connections</Text>
          <FlatList
            data={rows}
            keyExtractor={(r) => r.conn.id}
            renderItem={({ item }) => {
              const isConnecting = connectingId === item.conn.id;
              return (
                <View style={styles.row}>
                  <Pressable
                    style={styles.rowMain}
                    onPress={() => onConnect(item.conn)}
                    disabled={connectingId !== null}
                  >
                    <Text style={styles.rowName}>
                      {item.conn.serverName || item.conn.name}
                    </Text>
                    <Text style={styles.rowSub}>
                      {item.conn.host}:{item.conn.port}
                      {item.lastLabel}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => onDelete(item.conn)}
                    style={styles.rowDelete}
                    hitSlop={8}
                  >
                    <Text style={styles.rowDeleteText}>Delete</Text>
                  </Pressable>
                  {isConnecting && <ActivityIndicator style={styles.rowSpinner} />}
                </View>
              );
            }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

function sameIds(
  a: SavedConnection[] | null,
  b: SavedConnection[]
): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].lastConnectedAt !== b[i].lastConnectedAt) {
      return false;
    }
  }
  return true;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  ctaWrap: { padding: 16, gap: 8 },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  secondaryBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center",
  },
  secondaryBtnText: { color: colors.label, fontSize: 14, fontWeight: "500" },
  empty: { alignItems: "center", padding: 24, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: "500" },
  emptyHint: { color: colors.sub, fontSize: 13, textAlign: "center" },
  listWrap: { flex: 1, paddingHorizontal: 16 },
  listLabel: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingVertical: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowMain: { flex: 1 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "500" },
  rowSub: { color: colors.sub, fontSize: 12, marginTop: 2 },
  rowDelete: { paddingHorizontal: 8, paddingVertical: 6 },
  rowDeleteText: { color: colors.danger, fontSize: 13 },
  rowSpinner: { marginLeft: 8 },
});
