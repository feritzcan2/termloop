import { useHeaderHeight } from "@react-navigation/elements";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { friendlyTransportError } from "../../lib/errors";
import { getActiveClient } from "../../lib/session";
import type { SurfaceSubscription } from "../../lib/termloop-client";
import { colors, monoFont, radii } from "../../lib/theme";

const MAX_BUFFER_CHARS = 64_000;
const POLL_INTERVAL_MS = 1800;
const SEND_SETTLE_MS = 60;
const NEAR_BOTTOM_PX = 80;

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

function capLeft(text: string): string {
  if (text.length <= MAX_BUFFER_CHARS) return text;
  return text.slice(text.length - MAX_BUFFER_CHARS);
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
  { label: "Enter", key: "enter", text: "\r" },
  { label: "Ctrl-C", key: "Ctrl-C", text: "" },
  { label: "Ctrl-D", key: "Ctrl-D", text: "" },
];

export default function TerminalScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string;
    surfaceId?: string;
    name?: string;
  }>();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
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
      const s = await client.readSurface(workspaceId, surfaceId);
      if (aliveRef.current) {
        setBuffer(capLeft(s.text));
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

      const dropSubscription = () => {
        const sub = subscription;
        subscription = null;
        subscriptionRef.current = null;
        if (sub) sub.unsubscribe().catch(() => {});
      };

      const trySubscribe = async () => {
        try {
          const sub = await client.subscribeSurface(
            workspaceId,
            surfaceId,
            (event) => {
              if (cancelled || !aliveRef.current) return;
              switch (event.type) {
                case "surface.snapshot":
                  setBuffer(capLeft(event.text));
                  setLiveState("live");
                  setStreamReason(null);
                  stopPolling();
                  return;
                case "surface.output":
                  setBuffer((b) => capLeft(b + event.text));
                  setLiveState("live");
                  setStreamReason(null);
                  stopPolling();
                  return;
                case "surface.closed":
                  setLiveState("closed");
                  stopPolling();
                  dropSubscription();
                  return;
                case "surface.error":
                  setLiveState("degraded");
                  setStreamReason(friendlyTransportError(new Error(event.message)));
                  dropSubscription();
                  startPolling();
                  return;
              }
            }
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
        } catch (err) {
          if (cancelled) return;
          setLiveState("degraded");
          setStreamReason(friendlyTransportError(err));
          startPolling();
          refresh().catch(() => {});
        }
      };

      const onAppState = (next: AppStateStatus) => {
        if (next === "active") {
          if (!subscription) trySubscribe();
        } else {
          stopPolling();
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
        setLiveState("connecting");
        setStreamReason(null);
        trySubscribe();
      };

      return () => {
        cancelled = true;
        stopPolling();
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
    } catch (err) {
      if (aliveRef.current) {
        setInlineError(`Send failed: ${friendlyTransportError(err)}`);
      }
    }
  }, [client, workspaceId, surfaceId, draft, refresh]);

  const cycleFont = useCallback(() => {
    setFontIndex((i) => (((i + 1) % FONT_SIZES.length) as FontIndex));
  }, []);

  if (!client || !workspaceId) return null;

  const fontSize = FONT_SIZES[fontIndex];

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={headerHeight}
        style={{ flex: 1 }}
      >
        <View style={styles.toolbar}>
          <Pressable
            style={styles.toolbarBtn}
            onPress={cycleFont}
            hitSlop={6}
          >
            <Text style={styles.toolbarBtnText}>{fontSize}px</Text>
          </Pressable>
          <View style={styles.toolbarStatus}>
            <View style={[styles.statusDot, statusDotStyles[liveState]]} />
            <Text style={styles.statusLabel}>{STATUS_LABEL[liveState]}</Text>
          </View>
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

        <ScrollView
          ref={scrollRef}
          style={styles.surface}
          contentContainerStyle={styles.surfaceContent}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              e.nativeEvent;
            const distanceFromBottom =
              contentSize.height - (contentOffset.y + layoutMeasurement.height);
            nearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
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
              {buffer}
            </Text>
          </ScrollView>
        </ScrollView>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          style={styles.keyRowScroll}
          contentContainerStyle={styles.keyRow}
        >
          {KEYS.map((def) => (
            <Pressable
              key={def.label}
              style={({ pressed }) => [
                styles.keyBtn,
                pressed && styles.keyBtnPressed,
              ]}
              onPress={() => sendKey(def)}
            >
              <Text style={styles.keyBtnText}>{def.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Type a command…"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={onSend}
            returnKeyType="send"
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
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  toolbarBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    minWidth: 70,
    alignItems: "center",
  },
  toolbarBtnText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  toolbarStatus: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusLabel: { color: colors.sub, fontSize: 11, fontWeight: "500" },
  refreshLink: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    minWidth: 56,
    alignItems: "flex-end",
  },
  refreshLinkText: { color: colors.primary, fontSize: 13, fontWeight: "500" },

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

  surface: {
    flex: 1,
    marginHorizontal: 8,
    marginVertical: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceBg,
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

  keyRowScroll: {
    flexGrow: 0,
    flexShrink: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  keyRow: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    alignItems: "center",
  },
  keyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    minWidth: 44,
    alignItems: "center",
  },
  keyBtnPressed: { backgroundColor: colors.primaryDim, borderColor: colors.primary },
  keyBtnText: {
    color: colors.text,
    fontFamily: monoFont,
    fontSize: 13,
    fontWeight: "500",
  },

  inputRow: {
    flexDirection: "row",
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
    minWidth: 64,
  },
  sendBtnDisabled: { opacity: 0.45 },
  sendBtnText: { color: colors.onPrimary, fontWeight: "600" },
});
