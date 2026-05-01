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
import { getActiveClient } from "../../lib/session";
import { colors, monoFont, radii } from "../../lib/theme";

const MAX_BUFFER_CHARS = 64_000;
const POLL_INTERVAL_MS = 1800;

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

  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);

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
        setInlineError(`Read failed: ${(err as Error).message}`);
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
      let intervalId: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (intervalId) return;
        intervalId = setInterval(() => {
          refresh().catch(() => {});
        }, POLL_INTERVAL_MS);
      };
      const stop = () => {
        if (!intervalId) return;
        clearInterval(intervalId);
        intervalId = null;
      };
      if (AppState.currentState === "active") start();
      const appStateSub = AppState.addEventListener(
        "change",
        (next: AppStateStatus) => {
          if (next === "active") start();
          else stop();
        }
      );
      return () => {
        stop();
        appStateSub.remove();
      };
    }, [client, workspaceId, refresh])
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
          setInlineError(`${def.label} failed: ${(err as Error).message}`);
        }
      }
    },
    [client, workspaceId, surfaceId, refresh]
  );

  const onSend = useCallback(async () => {
    if (!client || !workspaceId || !draft) return;
    const line = draft;
    setDraft("");
    try {
      await client.sendText(workspaceId, line, surfaceId);
      // TUIs listen for a real Enter key event; "\r" / "\n" alone is
      // treated as a literal char inside the input box.
      try {
        await client.sendKey(workspaceId, "enter", surfaceId);
      } catch {
        await client.sendText(workspaceId, "\n", surfaceId);
      }
      await refresh();
    } catch (err) {
      if (aliveRef.current) {
        setInlineError(`Send failed: ${(err as Error).message}`);
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
          <View style={{ flex: 1 }} />
          <Pressable
            style={styles.toolbarBtn}
            onPress={refresh}
            disabled={refreshing}
            hitSlop={6}
          >
            {refreshing ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.toolbarBtnText}>Refresh</Text>
            )}
          </Pressable>
        </View>

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
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: false })
          }
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

  surface: { flex: 1, backgroundColor: colors.surfaceBg },
  surfaceContent: {
    padding: 12,
    alignItems: "flex-start",
  },
  surfaceText: {
    color: "#d6d8e0",
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
  sendBtnText: { color: "#fff", fontWeight: "600" },
});
