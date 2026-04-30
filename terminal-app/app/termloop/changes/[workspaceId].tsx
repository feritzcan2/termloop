import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  TermLoopGitChange,
  TermLoopGitChangeStatus,
  TermLoopWorkspaceChangesResult,
  formatRpcError,
} from '../../../lib/termloop-client';
import { getTermLoopClient } from '../../../lib/termloop-client-singleton';
import { palette } from '../../../lib/palette';

const STATUS_COLORS: Record<TermLoopGitChangeStatus, string> = {
  modified: palette.amber,
  added: palette.mint,
  deleted: palette.rose,
  renamed: palette.blue,
  untracked: palette.ink3,
};

const STATUS_LABELS: Record<TermLoopGitChangeStatus, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

const STATUS_SHORT: Record<TermLoopGitChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '??',
};

export default function WorkspaceChangesScreen() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const wsId = typeof workspaceId === 'string' ? workspaceId : '';

  const [data, setData] = useState<TermLoopWorkspaceChangesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      setError(null);
      const result = await getTermLoopClient().workspaceChanges(wsId);
      setData(result);
    } catch (e) {
      setError(formatRpcError(e));
    } finally {
      setLoading(false);
    }
  }, [wsId]);

  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    let subId: string | undefined;
    const client = getTermLoopClient();

    const refreshForWorkspaceEvent = (payload: any) => {
      if (payload?.workspace_id !== wsId || cancelled) return;
      void load();
    };

    const init = async () => {
      await load();
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed', 'workspace.turnCompleted'],
          workspaceIds: [wsId],
        });
      } catch {
        // Older servers may not expose event subscriptions.
      }
    };
    void init();

    const offAttention = client.onEvent('workspace.attention', refreshForWorkspaceEvent);
    const offResumed = client.onEvent('workspace.resumed', refreshForWorkspaceEvent);
    const offCompleted = client.onEvent('workspace.turnCompleted', refreshForWorkspaceEvent);
    const offReconnect = client.onReconnect(() => {
      if (!cancelled) void load();
    });

    return () => {
      cancelled = true;
      offAttention();
      offResumed();
      offCompleted();
      offReconnect();
      if (subId) client.unsubscribeEvents(subId).catch(() => {});
    };
  }, [load, wsId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading && !data && !error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={palette.ink1} />
        <Text style={styles.muted}>Loading changes…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.nav, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.navBtn} onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.navChev}>‹</Text>
          <Text style={styles.navText}>Agents</Text>
        </Pressable>
      </View>

      <FlatList
        data={data?.files ?? []}
        keyExtractor={(item) => `${item.status}:${item.path}`}
        contentContainerStyle={{ paddingBottom: 40 + insets.bottom }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.ink3} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>{data?.title ?? 'Changes'}</Text>
            {data?.branch ? (
              <View style={styles.branchPill}>
                <Text style={styles.branchPillText}>{data.branch}</Text>
              </View>
            ) : null}
            <View style={styles.countRow}>
              <Text style={styles.countValue}>{String(data?.git_change_count ?? 0)}</Text>
              <Text style={styles.countLabel}>
                {(data?.git_change_count ?? 0) === 1 ? 'change' : 'changes'}
              </Text>
            </View>
            {data?.worktree_path ? (
              <Text style={styles.path} numberOfLines={2}>{data.worktree_path}</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No uncommitted changes</Text>
            <Text style={styles.emptyText}>
              This worktree is currently clean.
            </Text>
          </View>
        }
        renderItem={({ item }) => <ChangeRow item={item} />}
      />
    </View>
  );
}

function ChangeRow({ item }: { item: TermLoopGitChange }) {
  const color = STATUS_COLORS[item.status];
  return (
    <View style={styles.row}>
      <View style={[styles.statusPill, { borderColor: color }]}>
        <Text style={[styles.statusPillText, { color }]}>{STATUS_SHORT[item.status]}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.filePath}>{item.path}</Text>
        <Text style={[styles.fileStatus, { color }]}>{STATUS_LABELS[item.status]}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  center: {
    flex: 1,
    backgroundColor: palette.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  muted: { color: palette.ink2, fontSize: 13 },
  nav: {
    paddingHorizontal: 16,
    paddingBottom: 4,
    minHeight: 48,
    justifyContent: 'center',
  },
  navBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    alignSelf: 'flex-start',
  },
  navChev: {
    color: palette.ink1,
    fontSize: 28,
    lineHeight: 28,
    marginTop: -3,
    fontWeight: '300',
  },
  navText: { color: palette.ink1, fontSize: 17, marginLeft: 2 },
  header: {
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 18,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.8,
    color: palette.ink1,
  },
  branchPill: {
    marginTop: 14,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: palette.card,
  },
  branchPillText: {
    color: palette.ink1,
    fontSize: 13.5,
    fontWeight: '600',
  },
  countRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  countValue: {
    color: palette.ink1,
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 32,
  },
  countLabel: {
    color: palette.ink3,
    fontSize: 15,
    marginBottom: 3,
  },
  path: {
    marginTop: 12,
    color: palette.ink3,
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    marginTop: 12,
    color: palette.rose,
    fontSize: 13,
  },
  row: {
    marginHorizontal: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  statusPill: {
    minWidth: 36,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  filePath: {
    color: palette.ink1,
    fontSize: 15,
    lineHeight: 20,
  },
  fileStatus: {
    marginTop: 5,
    fontSize: 12.5,
    fontWeight: '600',
  },
  emptyWrap: {
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  emptyTitle: {
    color: palette.ink1,
    fontSize: 17,
    fontWeight: '600',
  },
  emptyText: {
    marginTop: 6,
    color: palette.ink3,
    fontSize: 14,
    lineHeight: 20,
  },
});
