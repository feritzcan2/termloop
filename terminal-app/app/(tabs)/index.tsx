import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, StyleSheet, Pressable, Text, RefreshControl, Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection, isCompleteConnection } from '../../lib/types';
import { deleteConnection, getConnections, saveConnection } from '../../lib/connections';
import { deleteTermLoopPassword, deleteSshPassword, getTermLoopPassword } from '../../lib/secrets';
import { palette } from '../../lib/palette';

// Heuristic: if ssh.user is empty, this was created via new-termloop form
// (promoteLegacyTermLoop also leaves ssh.user = ''). Otherwise it's an SSH host.
function isTermLoopHost(c: Connection): boolean {
  return !c.ssh.user || c.ssh.user.trim() === '';
}

const AUTOCONNECT_WINDOW_MS = 24 * 60 * 60_000;

export default function HostsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [conns, setConns] = useState<Connection[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [autoconnectTarget, setAutoconnectTarget] = useState<Connection | null>(null);
  const autoconnectCancelledRef = useRef(false);
  const autoconnectDoneRef = useRef(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const all = await getConnections();
    setConns(all);
    setRefreshing(false);
    return all;
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Autoconnect: run once on first mount. Only fires for termloop hosts with a
  // stored password — SSH path relies on Alert.prompt and isn't safe to trigger
  // automatically yet. Gated behind EXPO_PUBLIC_AUTOCONNECT to let us land the
  // new UI first and verify the app launches clean before re-enabling.
  const autoconnectEnabled = process.env.EXPO_PUBLIC_AUTOCONNECT === '1';
  useEffect(() => {
    if (!autoconnectEnabled) return;
    if (autoconnectDoneRef.current) return;
    autoconnectDoneRef.current = true;
    (async () => {
      try {
        const all = await load();
        const recent = all
          .filter((c) => isCompleteConnection(c) && typeof c.lastConnected === 'number')
          .sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0))[0];
        if (!recent) return;
        if (!isTermLoopHost(recent)) return;
        if (Date.now() - (recent.lastConnected ?? 0) > AUTOCONNECT_WINDOW_MS) return;
        const pw = await getTermLoopPassword(recent.id);
        if (!pw) return;
        setAutoconnectTarget(recent);
        setTimeout(() => {
          if (autoconnectCancelledRef.current) return;
          try {
            openConnection(recent, { markAutoconnect: true });
          } catch (e) {
            console.warn('[autoconnect] openConnection threw', e);
            setAutoconnectTarget(null);
          }
        }, 1200);
      } catch (e) {
        console.warn('[autoconnect] failed', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoconnectEnabled]);

  function cancelAutoconnect() {
    autoconnectCancelledRef.current = true;
    setAutoconnectTarget(null);
  }

  function openConnection(c: Connection, opts?: { markAutoconnect?: boolean }) {
    if (!opts?.markAutoconnect) {
      cancelAutoconnect();
    }
    if (!isCompleteConnection(c)) {
      router.push({ pathname: '/connection/new', params: { id: c.id } });
      return;
    }
    // Tap implies intent — stamp lastConnected so autoconnect picks it up next launch.
    saveConnection({ ...c, lastConnected: Date.now() }).catch(() => {});

    // Route every connection through /connection/[id]. That screen already
    // handles the termloop flow and provides controlled entry points into SSH
    // (Open Shell / Teleport). Routing directly to /terminal/[id] from here
    // can trigger Citadel/NIO precondition crashes on some devices — avoid.
    router.push({ pathname: '/connection/[id]', params: { id: c.id } });
  }

  function confirmDelete(c: Connection) {
    Alert.alert('Delete connection?', c.label || c.host, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await deleteConnection(c.id);
          await deleteSshPassword(c.id);
          await deleteTermLoopPassword(c.id);
          await load();
        },
      },
    ]);
  }

  const { termloopHosts, sshHosts } = useMemo(() => {
    const termloop: Connection[] = [];
    const ssh: Connection[] = [];
    for (const c of conns) {
      (isTermLoopHost(c) ? termloop : ssh).push(c);
    }
    const byRecency = (a: Connection, b: Connection) =>
      (b.lastConnected ?? 0) - (a.lastConnected ?? 0);
    termloop.sort(byRecency);
    ssh.sort(byRecency);
    return { termloopHosts: termloop, sshHosts: ssh };
  }, [conns]);

  const runningCount = useMemo(() => {
    const now = Date.now();
    return conns.filter((c) => c.lastConnected && now - c.lastConnected < 5 * 60_000).length;
  }, [conns]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {autoconnectTarget && (
        <View style={[styles.banner, { top: insets.top + 8 }]}>
          <View style={styles.spinner} />
          <Text style={styles.bannerText}>
            Reconnecting to <Text style={styles.bannerTarget}>{autoconnectTarget.label || autoconnectTarget.host}</Text>…
          </Text>
          <Pressable onPress={cancelAutoconnect} hitSlop={10}>
            <Text style={styles.bannerCancel}>Cancel</Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 140 + insets.bottom }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor="#8e8e93" />
        }
      >
        <View style={styles.title}>
          <Text style={styles.h1}>Hosts</Text>
          <Text style={styles.sub}>
            <Text style={styles.subStrong}>{String(conns.length)}</Text>
            <Text>{conns.length === 1 ? ' connection' : ' connections'}</Text>
            {runningCount > 0 ? (
              <Text>
                <Text style={styles.subSep}> · </Text>
                <Text style={styles.subStrong}>{String(runningCount)}</Text>
                <Text> running</Text>
              </Text>
            ) : null}
          </Text>
        </View>

        {conns.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No hosts yet</Text>
            <Text style={styles.emptyHint}>Tap the + button to add one.</Text>
          </View>
        ) : (
          <>
            {termloopHosts.length > 0 && (
              <Section label="TermLoop" count={termloopHosts.length}>
                {termloopHosts.map((c) => (
                  <HostRow
                    key={c.id}
                    conn={c}
                    onPress={() => openConnection(c)}
                    onLongPress={() => confirmDelete(c)}
                  />
                ))}
              </Section>
            )}
            {sshHosts.length > 0 && (
              <Section label="ssh" count={sshHosts.length}>
                {sshHosts.map((c) => (
                  <HostRow
                    key={c.id}
                    conn={c}
                    onPress={() => openConnection(c)}
                    onLongPress={() => confirmDelete(c)}
                  />
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>

      <Pressable
        style={[styles.fab, { bottom: 32 + insets.bottom }]}
        onPress={() => router.push('/connection/new')}
        hitSlop={10}
      >
        <Text style={styles.fabPlus}>+</Text>
      </Pressable>
    </View>
  );
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionLabel}>
        <Text style={styles.sectionLabelText}>{label}</Text>
        <Text style={styles.sectionLabelCount}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function HostRow({
  conn, onPress, onLongPress,
}: { conn: Connection; onPress: () => void; onLongPress: () => void }) {
  const isLive = !!conn.lastConnected && Date.now() - conn.lastConnected < 5 * 60_000;
  const port = isTermLoopHost(conn) ? conn.termloop.port : conn.ssh.port;
  const hostLine = isTermLoopHost(conn)
    ? `${conn.host} : ${port}`
    : `${conn.ssh.user}@${conn.host} : ${port}`;
  const name = conn.label || conn.host || 'Untitled';
  const time = relTime(conn.lastConnected);

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
        <Text style={styles.rowHost} numberOfLines={1}>{hostLine}</Text>
      </View>
      <View style={styles.rowAside}>
        {time && <Text style={[styles.rowTime, isLive && styles.rowTimeLive]}>{time}</Text>}
        <View style={[styles.dot, isLive && styles.dotLive]} />
        <Text style={styles.rowChev}>›</Text>
      </View>
    </Pressable>
  );
}

function relTime(ts: number | null): string | null {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: 8 },

  // title
  title: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 6 },
  h1: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.7,
    color: palette.ink1,
    lineHeight: 38,
  },
  sub: {
    marginTop: 6,
    fontSize: 15,
    color: palette.ink2,
  },
  subStrong: { color: palette.ink1, fontWeight: '500' },
  subSep: { color: palette.ink4 },

  // section
  section: { paddingTop: 26 },
  sectionLabel: {
    paddingHorizontal: 24,
    paddingBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionLabelText: {
    fontSize: 12,
    fontWeight: '600',
    color: palette.ink3,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionLabelCount: {
    fontSize: 12,
    fontWeight: '600',
    color: palette.ink4,
    fontVariant: ['tabular-nums'],
  },

  // row
  row: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  rowPressed: { backgroundColor: palette.card },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: {
    fontSize: 17,
    fontWeight: '600',
    color: palette.ink1,
    letterSpacing: -0.25,
  },
  rowHost: {
    marginTop: 3,
    fontSize: 13.5,
    color: palette.ink2,
    fontVariant: ['tabular-nums'],
  },
  rowAside: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
  rowTime: {
    fontSize: 13.5,
    color: palette.ink2,
    fontVariant: ['tabular-nums'],
  },
  rowTimeLive: { color: palette.ink1, fontWeight: '500' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
  dotLive: { backgroundColor: palette.mint },
  rowChev: {
    color: palette.ink4,
    fontSize: 18,
    fontWeight: '400',
    marginLeft: 2,
  },

  // empty
  empty: { paddingTop: 60, paddingHorizontal: 24, alignItems: 'center' },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: palette.ink1,
    marginBottom: 6,
  },
  emptyHint: { fontSize: 14, color: palette.ink2 },

  // autoconnect banner
  banner: {
    position: 'absolute',
    left: 14,
    right: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: palette.bgSoft,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    zIndex: 50,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 18,
    elevation: 6,
  },
  spinner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: palette.border,
    borderTopColor: palette.ink1,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    color: palette.ink2,
  },
  bannerTarget: { color: palette.ink1, fontWeight: '600' },
  bannerCancel: {
    fontSize: 13,
    fontWeight: '500',
    color: palette.ink2,
  },

  // fab
  fab: {
    position: 'absolute',
    right: 22,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: palette.blue,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.blue,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 10,
  },
  fabPlus: {
    color: palette.onAccent,
    fontSize: 30,
    fontWeight: '300',
    lineHeight: 34,
    marginTop: -2,
  },
});
