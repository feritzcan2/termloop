import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { getActiveClient } from "../lib/session";
import { colors } from "../lib/theme";

const ATTENTION_CATEGORY = "TERMLOOP_ATTENTION";
const REPLY_ACTION = "REPLY";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Fire-and-forget: must be registered before the first push delivers so
// the Reply action (text input → keyboard mic for dictation) appears.
Notifications.setNotificationCategoryAsync(ATTENTION_CATEGORY, [
  {
    identifier: REPLY_ACTION,
    buttonTitle: "Reply",
    options: { opensAppToForeground: false },
    textInput: { submitButtonTitle: "Send", placeholder: "Dictate or type…" },
  },
]).catch(() => {
  /* best effort — Android no-ops */
});

function extractWorkspaceId(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data as Record<string, unknown>;
  const id = data?.workspace_id;
  return typeof id === "string" && id ? id : null;
}

async function deliverReply(workspaceId: string, text: string): Promise<void> {
  const client = getActiveClient();
  if (!client) return;
  await client.sendText(workspaceId, text);
  // Mirror terminal Send button: prefer named Enter key, fall back to "\r".
  try {
    await client.sendKey(workspaceId, "enter");
  } catch {
    await client.sendText(workspaceId, "\r");
  }
}

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    // Cold start: app was killed, user tapped a notification
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const wsId = extractWorkspaceId(response);
      if (wsId && getActiveClient()) {
        router.navigate({ pathname: "/connected", params: { notifWorkspaceId: wsId } });
      }
    });

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const wsId = extractWorkspaceId(response);
      if (!wsId) return;

      if (response.actionIdentifier === REPLY_ACTION) {
        const text = (response.userText ?? "").trim();
        if (text) {
          // Don't navigate — user replied from the lock screen / Watch
          // and expects the app to stay where it was.
          deliverReply(wsId, text).catch(() => {
            /* TCP may be down; reply is dropped for MVP */
          });
        }
        return;
      }

      if (getActiveClient()) {
        router.navigate({ pathname: "/connected", params: { notifWorkspaceId: wsId } });
      } else {
        router.navigate("/");
      }
    });

    return () => sub.remove();
  }, [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontSize: 16, fontWeight: "600" },
          headerBackTitle: "",
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: "Connections" }} />
        <Stack.Screen name="connections/scan" options={{ title: "Pair" }} />
        <Stack.Screen name="connections/new" options={{ title: "Manual setup" }} />
        <Stack.Screen name="connected/index" options={{ title: "Connected" }} />
        <Stack.Screen
          name="connected/terminal"
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="connected/task/[id]"
          options={{ title: "Task" }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
