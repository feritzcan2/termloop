import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator,
  RefreshControl, Alert, Animated,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection } from '../../lib/types';
import { getConnection, saveConnection } from '../../lib/connections';
import { getTermLoopPassword } from '../../lib/secrets';
import {
  TermLoopClient, TermLoopClientState, TermLoopProject, TermLoopWorkspace, formatRpcError,
} from '../../lib/termloop-client';
import { getTermLoopClient } from '../../lib/termloop-client-singleton';
import * as OwnedSessions from '../../lib/owned-claude-sessions';
import { makeTerminalInstanceId } from '../../lib/terminal-route-instance';
import { palette } from '../../lib/palette';

type AgentStatus = 'running' | 'needs' | 'done' | 'ready';

interface AgentRow {
  ws: TermLoopWorkspace;
  status: AgentStatus;
  title: string;
  preview: string;
  agent: string;
  changeCount: number | null;
  isWorktree: boolean;
}

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

function agentDisplayName(ws: TermLoopWorkspace): string {
  const id = ws.terminal_agent_id;
  if (id && AGENT_DISPLAY_NAMES[id]) return AGENT_DISPLAY_NAMES[id];
  if (id) return id.charAt(0).toUpperCase() + id.slice(1);
  // Legacy Claude-only fallback — older servers without terminal_agent_id.
  if (ws.claude_session_id || ws.claude_running != null) return 'Claude Code';
  return 'Agent';
}

function statusFor(ws: TermLoopWorkspace): AgentStatus {
  // Agent-agnostic phase (Claude / Codex / Gemini / OpenCode) wins when set.
  const phase = ws.agent_activity_phase;
  if (phase === 'running') return 'running';
  if (phase === 'waiting' || ws.agent_attention_kind || ws.awaiting_input_since != null) {
    return 'needs';
  }
  if (phase === 'failed') return 'needs';

  // Completion signal: recent "stop" message or ready phase after activity.
  if (ws.last_message_kind === 'stop') return 'done';

  // Legacy Claude fallback: no agent-agnostic phase reported.
  if (phase == null) {
    if (ws.claude_running === true) return 'running';
    if (ws.claude_session_id) return 'done';
  }
  return 'ready';
}

function titleFor(ws: TermLoopWorkspace): string {
  return (ws.title && ws.title.trim().length > 0) ? ws.title : ws.id.slice(0, 6);
}

function previewFor(ws: TermLoopWorkspace): string {
  // Prefer the agent's own activity preview, then the attention message.
  // Empty string means no preview available — the row only shows the title.
  if (ws.agent_activity_preview && ws.agent_activity_preview.trim().length > 0) {
    return ws.agent_activity_preview.trim();
  }
  if (ws.last_message_preview && ws.last_message_preview.trim().length > 0) {
    return ws.last_message_preview.trim();
  }
  return '';
}

function includesAgent(ws: TermLoopWorkspace): boolean {
  // Include any workspace that has an agent type set OR any agent activity /
  // legacy Claude state reported. Filters out plain terminal workspaces with
  // no agent at all.
  if (ws.terminal_agent_id) return true;
  if (ws.agent_activity_phase && ws.agent_activity_phase !== 'inactive') return true;
  if (ws.claude_session_id || ws.claude_running != null) return true;
  if (ws.awaiting_input_since != null) return true;
  return false;
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  running: 0, needs: 1, done: 2, ready: 3,
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  needs: 'needs input',
  done: 'completed',
  ready: 'ready',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  running: palette.amber,
  needs: palette.rose,
  done: palette.mint,
  ready: palette.ink3,
};

function relTimeSince(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0) return null;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function workspaceTimestamp(ws: TermLoopWorkspace): number | null {
  // Both fields may arrive as seconds-since-1970 (Swift `timeIntervalSince1970`)
  // or ms. Normalize to ms: values below 1e12 are treated as seconds.
  const normalize = (n: unknown): number | null => {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  };
  return (
    normalize(ws.agent_activity_updated_at) ??
    normalize(ws.awaiting_input_since) ??
    null
  );
}

function formatLocalClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `${h}:${m}`;
  const day = d.getDate().toString().padStart(2, '0');
  const mon = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}/${mon} ${h}:${m}`;
}

export default function ConnectionDetail() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [conn, setConn] = useState<Connection | null>(null);
  const [state, setState] = useState<TermLoopClientState>('idle');
  const [workspaces, setWorkspaces] = useState<TermLoopWorkspace[]>([]);
  const [currentProject, setCurrentProject] = useState<TermLoopProject | null>(null);
  const [projectCount, setProjectCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teleportBusy, setTeleportBusy] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const clientRef = useRef<TermLoopClient | null>(null);

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      setError(null);
      const response = await client.listWorkspaces();
      setWorkspaces(response.workspaces);
      for (const ws of response.workspaces) {
        if (!ws.claude_session_id && OwnedSessions.isOwned(ws.id)) {
          OwnedSessions.release(ws.id);
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const [cp, pl] = await Promise.all([
        client.currentProject().catch(() => null),
        client.listProjects().catch(() => null),
      ]);
      if (cp) setCurrentProject(cp);
      if (pl) setProjectCount(pl.projects.length);
    } catch {
      // Older servers may not expose project.* — silently ignore.
    }
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const client = getTermLoopClient();
    clientRef.current = client;
    setState(client.currentState);
    const unsub = client.onStateChange((s) => { if (!cancelled) setState(s); });

    (async () => {
      const connection = await getConnection(id);
      if (!connection) {
        if (!cancelled) setError('Connection not found');
        return;
      }
      if (cancelled) return;
      setConn(connection);

      const password = await getTermLoopPassword(connection.id);
      if (!password) {
        if (!cancelled) setError('TermLoop password missing — re-save this connection');
        return;
      }
      try {
        if (client.currentState !== 'ready') {
          await client.connect(connection.host, connection.termloop.port, password);
        }
        if (cancelled) return;
        await saveConnection({ ...connection, lastConnected: Date.now() });
        await Promise.all([refresh(), refreshProjects()]);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();

    const unsubOwned = OwnedSessions.subscribe(() => forceRender((n) => n + 1));

    return () => {
      cancelled = true;
      unsub();
      unsubOwned();
      clientRef.current = null;
    };
  }, [id, refresh, refreshProjects]);

  useEffect(() => {
    if (state !== 'ready') return;
    const client = clientRef.current;
    if (!client) return;

    let cancelled = false;
    let subId: string | undefined;
    const sync = () => {
      if (cancelled) return;
      void refresh();
    };

    const init = async () => {
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed', 'workspace.turnCompleted'],
        });
      } catch {
        // Older servers may not expose events.subscribe yet.
      }
    };
    void init();

    const unsubA = client.onEvent('workspace.attention', sync);
    const unsubR = client.onEvent('workspace.resumed', sync);
    const unsubT = client.onEvent('workspace.turnCompleted', sync);
    const unsubReconnect = client.onReconnect(async () => {
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed', 'workspace.turnCompleted'],
        });
      } catch {}
      sync();
      void refreshProjects();
    });

    return () => {
      cancelled = true;
      unsubA();
      unsubR();
      unsubT();
      unsubReconnect();
      if (subId) client.unsubscribeEvents(subId).catch(() => {});
    };
  }, [refresh, refreshProjects, state]);

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refresh(), refreshProjects()]);
    setRefreshing(false);
  }, [refresh, refreshProjects]);

  const agents: AgentRow[] = useMemo(() => {
    return workspaces
      .filter(includesAgent)
      .map((ws) => ({
        ws,
        status: statusFor(ws),
        title: titleFor(ws),
        preview: previewFor(ws),
        agent: agentDisplayName(ws),
        changeCount:
          ws.worktree_path || ws.branch ? Math.max(0, ws.git_change_count ?? 0) : null,
        isWorktree: !!(ws.worktree_path || ws.branch),
      }))
      .sort((a, b) => {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (d !== 0) return d;
        const at = workspaceTimestamp(a.ws) ?? 0;
        const bt = workspaceTimestamp(b.ws) ?? 0;
        return bt - at;
      });
  }, [workspaces]);

  const counts = useMemo(() => {
    const running = agents.filter((a) => a.status === 'running').length;
    const needs = agents.filter((a) => a.status === 'needs').length;
    return { running, needs };
  }, [agents]);

  async function teleportHere(ws: TermLoopWorkspace) {
    if (!conn || !ws.claude_session_id) return;
    const client = clientRef.current;
    if (!client) return;
    setTeleportBusy(ws.id);
    try {
      const kill = await client.killClaudeSession(ws.id);
      if (!kill.killed) {
        Alert.alert('Teleport blocked', kill.reason ?? 'Unknown reason');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
      const prep = await client.prepareClaudeResume(
        ws.id,
        ws.claude_session_id,
        { cwd: ws.claude_cwd ?? undefined, sourceCwd: ws.claude_cwd ?? undefined }
      );
      const resumeCwd = prep.cwd ?? ws.claude_cwd ?? '';
      OwnedSessions.claim(ws.id, ws.claude_session_id);
      router.push({
        pathname: '/terminal/[id]',
        params: {
          id: conn.id,
          instanceId: makeTerminalInstanceId(),
          cwd: resumeCwd,
          resume: ws.claude_session_id,
          workspaceId: ws.id,
        },
      });
    } catch (e) {
      Alert.alert('Teleport failed', formatRpcError(e));
    } finally {
      setTeleportBusy(null);
    }
  }

  function killAgent(ws: TermLoopWorkspace) {
    if (!ws.claude_session_id) return;
    const client = clientRef.current;
    if (!client) return;
    Alert.alert(
      'Kill agent?',
      'This stops the running Claude/Codex session on the Mac. The workspace stays; you can resume later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Kill',
          style: 'destructive',
          onPress: async () => {
            setTeleportBusy(ws.id);
            try {
              await client.killClaudeSession(ws.id, { force: true });
              await refresh();
            } catch (e) {
              Alert.alert('Kill failed', formatRpcError(e));
            } finally {
              setTeleportBusy(null);
            }
          },
        },
      ]
    );
  }

  function resumeClaudeLegacy(ws: TermLoopWorkspace) {
    if (!conn || !ws.claude_session_id) return;
    const client = clientRef.current;
    if (!client) return;
    setTeleportBusy(ws.id);
    (async () => {
      try {
        const prep = await client.prepareClaudeResume(
          ws.id,
          ws.claude_session_id!,
          { cwd: ws.claude_cwd ?? undefined, sourceCwd: ws.claude_cwd ?? undefined }
        );
        router.push({
          pathname: '/terminal/[id]',
          params: {
            id: conn.id,
            instanceId: makeTerminalInstanceId(),
            cwd: prep.cwd ?? ws.claude_cwd ?? '',
            resume: ws.claude_session_id!,
            workspaceId: ws.id,
          },
        });
      } catch (e) {
        Alert.alert('Resume failed', formatRpcError(e));
      } finally {
        setTeleportBusy(null);
      }
    })();
  }

  function handleAgentTap(row: AgentRow) {
    const ws = row.ws;
    // Anything awaiting input — open chat screen to reply.
    if (row.status === 'needs') {
      router.push(`/termloop/reply/${ws.id}`);
      return;
    }
    if (row.isWorktree) {
      router.push(`/termloop/changes/${ws.id}`);
      return;
    }
    // No active session — drop into a shell for that workspace.
    if (!ws.claude_session_id) {
      if (!conn) return;
      router.push({
        pathname: '/terminal/[id]',
        params: { id: conn.id, workspaceId: ws.id },
      });
      return;
    }
    // If running on Mac with known state, pull the session to phone.
    if (ws.claude_running === true && !OwnedSessions.isOwned(ws.id)) {
      void teleportHere(ws);
      return;
    }
    // Legacy servers (running state unknown) — go straight to resume flow.
    if (ws.claude_running === undefined || ws.claude_running === null) {
      resumeClaudeLegacy(ws);
      return;
    }
    // Phone owns it, or Mac has idle session — open chat to interact.
    router.push(`/termloop/reply/${ws.id}`);
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: conn?.label || 'Error' }} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (!conn || state !== 'ready') {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: conn?.label || 'Connecting' }} />
        <ActivityIndicator color="#fff" />
        <Text style={styles.muted}>{state === 'ready' ? 'Loading…' : state}</Text>
      </View>
    );
  }

  const hostTitle = conn.label || conn.host || 'Host';

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* custom nav */}
      <View style={[styles.nav, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.navBack} onPress={() => router.back()} hitSlop={10}>
          <Text style={styles.navBackChev}>‹</Text>
          <Text style={styles.navBackText}>Hosts</Text>
        </Pressable>
        <Pressable
          style={styles.navMore}
          onPress={() => router.push({ pathname: '/connection/new', params: { id: conn.id } })}
          hitSlop={10}
        >
          <Text style={styles.navMoreText}>⋯</Text>
        </Pressable>
      </View>

      <FlatList
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 140 + insets.bottom }}
        data={agents}
        keyExtractor={(a) => a.ws.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor="#8e8e93" />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.title}>
              <Text style={styles.h1}>{hostTitle}</Text>
              <View style={styles.connLine}>
                <View style={styles.liveDot} />
                <Text style={styles.connText}>
                  <Text style={styles.connStrong}>Connected</Text>
                  {' · '}
                  {conn.host}
                </Text>
              </View>
              {currentProject ? (
                <>
                  <View style={styles.projPill}>
                    <Text style={styles.projPillText}>{currentProject.name}</Text>
                    <Text style={styles.projPillChev}>⌄</Text>
                  </View>
                  {projectCount > 1 ? (
                    <Text style={styles.projSub}>
                      {String(projectCount) + ' projects'}
                    </Text>
                  ) : null}
                </>
              ) : null}
            </View>

            <View style={styles.sectionLabel}>
              <Text style={styles.sectionLabelText}>Active agents</Text>
              <Text style={styles.sectionLabelCount}>
                {counts.running > 0 ? (
                  <Text style={styles.countRun}>{String(counts.running)}</Text>
                ) : null}
                {counts.running > 0 && counts.needs > 0 ? <Text>+</Text> : null}
                {counts.needs > 0 ? (
                  <Text style={styles.countWarn}>{String(counts.needs)}</Text>
                ) : null}
                {counts.running === 0 && counts.needs === 0 ? (
                  <Text>{String(agents.length)}</Text>
                ) : null}
              </Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>No agents yet.</Text>
        }
        renderItem={({ item }) => (
          <AgentRowSwipe
            row={item}
            busy={teleportBusy === item.ws.id}
            onPress={() => handleAgentTap(item)}
            onTeleport={() => {
              if (item.ws.claude_session_id) void teleportHere(item.ws);
            }}
            onKill={() => killAgent(item.ws)}
          />
        )}
      />

      <Pressable
        style={[styles.fab, { bottom: 32 + insets.bottom }]}
        onPress={() => {
          if (!conn) return;
          router.push({ pathname: '/terminal/[id]', params: { id: conn.id } });
        }}
        hitSlop={10}
      >
        <Text style={styles.fabPlus}>+</Text>
      </Pressable>
    </View>
  );
}

function AgentRowSwipe({
  row, busy, onPress, onTeleport, onKill,
}: {
  row: AgentRow;
  busy: boolean;
  onPress: () => void;
  onTeleport: () => void;
  onKill: () => void;
}) {
  const hasSession = !!row.ws.claude_session_id;
  const swipeRef = useRef<Swipeable | null>(null);

  // Swipe LEFT (drag from right) reveals the destructive Kill action.
  const renderRightActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    if (!hasSession) return null;
    const scale = dragX.interpolate({
      inputRange: [-96, -32, 0],
      outputRange: [1, 0.95, 0.8],
      extrapolate: 'clamp',
    });
    return (
      <Pressable
        style={styles.swipeKill}
        onPress={() => {
          swipeRef.current?.close();
          onKill();
        }}
      >
        <Animated.Text style={[styles.swipeKillText, { transform: [{ scale }] }]}>
          Kill
        </Animated.Text>
      </Pressable>
    );
  };

  // Swipe RIGHT (drag from left) reveals the Teleport-to-phone action.
  const renderLeftActions = (
    _progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    if (!hasSession) return null;
    const scale = dragX.interpolate({
      inputRange: [0, 32, 96],
      outputRange: [0.8, 0.95, 1],
      extrapolate: 'clamp',
    });
    return (
      <Pressable
        style={styles.swipeTeleport}
        onPress={() => {
          swipeRef.current?.close();
          onTeleport();
        }}
      >
        <Animated.Text style={[styles.swipeTeleportText, { transform: [{ scale }] }]}>
          Pull
        </Animated.Text>
      </Pressable>
    );
  };

  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={hasSession ? renderRightActions : undefined}
      renderLeftActions={hasSession ? renderLeftActions : undefined}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      rightThreshold={40}
      leftThreshold={40}
    >
      <AgentRowView row={row} busy={busy} onPress={onPress} />
    </Swipeable>
  );
}

function AgentRowView({
  row, busy, onPress,
}: { row: AgentRow; busy: boolean; onPress: () => void }) {
  const color = STATUS_COLOR[row.status];
  const label = STATUS_LABEL[row.status];
  const changeLabel = row.changeCount == null
    ? null
    : `${row.changeCount} ${row.changeCount === 1 ? 'change' : 'changes'}`;
  const ts = workspaceTimestamp(row.ws);
  const relative = ts ? relTimeSince(ts) : null;
  const absolute = ts ? formatLocalClock(ts) : null;
  const isLive = row.status === 'running' || row.status === 'needs';

  return (
    <Pressable
      style={({ pressed }) => [styles.agent, pressed && styles.agentPressed]}
      onPress={onPress}
      disabled={busy}
    >
      <View style={styles.agentIco}>
        {row.status === 'running' && <View style={[styles.icoDot, { backgroundColor: color }]} />}
        {row.status === 'needs' && <Text style={[styles.icoGlyph, { color }]}>!</Text>}
        {row.status === 'done' && (
          <View style={[styles.icoCheck, { backgroundColor: color }]}>
            <Text style={styles.icoCheckGlyph}>✓</Text>
          </View>
        )}
        {row.status === 'ready' && <View style={styles.icoRing} />}
      </View>
      <View style={styles.agentBody}>
        <Text
          style={[styles.agentTitle, row.status === 'ready' && styles.agentTitleDim]}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {row.title}
        </Text>
        {/* Preview only surfaces for `needs_input` — it's the single status
            where the message body is a real signal (what the agent is asking).
            Other states stay at two lines for scannability. */}
        {row.status === 'needs' && row.preview.length > 0 ? (
          <Text style={styles.agentPreview} numberOfLines={2} ellipsizeMode="tail">
            {row.preview}
          </Text>
        ) : null}
        <Text style={styles.agentMeta} numberOfLines={1}>
          <Text>{row.agent}</Text>
          <Text style={styles.agentMetaSep}> · </Text>
          <Text style={[styles.agentStatus, { color }]}>{label}</Text>
        </Text>
      </View>
      <View style={styles.agentAside}>
        {busy ? (
          <ActivityIndicator color={palette.ink1} size="small" />
        ) : (
          <>
            {changeLabel ? (
              <View
                style={[
                  styles.changeBadge,
                  row.changeCount === 0 && styles.changeBadgeMuted,
                ]}
              >
                <Text
                  style={[
                    styles.changeBadgeText,
                    row.changeCount === 0 && styles.changeBadgeTextMuted,
                  ]}
                >
                  {changeLabel}
                </Text>
              </View>
            ) : null}
            {relative ? (
              <Text
                style={[
                  styles.agentTime,
                  isLive && styles.agentTimeLive,
                  !!changeLabel && styles.agentTimeWithBadge,
                ]}
              >
                {relative}
              </Text>
            ) : null}
            {absolute ? (
              <Text style={styles.agentClock}>{absolute}</Text>
            ) : null}
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  center: {
    flex: 1, backgroundColor: palette.bg,
    alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  error: { color: palette.rose, textAlign: 'center', padding: 20, fontSize: 14 },
  muted: { color: palette.ink2, fontSize: 13, textTransform: 'lowercase' },

  // custom nav
  nav: {
    paddingHorizontal: 16,
    paddingBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  navBack: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 6 },
  navBackChev: { color: palette.ink1, fontSize: 28, lineHeight: 28, marginTop: -3, fontWeight: '300' },
  navBackText: { color: palette.ink1, fontSize: 17, marginLeft: 2 },
  navMore: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  navMoreText: { color: palette.ink2, fontSize: 22, marginTop: -8, letterSpacing: 1 },

  scroll: { flex: 1 },

  // title
  title: { paddingHorizontal: 24, paddingTop: 14, paddingBottom: 4 },
  h1: {
    fontSize: 34, fontWeight: '700',
    letterSpacing: -0.7, color: palette.ink1,
    lineHeight: 38,
  },
  connLine: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: {
    width: 7, height: 7, borderRadius: 3.5,
    backgroundColor: palette.mint,
    shadowColor: palette.mint,
    shadowOpacity: 0.5,
    shadowRadius: 4,
  },
  connText: { color: palette.ink2, fontSize: 15 },
  connStrong: { color: palette.ink1, fontWeight: '500' },
  projPill: {
    marginTop: 18, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: palette.card,
    borderRadius: 999,
  },
  projPillText: { color: palette.ink1, fontSize: 14.5, fontWeight: '500', letterSpacing: -0.2 },
  projPillChev: { color: palette.ink3, fontSize: 12, marginTop: -2 },
  projSub: {
    marginTop: 10, color: palette.ink3, fontSize: 13,
  },

  // section label
  sectionLabel: {
    paddingHorizontal: 24, paddingTop: 26, paddingBottom: 10,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  sectionLabelText: {
    fontSize: 12, fontWeight: '600', color: palette.ink3,
    letterSpacing: 1, textTransform: 'uppercase',
  },
  sectionLabelCount: {
    fontSize: 12, fontWeight: '600', color: palette.ink4,
    fontVariant: ['tabular-nums'],
  },
  countRun: { color: palette.amber, fontWeight: '700' },
  countWarn: { color: palette.rose, fontWeight: '700' },

  // agent row
  agent: {
    paddingVertical: 14, paddingLeft: 22, paddingRight: 20,
    flexDirection: 'row', alignItems: 'flex-start', gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  agentPressed: { backgroundColor: palette.card },
  agentIco: {
    width: 20, height: 20, alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  icoDot: {
    width: 12, height: 12, borderRadius: 6,
  },
  icoGlyph: {
    fontSize: 17, fontWeight: '700', lineHeight: 20, marginTop: -1,
  },
  icoCheck: {
    width: 14, height: 14, borderRadius: 7,
    alignItems: 'center', justifyContent: 'center',
  },
  icoCheckGlyph: {
    color: palette.onAccent, fontSize: 9, fontWeight: '900', lineHeight: 11,
  },
  icoRing: {
    width: 12, height: 12, borderRadius: 6,
    borderWidth: 1.5, borderColor: palette.ink4,
  },
  agentBody: { flex: 1, minWidth: 0 },
  agentTitle: {
    fontSize: 16, fontWeight: '600', color: palette.ink1,
    letterSpacing: -0.25, lineHeight: 20,
  },
  agentTitleDim: { color: palette.ink2, fontWeight: '500' },
  agentPreview: {
    marginTop: 3,
    fontSize: 13, lineHeight: 18,
    color: palette.ink2, fontWeight: '400',
  },
  agentMeta: { marginTop: 4, fontSize: 12.5, color: palette.ink3 },
  agentMetaSep: { color: palette.ink4 },
  agentStatus: { fontWeight: '500' },
  agentAside: { alignItems: 'flex-end', minWidth: 36, paddingTop: 2 },
  changeBadge: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: palette.card,
    borderWidth: 1,
    borderColor: palette.border,
  },
  changeBadgeMuted: {
    backgroundColor: 'transparent',
  },
  changeBadgeText: {
    color: palette.ink1,
    fontSize: 11,
    fontWeight: '600',
  },
  changeBadgeTextMuted: {
    color: palette.ink3,
  },
  agentTime: {
    fontSize: 13.5, color: palette.ink2, fontVariant: ['tabular-nums'],
  },
  agentTimeWithBadge: {
    marginTop: 6,
  },
  agentTimeLive: { color: palette.ink1, fontWeight: '500' },
  agentClock: {
    marginTop: 2,
    fontSize: 11,
    color: palette.ink3,
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.2,
  },

  emptyText: { color: palette.ink2, textAlign: 'center', marginTop: 40, fontSize: 14 },

  // swipe actions
  swipeKill: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.rose,
  },
  swipeKillText: {
    color: palette.onAccent,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  swipeTeleport: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.blue,
  },
  swipeTeleportText: {
    color: palette.onAccent,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.1,
  },

  // fab
  fab: {
    position: 'absolute', right: 22,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: palette.blue,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: palette.blue,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35, shadowRadius: 24, elevation: 10,
  },
  fabPlus: {
    color: palette.onAccent, fontSize: 30, fontWeight: '300',
    lineHeight: 34, marginTop: -2,
  },
});
