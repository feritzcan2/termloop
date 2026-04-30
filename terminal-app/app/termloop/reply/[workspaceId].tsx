import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTermLoopClient } from '../../../lib/termloop-client-singleton';
import { formatRpcError } from '../../../lib/termloop-client';
import { palette } from '../../../lib/palette';

type Bubble =
  | { from: 'agent'; text: string; at: number }
  | { from: 'user'; text: string; at: number };

type Segment =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'meta'; text: string };

type AgentPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; title: string; body: string };

type Turn =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; parts: AgentPart[]; speaker: string }
  | { kind: 'status'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'meta'; text: string };

const HISTORY_LINES = 300;

const historyCache = new Map<string, { text: string; fetchedAt: number }>();

function mergeScrollback(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const anchors = [2000, 1000, 500, 250, 120, 60];
  for (const len of anchors) {
    if (prev.length < len) continue;
    const anchor = prev.slice(-len);
    const idx = next.indexOf(anchor);
    if (idx >= 0) return prev + next.slice(idx + anchor.length);
  }
  return next;
}

export default function Reply() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState<string>(
    typeof workspaceId === 'string' ? workspaceId.slice(0, 6) : ''
  );
  const [agentName, setAgentName] = useState<string>('Agent');
  const initialCached =
    typeof workspaceId === 'string' ? historyCache.get(workspaceId) : undefined;
  const [history, setHistory] = useState<string>(initialCached?.text ?? '');
  const [historyLoading, setHistoryLoading] = useState(!initialCached);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const wsId = typeof workspaceId === 'string' ? workspaceId : '';

  const loadHistory = useCallback(async () => {
    if (!wsId) return;
    try {
      const client = getTermLoopClient();
      const res = await client.surfaceReadText(wsId, { lines: HISTORY_LINES });
      const fresh = stripAnsi(res.text);
      setHistory((prev) => {
        const merged = mergeScrollback(prev, fresh);
        historyCache.set(wsId, { text: merged, fetchedAt: Date.now() });
        return merged;
      });
    } catch {
      // older servers may not support surface.read_text — leave empty
    } finally {
      setHistoryLoading(false);
    }
  }, [wsId]);

  useEffect(() => {
    if (!wsId) return;
    const client = getTermLoopClient();
    let cancelled = false;
    let subId: string | undefined;

    const loadWorkspace = async () => {
      try {
        const list = await client.workspaceList();
        const w = list.find((x) => x.id === wsId);
        if (!w || cancelled) return;
        setTitle(w.title || w.id.slice(0, 6));
        setAgentName(displayNameForAgent(w.terminal_agent_id, w));
        setWorking(
          !!((w.agent_activity_phase === 'running' || w.claude_running) &&
            w.awaiting_input_since == null)
        );
      } catch {
        // non-fatal
      }
    };

    const init = async () => {
      await Promise.all([loadWorkspace(), loadHistory()]);
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed', 'workspace.turnCompleted'],
          workspaceIds: [wsId],
        });
      } catch {
        // graceful degradation
      }
    };
    void init();

    const offAtt = client.onEvent('workspace.attention', (d: any) => {
      if (d.workspace_id !== wsId) return;
      setBubbles((prev) => [
        ...prev,
        {
          from: 'agent',
          text: d.message_preview ?? '',
          at: d.awaiting_since ?? Date.now() / 1000,
        },
      ]);
      setWorking(false);
    });
    const offRes = client.onEvent('workspace.resumed', (d: any) => {
      if (d.workspace_id !== wsId) return;
      setWorking(true);
    });
    const offTurn = client.onEvent('workspace.turnCompleted', (d: any) => {
      if (d.workspace_id !== wsId) return;
      setWorking(false);
    });
    const offReconnect = client.onReconnect(async () => {
      try {
        subId = await client.subscribeEvents({
          types: ['workspace.attention', 'workspace.resumed', 'workspace.turnCompleted'],
          workspaceIds: [wsId],
        });
      } catch {}
      await loadWorkspace();
    });

    return () => {
      cancelled = true;
      offAtt();
      offRes();
      offTurn();
      offReconnect();
      if (subId) client.unsubscribeEvents(subId).catch(() => {});
    };
  }, [wsId, loadHistory]);

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadHistory();
    setRefreshing(false);
  }, [loadHistory]);

  const send = async () => {
    if (!input.trim() || !wsId) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setBubbles((prev) => [...prev, { from: 'user', text, at: Date.now() / 1000 }]);
    try {
      const client = getTermLoopClient();
      if (client.currentState !== 'ready') {
        throw new Error(`TermLoop not connected (state: ${client.currentState})`);
      }
      await client.surfaceSendText(wsId, text + '\n');
      setWorking(true);
    } catch (e) {
      setInput(text);
      setBubbles((prev) => prev.slice(0, -1));
      Alert.alert('Gönderilemedi', formatRpcError(e));
    } finally {
      setSending(false);
    }
  };

  const dismiss = async () => {
    if (!wsId) return;
    try {
      await getTermLoopClient().workspaceClearAttention(wsId);
    } catch {}
    router.back();
  };

  const segments = useMemo(() => parseTranscript(history), [history]);
  const turns = useMemo(() => groupTurns(segments, agentName), [segments, agentName]);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {/* Nav */}
        <View style={[styles.nav, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.navBtn} onPress={() => router.back()} hitSlop={10}>
            <Text style={styles.navChev}>‹</Text>
            <Text style={styles.navBtnText}>Agents</Text>
          </Pressable>
          <Pressable style={styles.navDismiss} onPress={dismiss} hitSlop={10}>
            <Text style={styles.navDismissText}>Düş</Text>
            <Text style={styles.navDismissCheck}>✓</Text>
          </Pressable>
        </View>

        {/* Compact header — single line caption, tap-scroll to reveal full */}
        <View style={styles.titleBlock}>
          <View style={styles.metaRow}>
            <Text style={styles.agentLabel}>{agentName}</Text>
            {working && (
              <>
                <Text style={styles.metaSep}>·</Text>
                <View style={styles.workingDot} />
                <Text style={styles.workingText}>working</Text>
              </>
            )}
          </View>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
        </View>

        {/* Transcript */}
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onPullRefresh}
              tintColor={palette.ink2}
            />
          }
        >
          {historyLoading && segments.length === 0 ? (
            <View style={styles.loading}>
              <ActivityIndicator size="small" color="#8e8e93" />
            </View>
          ) : null}

          {turns.map((t, i) => (
            <TurnView key={`t-${i}`} turn={t} />
          ))}

          {bubbles.length > 0 && <View style={styles.liveSep} />}
          {bubbles.map((b, i) =>
            b.from === 'user' ? (
              <TurnView key={`b-${i}`} turn={{ kind: 'user', text: b.text }} />
            ) : (
              <TurnView
                key={`b-${i}`}
                turn={{
                  kind: 'agent',
                  speaker: agentName,
                  parts: [{ kind: 'text', text: b.text }],
                }}
              />
            )
          )}

          {working && (
            <View style={styles.typing}>
              <View style={styles.typingDotRow}>
                <Dot delay={0} />
                <Dot delay={200} />
                <Dot delay={400} />
              </View>
              <Text style={styles.typingText}>{agentName} is working…</Text>
            </View>
          )}
        </ScrollView>

        {/* Composer */}
        <View style={[styles.composer, { paddingBottom: 10 + insets.bottom }]}>
          <TextInput
            style={styles.textInput}
            placeholder="Reply…"
            placeholderTextColor="#5a5a60"
            value={input}
            onChangeText={setInput}
            editable={!sending}
            multiline
            returnKeyType="send"
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <Pressable
            onPress={send}
            disabled={sending || !input.trim()}
            style={[
              styles.sendBtn,
              (sending || !input.trim()) && styles.sendBtnDisabled,
            ]}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const ref = useRef<View>(null);
  return <View ref={ref} style={[styles.typingDot, { opacity: 0.3 + (delay / 600) }]} />;
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'user') {
    return (
      <View style={styles.userBubbleWrap}>
        <View style={styles.userBubble}>
          <Text style={styles.userBubbleText} selectable>{turn.text}</Text>
        </View>
      </View>
    );
  }
  if (turn.kind === 'agent') {
    return (
      <View style={styles.agentTurn}>
        <Text style={styles.agentSpeaker}>{turn.speaker}</Text>
        {turn.parts.map((part, i) =>
          part.kind === 'tool' ? (
            <ToolChip key={i} title={part.title} body={part.body} />
          ) : (
            <View key={i} style={styles.agentPart}>
              <Text style={styles.agentPartText} selectable>{part.text}</Text>
            </View>
          )
        )}
      </View>
    );
  }
  // status, system, meta — keep existing single-line treatments
  return <SegmentView seg={turn as Segment} />;
}

function ToolChip({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);
  const lineCount = body.split('\n').length;
  return (
    <Pressable style={styles.toolChip} onPress={() => setOpen((v) => !v)}>
      <View style={styles.toolChipHead}>
        <Text style={styles.toolChipIcon}>{open ? '▾' : '▸'}</Text>
        <Text style={styles.toolChipTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.toolChipCount}>{lineCount} line{lineCount === 1 ? '' : 's'}</Text>
      </View>
      {open && (
        <Text style={styles.toolChipBody} selectable>{body}</Text>
      )}
    </Pressable>
  );
}

function SegmentView({ seg }: { seg: Segment }) {
  switch (seg.kind) {
    case 'user':
      return (
        <View style={styles.segUser}>
          <View style={styles.segUserBar} />
          <Text style={styles.segUserText} selectable>{seg.text}</Text>
        </View>
      );
    case 'agent':
      return (
        <View style={styles.segAgent}>
          <View style={styles.segAgentBullet} />
          <Text style={styles.segAgentText} selectable>{seg.text}</Text>
        </View>
      );
    case 'status':
      return (
        <View style={styles.segStatus}>
          <View style={styles.segStatusDot} />
          <Text style={styles.segStatusText} selectable>{seg.text}</Text>
        </View>
      );
    case 'system':
      return (
        <View style={styles.segSystem}>
          <Text style={styles.segSystemText} selectable>{seg.text}</Text>
        </View>
      );
    case 'meta':
      return (
        <Text style={styles.segMetaText} selectable numberOfLines={1}>
          {seg.text}
        </Text>
      );
  }
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function parseTranscript(raw: string): Segment[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const segs: Segment[] = [];
  let buf: string[] = [];

  // Flush the agent buffer, splitting on `•` bullets and blank-line gaps so
  // each "paragraph" becomes its own card instead of one giant wall.
  const flushAgent = () => {
    if (buf.length === 0) return;
    const joined = buf.join('\n');

    // Split on `•` bullet starts at line begin (Codex's convention). The
    // first segment before any bullet is also kept.
    const byBullet = joined.split(/(?=^\s*•\s+)/m);
    for (const chunk of byBullet) {
      // Further split on 2+ blank lines within a chunk.
      const paras = chunk.split(/\n{2,}/);
      for (const para of paras) {
        const text = trimTrailing(para).replace(/^\s*•\s+/, '');
        if (text.trim().length === 0) continue;
        segs.push({ kind: 'agent', text });
      }
    }
    buf = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^[─━_=\-]{6,}$/.test(line.trim())) continue;
    if (/^>\s+\S/.test(line)) {
      flushAgent();
      segs.push({ kind: 'user', text: line.replace(/^>\s+/, '') });
      continue;
    }
    if (/^\s*■\s/.test(line)) {
      flushAgent();
      segs.push({ kind: 'system', text: line.replace(/^\s*■\s+/, '') });
      continue;
    }
    if (/^\s*[•●]\s+Working\s*\(.*interrupt.*\)/i.test(line)) {
      flushAgent();
      segs.push({ kind: 'status', text: line.replace(/^\s*[•●]\s+/, '') });
      continue;
    }
    if (/^\s*●\s/.test(line)) {
      flushAgent();
      segs.push({ kind: 'status', text: line.replace(/^\s*●\s+/, '') });
      continue;
    }
    if (/^\s*(gpt|claude|gemini|opencode|codex)[-\w.]+\s*[·•]/i.test(line)) {
      flushAgent();
      segs.push({ kind: 'meta', text: line.trim() });
      continue;
    }
    buf.push(line);
  }
  flushAgent();
  return segs;
}

/**
 * Group flat segments into conversation "turns": a user message is its own
 * turn (right-aligned bubble), and consecutive agent segments collapse into a
 * single agent turn (left-aligned, speaker-labelled, with tool calls pulled
 * out as collapsible chips). system/status/meta segments flow through as
 * their own turns between agent runs.
 */
function groupTurns(segs: Segment[], speaker: string): Turn[] {
  const turns: Turn[] = [];
  let current: { kind: 'agent'; parts: AgentPart[]; speaker: string } | null = null;
  const flush = () => {
    if (current && current.parts.length > 0) turns.push(current);
    current = null;
  };
  for (const s of segs) {
    if (s.kind === 'user') {
      flush();
      turns.push({ kind: 'user', text: s.text });
    } else if (s.kind === 'agent') {
      if (!current) current = { kind: 'agent', parts: [], speaker };
      if (isToolCall(s.text)) {
        current.parts.push(parseTool(s.text));
      } else {
        current.parts.push({ kind: 'text', text: s.text });
      }
    } else if (s.kind === 'status' || s.kind === 'system' || s.kind === 'meta') {
      flush();
      turns.push(s);
    }
  }
  flush();
  return turns;
}

/**
 * Heuristic: paragraph is a tool call if it starts with a tool verb (Explored,
 * Ran, Read, Search, Edited, Wrote) or contains `└`/`├` tree decorations.
 */
function isToolCall(text: string): boolean {
  if (/[└├]\s/.test(text)) return true;
  if (/^(Explored|Ran|Read|Search|Edited|Wrote|Listed|Deleted)\b/.test(text)) return true;
  return false;
}

function parseTool(text: string): { kind: 'tool'; title: string; body: string } {
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim().replace(/^[└├]\s*/, '');
  // Truncate really long first lines so chip stays compact.
  const title = first.length > 80 ? first.slice(0, 78) + '…' : first;
  return { kind: 'tool', title, body: text };
}

function trimTrailing(s: string): string {
  return s.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n');
}

function displayNameForAgent(
  id: string | null | undefined,
  w: { claude_session_id?: string | null; claude_running?: boolean | null }
): string {
  const map: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'Codex CLI',
    gemini: 'Gemini CLI',
    opencode: 'OpenCode',
  };
  if (id && map[id]) return map[id];
  if (id) return id.charAt(0).toUpperCase() + id.slice(1);
  if (w.claude_session_id || w.claude_running != null) return 'Claude Code';
  return 'Agent';
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },

  nav: {
    paddingHorizontal: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  navBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 6 },
  navChev: { color: palette.ink1, fontSize: 24, fontWeight: '300', marginTop: -3 },
  navBtnText: { color: palette.ink1, fontSize: 17, marginLeft: 2 },
  navDismiss: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: palette.card,
    borderRadius: 999,
  },
  navDismissText: { color: palette.ink1, fontSize: 14, fontWeight: '500' },
  navDismissCheck: { color: palette.mint, fontSize: 14, fontWeight: '700' },

  titleBlock: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.divider,
  },
  title: {
    color: palette.ink2,
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: -0.1,
    lineHeight: 18,
    marginTop: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  agentLabel: {
    color: palette.ink1,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  metaSep: { color: palette.ink4, fontSize: 13 },
  workingDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: palette.amber,
    shadowColor: palette.amber,
    shadowOpacity: 0.6,
    shadowRadius: 4,
  },
  workingText: { color: palette.amber, fontSize: 13, fontWeight: '500' },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 0,
    paddingTop: 10,
    paddingBottom: 20,
  },

  loading: { paddingVertical: 32, alignItems: 'center' },

  // ---------- chat-abstraction turns ----------
  // User turn: right-aligned iMessage-style bubble.
  userBubbleWrap: {
    alignItems: 'flex-end',
    paddingHorizontal: 14,
    marginTop: 14,
    marginBottom: 4,
  },
  userBubble: {
    maxWidth: '86%',
    backgroundColor: palette.blue,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  },
  userBubbleText: {
    color: palette.onAccent,
    fontSize: 15.5,
    lineHeight: 21,
    fontWeight: '500',
    letterSpacing: -0.1,
  },

  // Agent turn: speaker label + cards below, left-aligned.
  agentTurn: {
    paddingHorizontal: 14,
    marginTop: 10,
    marginBottom: 4,
  },
  agentSpeaker: {
    color: palette.ink2,
    fontSize: 11.5,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginLeft: 4,
    marginBottom: 6,
  },
  agentPart: {
    backgroundColor: palette.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 4,
  },
  agentPartText: {
    color: palette.ink1,
    fontSize: 14.5,
    lineHeight: 20,
    letterSpacing: -0.05,
  },

  // Collapsed tool chip: tap to expand inline body.
  toolChip: {
    backgroundColor: palette.bgSoft,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 4,
  },
  toolChipHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toolChipIcon: {
    color: palette.ink3,
    fontSize: 11,
    width: 12,
    textAlign: 'center',
  },
  toolChipTitle: {
    flex: 1,
    color: palette.ink1,
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: -0.05,
    fontFamily: MONO,
  },
  toolChipCount: {
    color: palette.ink3,
    fontSize: 11,
    letterSpacing: 0.2,
  },
  toolChipBody: {
    color: palette.ink2,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: MONO,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },

  // ---------- legacy segment styles (still used for system/status/meta) ----------
  // user prompt — pastel blue card marks turn boundaries
  segUser: {
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 6,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: palette.blueSoft,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: palette.blue,
  },
  segUserBar: { width: 0, height: 0 },
  segUserText: {
    color: '#eaf0ff',
    fontSize: 15.5,
    lineHeight: 21,
    fontWeight: '500',
    letterSpacing: -0.1,
  },

  // agent response — soft tinted panel for each paragraph
  segAgent: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginVertical: 5,
    paddingHorizontal: 14,
    paddingVertical: 11,
    backgroundColor: palette.card,
    borderRadius: 12,
  },
  segAgentBullet: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: palette.ink3,
    marginTop: 8,
  },
  segAgentText: {
    flex: 1,
    color: palette.ink1,
    fontSize: 13.5,
    lineHeight: 20,
    fontFamily: MONO,
  },

  // system ■ block — pastel rose
  segSystem: {
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: palette.roseSoft,
    borderRadius: 10,
    borderLeftWidth: 2,
    borderLeftColor: palette.rose,
  },
  segSystemText: {
    color: palette.rose,
    fontSize: 13.5,
    lineHeight: 19,
    fontStyle: 'italic',
  },

  // status ● block (Working pill) — pastel amber
  segStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 18,
    marginVertical: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
    backgroundColor: palette.amberSoft,
    borderRadius: 999,
  },
  segStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.amber,
    shadowColor: palette.amber,
    shadowOpacity: 0.7,
    shadowRadius: 4,
  },
  segStatusText: {
    color: palette.amber,
    fontSize: 11.5,
    letterSpacing: 0.1,
    fontWeight: '500',
  },

  // meta footer (gpt-5.4 · Context ... )
  segMetaText: {
    paddingHorizontal: 22,
    paddingVertical: 2,
    color: palette.ink4,
    fontSize: 10.5,
    fontFamily: MONO,
    letterSpacing: 0.1,
  },

  liveSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.mintSoft,
    marginHorizontal: 20,
    marginVertical: 14,
  },

  typing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  typingDotRow: { flexDirection: 'row', gap: 4 },
  typingDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: palette.ink3,
  },
  typingText: { color: palette.ink2, fontSize: 13, fontStyle: 'italic' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.divider,
    backgroundColor: palette.bg,
  },
  textInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 140,
    backgroundColor: palette.card,
    color: palette.ink1,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: 21,
    fontSize: 16,
    lineHeight: 20,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: palette.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: palette.card,
  },
  sendBtnText: {
    color: palette.onAccent,
    fontSize: 22,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: -2,
  },
});
