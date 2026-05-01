import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { colors, monoFont } from "../../lib/theme";

const MAX_BUFFER_CHARS = 64_000;
const POLL_INTERVAL_MS = 1800;

function capLeft(text: string): string {
  if (text.length <= MAX_BUFFER_CHARS) return text;
  return text.slice(text.length - MAX_BUFFER_CHARS);
}

export default function TerminalScreen() {
  const params = useLocalSearchParams<{
    workspaceId?: string;
    surfaceId?: string;
    name?: string;
  }>();
  const router = useRouter();
  const workspaceId = params.workspaceId;
  const surfaceId = params.surfaceId;
  const client = getActiveClient();

  const [buffer, setBuffer] = useState("");
  const [draft, setDraft] = useState("");
  const [refreshing, setRefreshing] = useState(false);

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
      if (aliveRef.current) setBuffer(capLeft(s.text));
    } catch (err) {
      if (aliveRef.current) {
        setBuffer((b) =>
          capLeft(b + `\n(read error: ${(err as Error).message})\n`)
        );
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
    refresh().catch(() => {
      /* surfaced via buffer */
    });
  }, [client, workspaceId, router, refresh]);

  useFocusEffect(
    useCallback(() => {
      if (!client || !workspaceId) return;
      const id = setInterval(() => {
        refresh().catch(() => {
          /* surfaced via buffer */
        });
      }, POLL_INTERVAL_MS);
      return () => clearInterval(id);
    }, [client, workspaceId, refresh])
  );

  const onSend = async () => {
    if (!client || !workspaceId || !draft) return;
    const line = draft;
    setDraft("");
    try {
      await client.sendText(workspaceId, line + "\n", surfaceId);
      await refresh();
    } catch (err) {
      if (aliveRef.current) {
        setBuffer((b) =>
          capLeft(b + `\n(send error: ${(err as Error).message})\n`)
        );
      }
    }
  };

  if (!client || !workspaceId) return null;

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
        style={{ flex: 1 }}
      >
        <View style={styles.toolbar}>
          <Pressable
            style={styles.refreshBtn}
            onPress={refresh}
            disabled={refreshing}
            hitSlop={6}
          >
            {refreshing ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={styles.refreshBtnText}>Refresh</Text>
            )}
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.surface}
          contentContainerStyle={styles.surfaceContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: false })
          }
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.surfaceText} selectable>
              {buffer}
            </Text>
          </ScrollView>
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
            style={[styles.sendBtn, !draft && { opacity: 0.5 }]}
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
    justifyContent: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  refreshBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 84,
    alignItems: "center",
  },
  refreshBtnText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  surface: { flex: 1, backgroundColor: colors.surfaceBg },
  surfaceContent: { padding: 12, alignItems: "flex-start" },
  surfaceText: {
    color: "#d0d0d6",
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "left",
  },
  inputRow: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  input: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderRadius: 8,
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
    backgroundColor: colors.primary,
    borderRadius: 8,
    minWidth: 64,
    alignItems: "center",
  },
  sendBtnText: { color: "#fff", fontWeight: "600" },
});
