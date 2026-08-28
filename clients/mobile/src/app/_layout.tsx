import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { mobileRuntime } from "@/composition/mobile-runtime";
import { RuntimeProvider } from "@/composition/runtime-context";
import { ConnectionProvider } from "@/features/connection/connection-store";
import { NotificationCoordinator } from "@/features/notifications/notification-coordinator";
import { OverviewProvider } from "@/features/overview/overview-store";
import { WatchSyncCoordinator } from "@/features/watch/watch-sync-coordinator";
import { StewardVoiceDock } from "@/components/steward-voice-dock";
import { AppLifecycleProvider } from "@/platform/app-lifecycle";
import { color } from "@/theme/tokens";

/// The native header is off for every route. Each screen renders its own 47pt header
/// so it can carry the Project selector and a compact right slot at the geometry the
/// legacy mobile client proved on a phone; the stack still owns navigation and the
/// iOS back gesture.
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppLifecycleProvider>
        <RuntimeProvider runtime={mobileRuntime}>
          <ConnectionProvider>
            <OverviewProvider>
              <NotificationCoordinator />
              <WatchSyncCoordinator />
              <StatusBar style="light" />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: color.bgApp },
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="settings" />
                <Stack.Screen name="pair" options={{ presentation: "modal" }} />
                <Stack.Screen name="project/[projectId]" />
                <Stack.Screen name="task/[taskId]" />
                <Stack.Screen name="launch/[taskId]" options={{ presentation: "modal" }} />
                <Stack.Screen name="steward/[projectId]" />
                <Stack.Screen name="session/[sessionId]" />
              </Stack>
              <StewardVoiceDock />
            </OverviewProvider>
          </ConnectionProvider>
        </RuntimeProvider>
      </AppLifecycleProvider>
    </SafeAreaProvider>
  );
}
