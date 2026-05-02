import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  FlatList,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseAnsi, stripAnsi, type AnsiSegment } from "../../lib/ansi";
import { friendlyTransportError } from "../../lib/errors";
import { getActiveClient } from "../../lib/session";
import type { SurfaceSubscription } from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";

const MAX_BUFFER_LINES = 1200;
const MAX_BUFFER_CHARS = 180_000;
const MAX_RENDER_SEGMENTS = 2200;
const HISTORY_LINES = 500;
const POLL_INTERVAL_MS = 1800;
const RECONNECT_INTERVAL_MS = 3000;
const OUTPUT_FLUSH_MS = 90;
const SEND_SETTLE_MS = 60;
const NEAR_BOTTOM_PX = 80;
const MAX_COMMAND_HISTORY = 50;
const COMPOSER_MAX_HEIGHT = 96;
const TERMINAL_HORIZONTAL_PADDING = 24;
const TERMINAL_CHAR_WIDTH_RATIO = 0.72;
const MAX_TERMINAL_CONTENT_WIDTH = 6000;

type LiveState = "connecting" | "live" | "degraded" | "closed";

const STATUS_LABEL: Record<LiveState, string> = {
  connecting: "Connecting…",
  live: "Live",
  degraded: "Polling",
  closed: "Closed",
};

const statusDotStyles: Record<LiveState, { backgroundColor: string }> = {
  connecting: { backgroundColor: colors.warn },
  live: { backgroundColor: colors.success },
  degraded: { backgroundColor: colors.warn },
  closed: { backgroundColor: colors.danger },
};

const FONT_SIZES = [11, 13, 15] as const;
type FontIndex = 0 | 1 | 2;

function capTerminalBuffer(text: string): string {
  const capped =
    text.length > MAX_BUFFER_CHARS ? text.slice(-MAX_BUFFER_CHARS) : text;
  const lines = capped.split("\n");
  if (lines.length <= MAX_BUFFER_LINES) return capped;
  return lines.slice(lines.length - MAX_BUFFER_LINES).join("\n");
}

interface KeyDef {
  label: string;
  /** Key name to try via `surface.send_key`. */
  key?: string;
  /** Text fallback when send_key fails or `key` is omitted. */
  text?: string;
}

interface TerminalRenderLine {
  key: string;
  text: string;
  segments: AnsiSegment[] | null;
}

function makeLine(key: number): TerminalRenderLine {
  return { key: String(key), text: "", segments: [] };
}

function plainTerminalLines(text: string): TerminalRenderLine[] {
  return stripAnsi(text).split("\n").map((line, idx) => ({
    key: String(idx),
    text: line,
    segments: null,
  }));
}

function segmentTerminalLines(segments: AnsiSegment[]): TerminalRenderLine[] {
  const lines = [makeLine(0)];
  for (const segment of segments) {
    const parts = segment.text.split("\n");
    for (let idx = 0; idx < parts.length; idx++) {
      if (idx > 0) lines.push(makeLine(lines.length));
      const part = parts[idx];
      if (!part) continue;
      const line = lines[lines.length - 1];
      line.text += part;
      line.segments?.push({ text: part, style: segment.style });
    }
  }
  return lines;
}

function terminalLinesForBuffer(text: string): TerminalRenderLine[] {
  try {
    return segmentTerminalLines(
      parseAnsi(text, { maxSegments: MAX_RENDER_SEGMENTS })
    );
  } catch {
    return plainTerminalLines(text);
  }
}

const TerminalLineRow = memo(function TerminalLineRow({
  line,
  fontSize,
  lineHeight,
  lineWidth,
}: {
  line: TerminalRenderLine;
  fontSize: number;
  lineHeight: number;
  lineWidth: number;
}) {
  const textStyle = [styles.surfaceText, { fontSize, lineHeight }];
  return (
    <View
      style={[
        styles.terminalLineRow,
        { width: lineWidth, height: lineHeight },
      ]}
    >
      <Text
        style={textStyle}
        selectable
        numberOfLines={1}
        ellipsizeMode="clip"
      >
        {line.segments
          ? line.segments.length > 0
            ? line.segments.map((seg, idx) => (
                <Text key={idx} style={seg.style}>
                  {seg.text}
                </Text>
              ))
            : " "
          : line.text || " "}
      </Text>
    </View>
  );
});

const KEYS: KeyDef[] = [
  { label: "Esc", key: "escape", text: "" },
  { label: "Tab", key: "tab", text: "\t" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "←", key: "left", text: "[D" },
  { label: "→", key: "right", text: "[C" },
  { label: "Enter", key: "enter", text: "\r" },
  { label: "Ctrl-C", key: "Ctrl-C", text: "" },
  { label: "Ctrl-D", key: "Ctrl-D", text: "" },
];

export default function TerminalScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string;
    surfaceId?: string;
    name?: string;
    surfaceName?: string;
    projectName?: string;
    projectPath?: string;
  }>();
  const router = useRouter();
  const workspaceId = params.workspaceId;
  const surfaceId = params.surfaceId;
  const client = getActiveClient();

  const [buffer, setBuffer] = useState("");
  const [draft, setDraft] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [fontIndex, setFontIndex] = useState<FontIndex>(1);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [streamReason, setStreamReason] = useState<string | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(0);

  const aliveRef = useRef(true);
  const liveStateRef = useRef<LiveState>("connecting");
  const streamReasonRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const terminalListRef = useRef<FlatList<TerminalRenderLine>>(null);
  const subscriptionRef = useRef<SurfaceSubscription | null>(null);
  const inputRef = useRef<TextInput>(null);
  const nearBottomRef = useRef(true);
  const reconnectRef = useRef<() => void>(() => {});
  const pendingOutputRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOutputFlushTimer = useCallback(() => {
    if (!flushTimerRef.current) return;
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }, []);

  const flushPendingOutput = useCallback(() => {
    flushTimerRef.current = null;
    const text = pendingOutputRef.current;
    if (!text || !aliveRef.current) return;
    pendingOutputRef.current = "";
    setBuffer((current) => capTerminalBuffer(current + text));
  }, []);

  const queueSurfaceOutput = useCallback(
    (text: string) => {
      pendingOutputRef.current += text;
      if (flushTimerRef.current) return;
      flushTimerRef.current = setTimeout(flushPendingOutput, OUTPUT_FLUSH_MS);
    },
    [flushPendingOutput]
  );

  const replaceSurfaceBuffer = useCallback(
    (text: string) => {
      pendingOutputRef.current = "";
      clearOutputFlushTimer();
      if (aliveRef.current) setBuffer(capTerminalBuffer(text));
    },
    [clearOutputFlushTimer]
  );

  const setStreamStatus = useCallback(
    (state: LiveState, reason: string | null = null) => {
      if (liveStateRef.current !== state) {
        liveStateRef.current = state;
        setLiveState(state);
      }
      if (streamReasonRef.current !== reason) {
        streamReasonRef.current = reason;
        setStreamReason(reason);
      }
    },
    []
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      pendingOutputRef.current = "";
      clearOutputFlushTimer();
    };
  }, [clearOutputFlushTimer]);

  const refresh = useCallback(async () => {
    if (!client || !workspaceId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const s = await client.readSurface(
        workspaceId,
        surfaceId,
        "vt",
        HISTORY_LINES
      );
      if (aliveRef.current) {
        replaceSurfaceBuffer(s.text);
        setInlineError(null);
      }
    } catch (err) {
      if (aliveRef.current) {
        setInlineError(`Read failed: ${friendlyTransportError(err)}`);
      }
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setRefreshing(false);
    }
  }, [client, workspaceId, surfaceId, replaceSurfaceBuffer]);

  useEffect(() => {
    if (!client || !workspaceId) {
      router.replace("/connected");
      return;
    }
    refresh().catch(() => {});
  }, [client, workspaceId, router, refresh]);

  useFocusEffect(
    useCallback(() => {
      if (!client || !workspaceId) return;

      let cancelled = false;
      let intervalId: ReturnType<typeof setInterval> | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let subscription: SurfaceSubscription | null = null;

      const startPolling = () => {
        if (intervalId) return;
        intervalId = setInterval(() => {
          refresh().catch(() => {});
        }, POLL_INTERVAL_MS);
      };
      const stopPolling = () => {
        if (!intervalId) return;
        clearInterval(intervalId);
        intervalId = null;
      };
      const clearReconnect = () => {
        if (!reconnectTimer) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      };

      const dropSubscription = () => {
        const sub = subscription;
        subscription = null;
        subscriptionRef.current = null;
        if (sub) sub.unsubscribe().catch(() => {});
      };

      const trySubscribe = async () => {
        clearReconnect();
        try {
          const sub = await client.subscribeSurface(
            workspaceId,
            surfaceId,
            (event) => {
              if (cancelled || !aliveRef.current) return;
              switch (event.type) {
                case "surface.snapshot":
                  replaceSurfaceBuffer(event.text);
                  setStreamStatus("live");
                  stopPolling();
                  clearReconnect();
                  return;
                case "surface.output":
                  queueSurfaceOutput(event.text);
                  setStreamStatus("live");
                  stopPolling();
                  clearReconnect();
                  return;
                case "surface.closed":
                  setStreamStatus("closed");
                  stopPolling();
                  clearReconnect();
                  dropSubscription();
                  return;
                case "surface.error":
                  setStreamStatus(
                    "degraded",
                    friendlyTransportError(new Error(event.message))
                  );
                  dropSubscription();
                  startPolling();
                  scheduleReconnect();
                  return;
              }
            },
            "vt",
            HISTORY_LINES
          );
          if (cancelled) {
            sub.unsubscribe().catch(() => {});
            return;
          }
          subscription = sub;
          subscriptionRef.current = sub;
          setStreamStatus("live");
          stopPolling();
          clearReconnect();
        } catch (err) {
          if (cancelled) return;
          setStreamStatus("degraded", friendlyTransportError(err));
          startPolling();
          scheduleReconnect();
          refresh().catch(() => {});
        }
      };

      const scheduleReconnect = () => {
        if (cancelled || reconnectTimer || subscription) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (cancelled || subscription || AppState.currentState !== "active") {
            return;
          }
          setStreamStatus("connecting");
          trySubscribe();
        }, RECONNECT_INTERVAL_MS);
      };

      const onAppState = (next: AppStateStatus) => {
        if (next === "active") {
          if (!subscription) trySubscribe();
        } else {
          stopPolling();
          clearReconnect();
          if (subscription) {
            dropSubscription();
            setStreamStatus("connecting");
          }
        }
      };
      if (AppState.currentState === "active") trySubscribe();
      const appStateSub = AppState.addEventListener("change", onAppState);

      reconnectRef.current = () => {
        if (cancelled) return;
        if (subscription) return;
        clearReconnect();
        setStreamStatus("connecting");
        trySubscribe();
      };

      return () => {
        cancelled = true;
        stopPolling();
        clearReconnect();
        appStateSub.remove();
        dropSubscription();
        reconnectRef.current = () => {};
        pendingOutputRef.current = "";
        clearOutputFlushTimer();
        setStreamStatus("connecting");
      };
    }, [
      client,
      workspaceId,
      surfaceId,
      refresh,
      queueSurfaceOutput,
      replaceSurfaceBuffer,
      clearOutputFlushTimer,
      setStreamStatus,
    ])
  );

  const sendKey = useCallback(
    async (def: KeyDef) => {
      if (!client || !workspaceId) return;
      try {
        if (def.key) {
          try {
            await client.sendKey(workspaceId, def.key, surfaceId);
          } catch (err) {
            if (def.text === undefined) throw err;
            await client.sendText(workspaceId, def.text, surfaceId);
          }
        } else if (def.text !== undefined) {
          await client.sendText(workspaceId, def.text, surfaceId);
        }
        await refresh();
      } catch (err) {
        if (aliveRef.current) {
          setInlineError(`${def.label} failed: ${friendlyTransportError(err)}`);
        }
      }
    },
    [client, workspaceId, surfaceId, refresh]
  );

  const onSend = useCallback(async () => {
    if (!client || !workspaceId || !draft || sending) return;
    const line = draft;
    setDraft("");
    setSending(true);
    setHistoryIndex(null);
    if (line.trim()) {
      setCommandHistory((items) => {
        const next =
          items[items.length - 1] === line ? items : [...items, line];
        return next.slice(Math.max(0, next.length - MAX_COMMAND_HISTORY));
      });
    }
    inputRef.current?.focus();
    try {
      await client.sendText(workspaceId, line, surfaceId);
      // Tiny settle delay — Codex/Claude TUIs need the input chars to
      // land in their internal buffer before Enter fires. Without this,
      // Enter occasionally races ahead of the text and submits an empty
      // input.
      await new Promise((r) => setTimeout(r, SEND_SETTLE_MS));
      try {
        await client.sendKey(workspaceId, "enter", surfaceId);
      } catch {
        await client.sendText(workspaceId, "\r", surfaceId);
      }
      await refresh();
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      if (aliveRef.current) {
        setInlineError(`Send failed: ${friendlyTransportError(err)}`);
      }
    } finally {
      if (aliveRef.current) setSending(false);
    }
  }, [client, workspaceId, surfaceId, draft, sending, refresh]);

  const navigateCommandHistory = useCallback(
    (direction: "older" | "newer") => {
      if (commandHistory.length === 0) return;
      if (direction === "older") {
        const nextIndex =
          historyIndex === null
            ? commandHistory.length - 1
            : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        setDraft(commandHistory[nextIndex]);
      } else {
        if (historyIndex === null) return;
        const nextIndex = historyIndex + 1;
        if (nextIndex >= commandHistory.length) {
          setHistoryIndex(null);
          setDraft("");
        } else {
          setHistoryIndex(nextIndex);
          setDraft(commandHistory[nextIndex]);
        }
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [commandHistory, historyIndex]
  );

  const clearDraft = useCallback(() => {
    setDraft("");
    setHistoryIndex(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const cycleFont = useCallback(() => {
    setFontIndex((i) => (((i + 1) % FONT_SIZES.length) as FontIndex));
  }, []);

  const keyByLabel = useMemo(() => {
    const map = new Map<string, KeyDef>();
    for (const def of KEYS) map.set(def.label, def);
    return map;
  }, []);

  const terminalLines = useMemo(() => terminalLinesForBuffer(buffer), [buffer]);

  const maxLineChars = useMemo(
    () => terminalLines.reduce((max, line) => Math.max(max, line.text.length), 1),
    [terminalLines]
  );

  const onSurfaceLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    setSurfaceWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  const onTerminalScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      const next = distanceFromBottom < NEAR_BOTTOM_PX;
      nearBottomRef.current = next;
      setIsNearBottom((current) => (current === next ? current : next));
    },
    []
  );

  const fontSize = FONT_SIZES[fontIndex];
  const lineHeight = Math.round(fontSize * 1.35);
  const terminalContentWidth = Math.max(
    surfaceWidth,
    Math.min(
      MAX_TERMINAL_CONTENT_WIDTH,
      Math.ceil(maxLineChars * fontSize * TERMINAL_CHAR_WIDTH_RATIO) +
        TERMINAL_HORIZONTAL_PADDING
    )
  );
  const scrollToBottom = useCallback(
    (animated = true) => {
      nearBottomRef.current = true;
      setIsNearBottom(true);
      requestAnimationFrame(() => {
        terminalListRef.current?.scrollToOffset({
          animated,
          offset: Math.max(
            0,
            terminalLines.length * lineHeight + TERMINAL_HORIZONTAL_PADDING
          ),
        });
      });
    },
    [lineHeight, terminalLines.length]
  );
  const accessoryItems = useMemo(() => {
    type Item =
      | { kind: "key"; def: KeyDef; disabled?: boolean }
      | {
          kind: "action";
          label: string;
          onPress: () => void;
          disabled: boolean;
        };
    const k = (label: string): Item | null => {
      const def = keyByLabel.get(label);
      return def ? { kind: "key", def } : null;
    };
    const order: (Item | null)[] = [
      k("Tab"),
      k("Esc"),
      k("Ctrl-C"),
      k("Enter"),
      k("↑"),
      k("↓"),
      k("←"),
      k("→"),
      {
        kind: "action",
        label: "Cmd ↑",
        onPress: () => navigateCommandHistory("older"),
        disabled: commandHistory.length === 0,
      },
      {
        kind: "action",
        label: "Cmd ↓",
        onPress: () => navigateCommandHistory("newer"),
        disabled: historyIndex === null,
      },
      {
        kind: "action",
        label: "Clear",
        onPress: clearDraft,
        disabled: !draft,
      },
      {
        kind: "action",
        label: "Bottom",
        onPress: () => scrollToBottom(true),
        disabled: isNearBottom,
      },
      k("Ctrl-D"),
    ];
    return order.filter((x): x is Item => x !== null);
  }, [
    keyByLabel,
    navigateCommandHistory,
    commandHistory.length,
    historyIndex,
    clearDraft,
    draft,
    scrollToBottom,
    isNearBottom,
  ]);
  const renderTerminalLine = useCallback(
    ({ item }: ListRenderItemInfo<TerminalRenderLine>) => (
      <TerminalLineRow
        line={item}
        fontSize={fontSize}
        lineHeight={lineHeight}
        lineWidth={terminalContentWidth}
      />
    ),
    [fontSize, lineHeight, terminalContentWidth]
  );
  const terminalItemLayout = useCallback(
    (_: ArrayLike<TerminalRenderLine> | null | undefined, index: number) => ({
      length: lineHeight,
      offset: lineHeight * index,
      index,
    }),
    [lineHeight]
  );

  if (!client || !workspaceId) return null;

  const workspaceTitle =
    typeof params.name === "string" && params.name.trim()
      ? params.name.trim()
      : "Workspace";
  const surfaceTitle =
    typeof params.surfaceName === "string" && params.surfaceName.trim()
      ? params.surfaceName.trim()
      : "Terminal";
  const projectName =
    typeof params.projectName === "string" ? params.projectName.trim() : "";
  const projectPath =
    typeof params.projectPath === "string" ? params.projectPath.trim() : "";
  const projectDescriptor = projectName
    ? projectPath
      ? `${projectName} · ${projectPath}`
      : projectName
    : "TermLoop session";
  const canSend = Boolean(draft) && !sending;

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
        style={{ flex: 1 }}
      >
        <View style={styles.toolbar}>
          <View style={styles.toolbarTop}>
            <Pressable
              onPress={() => router.back()}
              style={styles.backBtn}
              hitSlop={10}
            >
              <Text style={styles.backChevron}>‹</Text>
            </Pressable>
            <View style={styles.titleBlock}>
              <Text style={styles.toolbarTitle} numberOfLines={1}>
                {workspaceTitle}
              </Text>
              <Text style={styles.toolbarSurface} numberOfLines={1}>
                {surfaceTitle}
              </Text>
            </View>
            <View style={styles.toolbarActions}>
              <View style={styles.statusPill}>
                <View style={[styles.statusDot, statusDotStyles[liveState]]} />
                <Text style={styles.statusLabel} numberOfLines={1}>
                  {STATUS_LABEL[liveState]}
                </Text>
              </View>
              <Pressable style={styles.fontBtn} onPress={cycleFont} hitSlop={6}>
                <Text style={styles.fontBtnText}>Aa {fontSize}</Text>
              </Pressable>
              <Pressable
                style={[styles.refreshBtn, refreshing && styles.refreshBtnBusy]}
                onPress={refresh}
                disabled={refreshing}
                hitSlop={6}
              >
                {refreshing ? (
                  <ActivityIndicator color={colors.sub} />
                ) : (
                  <Text style={styles.refreshBtnText}>↻</Text>
                )}
              </Pressable>
            </View>
          </View>
          <Text style={styles.projectContext} numberOfLines={1}>
            {projectDescriptor}
          </Text>
        </View>

        {liveState === "degraded" || liveState === "closed" ? (
          <View style={styles.streamBanner}>
            <View style={styles.streamBannerTextWrap}>
              <Text style={styles.streamBannerText}>
                {liveState === "closed"
                  ? "Surface closed by server"
                  : "Live updates unavailable — polling"}
              </Text>
              {streamReason ? (
                <Text style={styles.streamBannerReason} numberOfLines={2}>
                  {streamReason}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={() => reconnectRef.current()}
              style={styles.reconnectBtn}
              hitSlop={6}
            >
              <Text style={styles.reconnectBtnText}>Reconnect</Text>
            </Pressable>
          </View>
        ) : null}

        {inlineError ? (
          <Pressable
            style={styles.errorBanner}
            onPress={() => setInlineError(null)}
            hitSlop={4}
          >
            <Text style={styles.errorText} numberOfLines={2}>
              {inlineError}
            </Text>
            <Text style={styles.errorDismiss}>Dismiss</Text>
          </Pressable>
        ) : null}

        <View style={styles.surfaceFrame} onLayout={onSurfaceLayout}>
          <ScrollView
            horizontal
            directionalLockEnabled
            style={styles.surfaceHorizontal}
            contentContainerStyle={styles.surfaceHorizontalContent}
            showsHorizontalScrollIndicator={false}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <FlatList
              ref={terminalListRef}
              data={terminalLines}
              renderItem={renderTerminalLine}
              keyExtractor={(item) => item.key}
              style={[styles.surfaceList, { width: terminalContentWidth }]}
              contentContainerStyle={styles.surfaceContent}
              extraData={fontSize}
              getItemLayout={terminalItemLayout}
              initialNumToRender={48}
              maxToRenderPerBatch={32}
              removeClippedSubviews={Platform.OS === "android"}
              nestedScrollEnabled
              scrollEventThrottle={64}
              showsVerticalScrollIndicator={false}
              updateCellsBatchingPeriod={16}
              windowSize={7}
              onScroll={onTerminalScroll}
              onContentSizeChange={() => {
                if (nearBottomRef.current) {
                  scrollToBottom(false);
                }
              }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
            />
          </ScrollView>
          {!isNearBottom ? (
            <Pressable
              style={styles.jumpBottomBtn}
              onPress={() => scrollToBottom(true)}
              hitSlop={8}
            >
              <Text style={styles.jumpBottomText}>↓</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.composer}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            style={styles.keyRowScroll}
            contentContainerStyle={styles.keyRow}
          >
            {accessoryItems.map((item) =>
              item.kind === "key" ? (
                <Pressable
                  key={`k:${item.def.label}`}
                  style={({ pressed }) => [
                    styles.keyBtn,
                    pressed && styles.keyBtnPressed,
                  ]}
                  onPress={() => sendKey(item.def)}
                >
                  <Text style={styles.keyBtnText}>{item.def.label}</Text>
                </Pressable>
              ) : (
                <Pressable
                  key={`a:${item.label}`}
                  style={[
                    styles.actionBtn,
                    item.disabled && styles.actionBtnDisabled,
                  ]}
                  onPress={item.onPress}
                  disabled={item.disabled}
                >
                  <Text style={styles.actionBtnText}>{item.label}</Text>
                </Pressable>
              )
            )}
          </ScrollView>

          <View style={styles.inputRow}>
            <View style={styles.inputShell}>
              <Text style={styles.composerLabel}>Command</Text>
              <TextInput
                ref={inputRef}
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Type a command or prompt…"
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                scrollEnabled
                textAlignVertical="top"
                returnKeyType="default"
                blurOnSubmit={false}
              />
            </View>
            <Pressable
              style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
              onPress={onSend}
              disabled={!canSend}
            >
              <Text style={styles.sendBtnText}>
                {sending ? "Sending" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  toolbar: {
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 7,
    gap: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  toolbarTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  backBtn: {
    width: 30,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
  },
  backChevron: {
    color: colors.primary,
    fontSize: 26,
    fontWeight: "400",
    lineHeight: 28,
    marginTop: -2,
  },
  titleBlock: { flex: 1, minWidth: 0, gap: 1 },
  toolbarTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  toolbarSurface: {
    color: colors.sub,
    fontSize: 12,
    fontFamily: monoFont,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
  },
  statusPill: {
    minHeight: 28,
    maxWidth: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  fontBtn: {
    minHeight: 28,
    paddingHorizontal: 7,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  fontBtnText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { color: colors.sub, fontSize: 10, fontWeight: "700" },
  refreshBtn: {
    width: 30,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  refreshBtnBusy: { opacity: 0.65 },
  refreshBtnText: { color: colors.primary, fontSize: 18, fontWeight: "700" },
  projectContext: {
    color: colors.hint,
    fontSize: 11,
    fontFamily: monoFont,
    paddingLeft: 36,
  },

  streamBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.bgRaised,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  streamBannerTextWrap: { flex: 1, minWidth: 0 },
  streamBannerText: { color: colors.warn, fontSize: 11, fontWeight: "600" },
  streamBannerReason: {
    color: colors.sub,
    fontSize: 10,
    fontFamily: monoFont,
    marginTop: 2,
  },
  reconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
  },
  reconnectBtnText: { color: colors.primary, fontSize: 12, fontWeight: "600" },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.dangerDim,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.dangerBorder,
  },
  errorText: { color: colors.danger, fontSize: 12, flex: 1 },
  errorDismiss: { color: colors.danger, fontSize: 11, fontWeight: "700" },

  surfaceFrame: {
    flex: 1,
    marginHorizontal: 8,
    marginVertical: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceBg,
    overflow: "hidden",
  },
  surfaceHorizontal: {
    flex: 1,
  },
  surfaceHorizontalContent: {
    flexGrow: 1,
  },
  surfaceList: {
    flexGrow: 0,
    flexShrink: 0,
  },
  surfaceContent: {
    padding: 12,
    alignItems: "flex-start",
  },
  terminalLineRow: {
    minWidth: "100%",
  },
  surfaceText: {
    color: colors.terminalText,
    fontFamily: monoFont,
    textAlign: "left",
  },
  jumpBottomBtn: {
    position: "absolute",
    right: 12,
    bottom: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  jumpBottomText: {
    color: colors.primary,
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 22,
  },

  composer: {
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  keyRowScroll: {
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: colors.bgElevated,
  },
  keyRow: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 4,
    alignItems: "center",
  },
  actionBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderAccent,
    backgroundColor: colors.primaryDim,
    minWidth: 46,
    alignItems: "center",
  },
  actionBtnDisabled: { opacity: 0.38 },
  actionBtnText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  keyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    minWidth: 38,
    alignItems: "center",
  },
  keyBtnPressed: { backgroundColor: colors.primaryDim, borderColor: colors.primary },
  keyBtnText: {
    color: colors.text,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: "500",
  },

  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingTop: 7,
    paddingBottom: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  inputShell: {
    flex: 1,
    minWidth: 0,
    gap: 5,
  },
  composerLabel: {
    color: colors.hint,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0,
  },
  input: {
    minHeight: 44,
    maxHeight: COMPOSER_MAX_HEIGHT,
    backgroundColor: colors.inputBg,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: monoFont,
    fontSize: 13,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sendBtn: {
    paddingHorizontal: 14,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    minHeight: 44,
    minWidth: 72,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendBtnText: { color: colors.onPrimary, fontWeight: "600" },
});
