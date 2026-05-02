import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
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
import { pingConnection, type HealthStatus } from "../lib/connection-health";
import {
  clearConnectionSecrets,
  connectionNeedsReauth,
  deleteConnection,
  listConnections,
  markConnected,
  type SavedConnection,
} from "../lib/connections";
import { CONNECT_MOBILE_HINT, friendlyTransportError } from "../lib/errors";
import {
  clearLastConnection,
  getLastConnection,
  saveLastConnection,
} from "../lib/last-connection";
import {
  clearLastTerminal,
} from "../lib/last-terminal";
import { openSession } from "../lib/session";
import { colors, radii } from "../lib/theme";
import { RpcCallError } from "../lib/termloop-client";

interface Row {
  conn: SavedConnection;
  lastLabel: string;
  health: HealthStatus;
}

type ConnectionStatus = "paired" | "password" | "reauth";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  paired: "PAIRED",
  password: "PASSWORD",
  reauth: "NEEDS RE-PAIRING",
};

const HEALTH_LABEL: Record<HealthStatus, string> = {
  unknown: "Checking…",
  online: "Online",
  offline: "Offline",
  needs_reauth: "Needs re-pairing",
};

const HEALTH_DOT: Record<HealthStatus, string> = {
  unknown: colors.sub,
  online: colors.success,
  offline: colors.danger,
  needs_reauth: colors.danger,
};

const ItemSep = () => <View style={styles.cardGap} />;

export default function ConnectionListScreen() {
  const router = useRouter();
  const [items, setItems] = useState<SavedConnection[] | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthStatus>>({});
  // Once per mount: a failed auto-connect must not retry on re-focus.
  const autoTriedRef = useRef(false);
  const onConnectRef = useRef<(c: SavedConnection) => void>(() => {});
  const connectingIdRef = useRef<string | null>(null);
  connectingIdRef.current = connectingId;

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listConnections()
        .then(async (list) => {
          if (!alive) return;
          setItems((prev) => (sameIds(prev, list) ? prev : list));
          for (const c of list) {
            if (connectionNeedsReauth(c)) continue;
            pingConnection(c)
              .then((res) => {
                if (!alive) return;
                const next: HealthStatus = res.ok ? "online" : "offline";
                setHealth((prev) =>
                  prev[c.id] === next ? prev : { ...prev, [c.id]: next }
                );
              })
              .catch(() => {
                if (!alive) return;
                setHealth((prev) =>
                  prev[c.id] === "offline"
                    ? prev
                    : { ...prev, [c.id]: "offline" }
                );
              });
          }
          if (autoTriedRef.current) return;
          const lastId = await getLastConnection().catch(() => null);
          if (!alive || !lastId) return;
          const target = list.find((c) => c.id === lastId);
          if (!target) {
            await clearLastConnection().catch(() => {});
            return;
          }
          if (connectionNeedsReauth(target)) return;
          if (connectingIdRef.current) return;
          autoTriedRef.current = true;
          onConnectRef.current(target);
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
          ? `Last connected ${formatConnectionTime(conn.lastConnectedAt)}`
          : "Never connected",
        health: connectionNeedsReauth(conn)
          ? "needs_reauth"
          : (health[conn.id] ?? "unknown"),
      })),
    [items, health]
  );
  const connectingConn = useMemo(
    () => rows.find((row) => row.conn.id === connectingId)?.conn ?? null,
    [connectingId, rows]
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
        await openSession(conn);
        await markConnected(conn.id);
        await saveLastConnection(conn.id).catch(() => {});
        router.push("/connected");
      } catch (err) {
        const tokenRejected =
          err instanceof RpcCallError &&
          (err.code === "invalid_token" ||
            err.code === "unauthorized" ||
            err.code === "auth_failed" ||
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

  onConnectRef.current = onConnect;

  const onDelete = useCallback((conn: SavedConnection) => {
    Alert.alert("Delete connection?", conn.name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteConnection(conn.id);
          await clearLastTerminal(conn.id).catch(() => {});
          const lastId = await getLastConnection().catch(() => null);
          if (lastId === conn.id) {
            await clearLastConnection().catch(() => {});
            autoTriedRef.current = false;
          }
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
      <View style={styles.pairingPanel}>
        <View style={styles.pairingCopy}>
          <Text style={styles.eyebrow}>TermLoop Mobile</Text>
          <Text style={styles.pairingTitle}>Connect to your Mac</Text>
          <Text style={styles.pairingHint}>
            Scan the QR from TermLoop to pair this device and resume sessions.
          </Text>
        </View>
        <Pressable
          style={[styles.primaryBtn, connectingId && styles.controlDisabled]}
          onPress={() => router.push("/connections/scan")}
          disabled={connectingId !== null}
        >
          <Text style={styles.primaryBtnText}>Scan pairing QR</Text>
        </Pressable>
        <Pressable
          style={[styles.manualLink, connectingId && styles.controlDisabled]}
          onPress={() => router.push("/connections/new")}
          disabled={connectingId !== null}
        >
          <Text style={styles.manualLinkText}>Manual setup fallback</Text>
        </Pressable>
      </View>

      {connectingConn ? (
        <View style={styles.connectingBanner}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.connectingBannerText} numberOfLines={1}>
            Connecting to {connectingConn.serverName || connectingConn.name}
          </Text>
        </View>
      ) : null}

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
                    item.health === "offline" && styles.cardOffline,
                    item.health === "needs_reauth" && styles.cardReauth,
                    isConnecting && styles.cardConnecting,
                    pressed && styles.cardPressed,
                  ]}
                  onPress={() => onConnect(item.conn)}
                  disabled={connectingId !== null}
                >
                  <View style={styles.cardHeader}>
                    <View style={styles.rowTitleWrap}>
                      <View style={styles.rowTitleLine}>
                        <View
                          style={[
                            styles.healthDot,
                            { backgroundColor: HEALTH_DOT[item.health] },
                          ]}
                        />
                        <Text style={styles.rowName} numberOfLines={1}>
                          {item.conn.serverName || item.conn.name}
                        </Text>
                      </View>
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {item.conn.host}:{item.conn.port}
                      </Text>
                    </View>
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
                  <View style={styles.healthRow}>
                    <Text style={styles.healthLabel}>
                      {HEALTH_LABEL[item.health]}
                    </Text>
                    <Text style={styles.healthHint} numberOfLines={1}>
                      · {item.lastLabel}
                    </Text>
                    {item.health === "offline" ? (
                      <Text style={styles.healthHint} numberOfLines={1}>
                        · {CONNECT_MOBILE_HINT}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.cardActions}>
                    {isConnecting ? (
                      <View style={styles.connectingInline}>
                        <ActivityIndicator color={colors.primary} />
                        <Text style={styles.connectingInlineText}>
                          Connecting…
                        </Text>
                      </View>
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

function formatConnectionTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  pairingPanel: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pairingCopy: { gap: 3 },
  eyebrow: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  pairingTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  pairingHint: { color: colors.sub, fontSize: 12, lineHeight: 17 },
  primaryBtn: {
    paddingVertical: 14,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
  },
  primaryBtnText: {
    color: colors.onPrimary,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0,
  },
  manualLink: {
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  manualLinkText: {
    color: colors.label,
    fontSize: 12,
    fontWeight: "600",
  },
  controlDisabled: { opacity: 0.55 },
  connectingBanner: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  connectingBannerText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },

  empty: { alignItems: "center", paddingHorizontal: 24, paddingTop: 36, gap: 10 },
  emptyBadge: {
    width: 54,
    height: 54,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyBadgeText: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
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
    letterSpacing: 0,
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
  cardConnecting: {
    borderColor: colors.borderAccent,
    backgroundColor: colors.bgRaised,
  },
  cardOffline: {
    borderColor: colors.dangerBorder,
  },
  cardReauth: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerDim,
  },
  cardPressed: { backgroundColor: colors.bgRaised, borderColor: colors.borderStrong },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  rowTitleWrap: { flex: 1, minWidth: 0, gap: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "700", flex: 1 },
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
  connectingInline: { flexDirection: "row", alignItems: "center", gap: 8 },
  connectingInlineText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "600",
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
  statusPillText: { fontSize: 10, fontWeight: "700", letterSpacing: 0 },
  statusPairedText: { color: colors.success },
  statusPasswordText: { color: colors.sub },
  statusReauthText: { color: colors.danger },
  reauthHint: { color: colors.danger, fontSize: 12, fontWeight: "500" },

  healthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  healthDot: { width: 6, height: 6, borderRadius: 3 },
  healthLabel: { color: colors.sub, fontSize: 11, fontWeight: "500" },
  healthHint: { color: colors.hint, fontSize: 11, flexShrink: 1 },
});
