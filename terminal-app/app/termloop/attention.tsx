import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { getTermLoopClient } from '../../lib/termloop-client-singleton';
import { fireAttentionNotification, ensurePermission } from '../../lib/termloop-notifications';

type Row = {
  workspaceId: string;
  workspaceName: string;
  projectId?: string;
  messagePreview: string;
  kind: 'stop' | 'notification';
  awaitingSince: number;
};

function relativeTime(epochSec: number): string {
  const diff = Math.floor(Date.now() / 1000 - epochSec);
  if (diff < 60) return 'şimdi';
  if (diff < 3600) return `${Math.floor(diff / 60)}dk`;
  return `${Math.floor(diff / 3600)}sa`;
}

export default function Attention() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const client = getTermLoopClient();
      const list = await client.workspaceList();
      const filtered: Row[] = list
        .filter((w: any) => w.awaiting_input_since != null)
        .map((w: any) => ({
          workspaceId: w.id,
          workspaceName: w.title ?? w.name ?? w.claude_cwd ?? w.id.slice(0, 6),
          projectId: w.project_id ?? undefined,
          messagePreview: w.last_message_preview ?? '',
          kind: (w.last_message_kind ?? 'stop') as 'stop' | 'notification',
          awaitingSince: w.awaiting_input_since as number,
        }))
        .sort((a: Row, b: Row) => b.awaitingSince - a.awaitingSince);
      setRows(filtered);
      setErrorMessage(null);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/tab\s*manager/i.test(msg)) {
        setErrorMessage('TermLoop ana ekranında açık bir workspace yok. Mac\'te TermLoop’u açıp bir workspace oluştur, sonra buraya gel.');
      } else {
        setErrorMessage(msg);
      }
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    // Request notification permission early
    ensurePermission().catch(() => {});

    const client = getTermLoopClient();
    let subId: string | undefined;

    const init = async () => {
      await refresh();
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed'],
        });
      } catch {
        // Server may not support events.subscribe yet — graceful degradation
      }
    };

    init();

    const offAtt = client.onEvent('workspace.attention', async (d: any) => {
      // Fire local notification for the incoming attention event
      fireAttentionNotification({
        workspaceId: d.workspace_id,
        workspaceName: d.workspace_name ?? d.workspace_id?.slice(0, 6) ?? 'agent',
        messagePreview: d.message_preview ?? '',
        kind: d.kind,
      }).catch(() => {});
      await refresh();
    });

    const offRes = client.onEvent('workspace.resumed', () => {
      void refresh();
    });

    // Re-subscribe on reconnect (D2)
    const offReconn = client.onReconnect(async () => {
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed'],
        });
      } catch {}
      await refresh();
    });

    return () => {
      offAtt();
      offRes();
      offReconn();
      if (subId) client.unsubscribeEvents(subId).catch(() => {});
    };
  }, [refresh]);

  return (
    <FlatList
      style={styles.list}
      data={rows}
      keyExtractor={(r) => r.workspaceId}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor="#5eb4ff"
        />
      }
      ListEmptyComponent={
        <View style={styles.emptyWrap}>
          {errorMessage ? (
            <Text style={styles.error}>{errorMessage}</Text>
          ) : (
            <Text style={styles.empty}>Tüm agent'lar sessiz</Text>
          )}
        </View>
      }
      ListHeaderComponent={
        rows.length > 0 ? (
          <Text style={styles.sectionHeader}>
            {rows.length} dikkat bekliyor
          </Text>
        ) : null
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => router.push(`/termloop/reply/${item.workspaceId}`)}
        >
          <View
            style={[
              styles.dot,
              item.kind === 'notification' && styles.dotPermission,
            ]}
          />
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {item.workspaceName}
              </Text>
              <Text style={styles.time}>{relativeTime(item.awaitingSince)}</Text>
            </View>
            <Text style={styles.preview} numberOfLines={2}>
              {item.messagePreview}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: '#0b0b0f',
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    fontSize: 12,
    color: '#8a8a91',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 80,
  },
  empty: {
    textAlign: 'center',
    color: '#8a8a91',
    fontSize: 15,
  },
  error: {
    textAlign: 'center',
    color: '#ff9500',
    fontSize: 14,
    paddingHorizontal: 32,
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomColor: '#1c1c22',
    borderBottomWidth: 1,
    alignItems: 'flex-start',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ff9500',
    marginTop: 5,
    flexShrink: 0,
  },
  dotPermission: {
    backgroundColor: '#ff453a',
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  time: {
    color: '#8a8a91',
    fontSize: 12,
    flexShrink: 0,
  },
  preview: {
    color: '#c7c7cd',
    fontSize: 13,
    lineHeight: 18,
  },
});
