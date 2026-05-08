import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { getActiveClient } from "../lib/session";
import { colors } from "../lib/theme";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function extractWorkspaceId(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data as Record<string, unknown>;
  const id = data?.workspace_id;
  return typeof id === "string" && id ? id : null;
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
