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
  clearConnectionSecrets,
  connectionNeedsReauth,
  deleteConnection,
  listConnections,
  markConnected,
  type SavedConnection,
} from "../lib/connections";
import { friendlyTransportError } from "../lib/errors";
import { openSession } from "../lib/session";
import { colors, radii } from "../lib/theme";
import { RpcCallError } from "../lib/termloop-client";

interface Row {
  conn: SavedConnection;
  lastLabel: string;
}

type ConnectionStatus = "paired" | "password" | "reauth";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  paired: "PAIRED",
  password: "PASSWORD",
  reauth: "NEEDS RE-PAIRING",
};

const ItemSep = () => <View style={styles.cardGap} />;

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
      if (connectionNeedsReauth(conn)) {
        Alert.alert(
          conn.deviceId ? "Needs re-pairing" : "No password saved",
          conn.deviceId
            ? `${conn.serverName || conn.name} was paired but the access token is missing from this device. ` +
                `Re-pair from Mac to restore access.`
            : `${conn.name} has no saved password. Use Manual setup to enter it again, ` +
                `or pair via QR.`
        );
        return;
      }

      setConnectingId(conn.id);
      try {
        const { client } = await openSession(conn);
        const pong = await client.ping();
        if (!pong.pong) throw new Error("ping failed");
        await markConnected(conn.id);
        router.push("/connected");
      } catch (err) {
        const tokenRejected =
          err instanceof RpcCallError &&
          (err.code === "invalid_token" ||
            err.code === "unauthorized" ||
            err.code === "not_found");

        if (tokenRejected && conn.accessToken) {
          await clearConnectionSecrets(conn.id);
          setItems(await listConnections());
          Alert.alert(
            "Pairing revoked",
            `${conn.serverName || conn.name} no longer recognizes this device. ` +
              `Re-pair from Mac via Scan pairing QR. The connection entry is kept for convenience.`
          );
        } else {
          Alert.alert("Connection failed", friendlyTransportError(err));
        }
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
          <View style={styles.emptyBadge}>
            <Text style={styles.emptyBadgeText}>QR</Text>
          </View>
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
            ItemSeparatorComponent={ItemSep}
            renderItem={({ item }) => {
              const isConnecting = connectingId === item.conn.id;
              const status: ConnectionStatus = connectionNeedsReauth(item.conn)
                ? "reauth"
                : item.conn.deviceId
                  ? "paired"
                  : "password";
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.card,
                    pressed && styles.cardPressed,
                  ]}
                  onPress={() => onConnect(item.conn)}
                  disabled={connectingId !== null}
                >
                  <View style={styles.cardHeader}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.conn.serverName || item.conn.name}
                    </Text>
                    <View
                      style={[
                        styles.statusPill,
                        status === "paired" && styles.statusPaired,
                        status === "password" && styles.statusPassword,
                        status === "reauth" && styles.statusReauth,
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusPillText,
                          status === "paired" && styles.statusPairedText,
                          status === "password" && styles.statusPasswordText,
                          status === "reauth" && styles.statusReauthText,
                        ]}
                      >
                        {STATUS_LABEL[status]}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.conn.host}:{item.conn.port}
                    {item.lastLabel}
                  </Text>
                  <View style={styles.cardActions}>
                    {isConnecting ? (
                      <ActivityIndicator color={colors.primary} />
                    ) : status === "reauth" ? (
                      <Text style={styles.reauthHint}>
                        Tap for re-pair instructions
                      </Text>
                    ) : (
                      <Text style={styles.connectHint}>Tap to connect</Text>
                    )}
                    <Pressable
                      onPress={() => onDelete(item.conn)}
                      style={styles.rowDelete}
                      hitSlop={8}
                    >
                      <Text style={styles.rowDeleteText}>Delete</Text>
                    </Pressable>
                  </View>
                </Pressable>
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
  ctaWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 },
  primaryBtn: {
    paddingVertical: 16,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  secondaryBtn: {
    paddingVertical: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: "center",
    backgroundColor: colors.bgElevated,
  },
  secondaryBtnText: { color: colors.label, fontSize: 14, fontWeight: "500" },

  empty: { alignItems: "center", paddingHorizontal: 24, paddingTop: 32, gap: 12 },
  emptyBadge: {
    width: 64,
    height: 64,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyBadgeText: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    marginTop: 4,
  },
  emptyHint: {
    color: colors.sub,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },

  listWrap: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  listLabel: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingBottom: 8,
  },

  cardGap: { height: 10 },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  cardPressed: { backgroundColor: colors.bgRaised, borderColor: colors.borderStrong },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  rowName: { color: colors.text, fontSize: 15, fontWeight: "600", flex: 1 },
  rowSub: { color: colors.sub, fontSize: 12 },

  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  connectHint: { color: colors.primary, fontSize: 12, fontWeight: "500" },
  rowDelete: { paddingHorizontal: 8, paddingVertical: 4 },
  rowDeleteText: { color: colors.danger, fontSize: 12, fontWeight: "500" },

  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusPaired: {
    backgroundColor: colors.successDim,
    borderColor: colors.successBorder,
  },
  statusPassword: {
    backgroundColor: colors.bgRaised,
    borderColor: colors.border,
  },
  statusReauth: {
    backgroundColor: colors.dangerDim,
    borderColor: colors.dangerBorder,
  },
  statusPillText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  statusPairedText: { color: colors.success },
  statusPasswordText: { color: colors.sub },
  statusReauthText: { color: colors.danger },
  reauthHint: { color: colors.danger, fontSize: 12, fontWeight: "500" },
});
