import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseAnsi, stripAnsi } from "../../lib/ansi";
import { friendlyTransportError } from "../../lib/errors";
import { getActiveClient } from "../../lib/session";
import type { SurfaceSubscription } from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";

const MAX_BUFFER_LINES = 1200;
const HISTORY_LINES = 500;
const POLL_INTERVAL_MS = 1800;
const RECONNECT_INTERVAL_MS = 3000;
const SEND_SETTLE_MS = 60;
const NEAR_BOTTOM_PX = 80;
const MAX_COMMAND_HISTORY = 50;
const COMPOSER_MAX_HEIGHT = 96;

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
  const lines = text.split("\n");
  if (lines.length <= MAX_BUFFER_LINES) return text;
  return lines.slice(lines.length - MAX_BUFFER_LINES).join("\n");
}

interface KeyDef {
  label: string;
  /** Key name to try via `surface.send_key`. */
  key?: string;
  /** Text fallback when send_key fails or `key` is omitted. */
  text?: string;
}

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

  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const subscriptionRef = useRef<SurfaceSubscription | null>(null);
  const inputRef = useRef<TextInput>(null);
  const nearBottomRef = useRef(true);
  const reconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

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
        setBuffer(capTerminalBuffer(s.text));
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
  }, [client, workspaceId, surfaceId]);

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
                  setBuffer(capTerminalBuffer(event.text));
                  setLiveState("live");
                  setStreamReason(null);
                  stopPolling();
                  clearReconnect();
                  return;
                case "surface.output":
                  setBuffer((b) => capTerminalBuffer(b + event.text));
                  setLiveState("live");
                  setStreamReason(null);
                  stopPolling();
                  clearReconnect();
                  return;
                case "surface.closed":
                  setLiveState("closed");
                  stopPolling();
                  clearReconnect();
                  dropSubscription();
                  return;
                case "surface.error":
                  setLiveState("degraded");
                  setStreamReason(friendlyTransportError(new Error(event.message)));
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
          setLiveState("live");
          setStreamReason(null);
          stopPolling();
          clearReconnect();
        } catch (err) {
          if (cancelled) return;
          setLiveState("degraded");
          setStreamReason(friendlyTransportError(err));
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
          setLiveState("connecting");
          setStreamReason(null);
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
            setLiveState("connecting");
          }
        }
      };
      if (AppState.currentState === "active") trySubscribe();
      const appStateSub = AppState.addEventListener("change", onAppState);

      reconnectRef.current = () => {
        if (cancelled) return;
        if (subscription) return;
        clearReconnect();
        setLiveState("connecting");
        setStreamReason(null);
        trySubscribe();
      };

      return () => {
        cancelled = true;
        stopPolling();
        clearReconnect();
        appStateSub.remove();
        dropSubscription();
        reconnectRef.current = () => {};
        setLiveState("connecting");
      };
    }, [client, workspaceId, surfaceId, refresh])
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
    if (!client || !workspaceId || !draft) return;
    const line = draft;
    setDraft("");
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
        await client.sendText(workspaceId, "\n", surfaceId);
      }
      await refresh();
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (err) {
      if (aliveRef.current) {
        setInlineError(`Send failed: ${friendlyTransportError(err)}`);
      }
    }
  }, [client, workspaceId, surfaceId, draft, refresh]);

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

  const scrollToBottom = useCallback((animated = true) => {
    nearBottomRef.current = true;
    setIsNearBottom(true);
    scrollRef.current?.scrollToEnd({ animated });
  }, []);

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

  const segments = useMemo(() => {
    try {
      return parseAnsi(buffer);
    } catch {
      return null;
    }
  }, [buffer]);

  if (!client || !workspaceId) return null;

  const fontSize = FONT_SIZES[fontIndex];
  const workspaceTitle =
    typeof params.name === "string" && params.name.trim()
      ? params.name.trim()
      : "Workspace";
  const surfaceTitle =
    typeof params.surfaceName === "string" && params.surfaceName.trim()
      ? params.surfaceName.trim()
      : "Terminal";

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
        style={{ flex: 1 }}
      >
        <View style={styles.toolbar}>
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
              <Text style={styles.toolbarTitleSub}> · {surfaceTitle}</Text>
            </Text>
          </View>
          <View style={styles.toolbarStatus}>
            <View style={[styles.statusDot, statusDotStyles[liveState]]} />
            <Text style={styles.statusLabel} numberOfLines={1}>
              {STATUS_LABEL[liveState]}
            </Text>
          </View>
          <Pressable style={styles.fontBtn} onPress={cycleFont} hitSlop={6}>
            <Text style={styles.fontBtnText}>{fontSize}px</Text>
          </Pressable>
          <Pressable
            style={styles.refreshLink}
            onPress={refresh}
            disabled={refreshing}
            hitSlop={6}
          >
            {refreshing ? (
              <ActivityIndicator color={colors.sub} />
            ) : (
              <Text style={styles.refreshLinkText}>Refresh</Text>
            )}
          </Pressable>
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

        <View style={styles.surfaceFrame}>
          <ScrollView
            ref={scrollRef}
            style={styles.surfaceScroll}
            contentContainerStyle={styles.surfaceContent}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              const distanceFromBottom =
                contentSize.height - (contentOffset.y + layoutMeasurement.height);
              const next = distanceFromBottom < NEAR_BOTTOM_PX;
              nearBottomRef.current = next;
              setIsNearBottom((current) => (current === next ? current : next));
            }}
            scrollEventThrottle={64}
            onContentSizeChange={() => {
              if (nearBottomRef.current) {
                scrollRef.current?.scrollToEnd({ animated: false });
              }
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text
                style={[
                  styles.surfaceText,
                  { fontSize, lineHeight: Math.round(fontSize * 1.35) },
                ]}
                selectable
              >
                {segments
                  ? segments.map((seg, idx) => (
                      <Text key={idx} style={seg.style}>
                        {seg.text}
                      </Text>
                    ))
                  : stripAnsi(buffer)}
              </Text>
            </ScrollView>
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
          <Pressable
            style={[styles.sendBtn, !draft && styles.sendBtnDisabled]}
            onPress={onSend}
            disabled={!draft}
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  backBtn: {
    width: 28,
    height: 28,
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
  titleBlock: { flex: 1, minWidth: 0 },
  toolbarTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  toolbarTitleSub: {
    color: colors.sub,
    fontSize: 12,
    fontWeight: "400",
    fontFamily: monoFont,
  },
  fontBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  fontBtnText: { color: colors.text, fontSize: 11, fontWeight: "500" },
  toolbarStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { color: colors.sub, fontSize: 10, fontWeight: "500" },
  refreshLink: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    alignItems: "flex-end",
  },
  refreshLinkText: { color: colors.primary, fontSize: 12, fontWeight: "500" },

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
  surfaceScroll: {
    flex: 1,
  },
  surfaceContent: {
    padding: 12,
    alignItems: "flex-start",
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

  keyRowScroll: {
    flexGrow: 0,
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  keyRow: {
    paddingHorizontal: 6,
    paddingVertical: 4,
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
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
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
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    minHeight: 44,
    minWidth: 64,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendBtnText: { color: colors.onPrimary, fontWeight: "600" },
});
