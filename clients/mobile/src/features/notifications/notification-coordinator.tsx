import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function NotificationCoordinator() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const router = useRouter();
  const handledResponse = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (Platform.OS !== "ios" || runtime.kind !== "production") return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connectionId = connections.selected?.availability === "online"
      ? connections.selected.id
      : undefined;
    if (connectionId === undefined) return;

    const register = async () => {
      try {
        let permission = await Notifications.getPermissionsAsync();
        if (!permission.granted && permission.canAskAgain) {
          permission = await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: true, allowSound: true },
          });
        }
        if (!permission.granted || !active) return;
        const token = await Notifications.getDevicePushTokenAsync();
        const environment = await Application.getIosPushNotificationServiceEnvironmentAsync();
        const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
        if (token.type !== "ios" || typeof token.data !== "string" || !bundleId || environment === null) return;
        await runtime.notifications.registerDevice(connectionId, {
          deviceToken: token.data,
          environment,
          bundleId,
        });
      } catch {
        if (active) retry = setTimeout(register, 10_000);
      }
    };
    void register();
    return () => {
      active = false;
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [runtime, connections.selected?.id, connections.selected?.availability]);

  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const identifier = response.notification.request.identifier;
      if (handledResponse.current === identifier) return;
      const data = response.notification.request.content.data ?? {};
      const connectionId = typeof data.connectionId === "string" ? data.connectionId : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      const chatProjectId = typeof data.chatProjectId === "string" ? data.chatProjectId : undefined;
      if (!connectionId || (!sessionId && !chatProjectId)) return;
      handledResponse.current = identifier;
      connections.select(connectionId);
      if (chatProjectId) {
        // The phone does not have a Steward chat route yet. Land on the exact
        // Project instead of trying to open the synthetic Watch chat Session ID.
        router.navigate({ pathname: "/project/[projectId]", params: { projectId: chatProjectId } });
      } else if (sessionId) {
        router.navigate({ pathname: "/session/[sessionId]", params: { sessionId } });
      }
      void Notifications.setBadgeCountAsync(0);
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [connections.select, router]);

  return null;
}
