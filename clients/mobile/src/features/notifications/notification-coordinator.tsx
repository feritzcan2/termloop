import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import {
  notificationDestination,
  resolveNotificationConnectionId,
  type NotificationDestination,
} from "@/features/notifications/notification-navigation";
import { useOverview } from "@/features/overview/overview-store";

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
  const overview = useOverview();
  const router = useRouter();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledResponse = useRef<string | undefined>(undefined);
  const [pendingDestination, setPendingDestination] = useState<NotificationDestination | undefined>();

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
    if (!lastResponse) return;
    const identifier = lastResponse.notification.request.identifier;
    if (handledResponse.current === identifier) return;
    const destination = notificationDestination(lastResponse.notification.request.content.data);
    if (destination === undefined) return;
    handledResponse.current = identifier;
    if (destination.connectionId !== undefined) connections.select(destination.connectionId);
    setPendingDestination(destination);
    void Notifications.clearLastNotificationResponseAsync();
  }, [connections.select, lastResponse]);

  useEffect(() => {
    if (pendingDestination === undefined) return;
    const scopes = connections.connections.map((connection) => {
      const projection = overview.byConnection.get(connection.id)?.overview;
      return {
        connectionId: connection.id,
        sessionIds: projection?.sessions.map(({ id }) => id) ?? [],
        projectIds: projection?.projects.map(({ id }) => id) ?? [],
      };
    });
    const connectionId = resolveNotificationConnectionId(pendingDestination, scopes);
    if (connectionId === undefined) return;
    if (connections.selectedId !== connectionId) {
      connections.select(connectionId);
      return;
    }

    if (pendingDestination.kind === "steward") {
      // The phone does not have a Steward chat route yet. Land on the exact
      // Project instead of trying to open the synthetic Watch chat Session ID.
      router.navigate({
        pathname: "/project/[projectId]",
        params: { projectId: pendingDestination.projectId, connectionId },
      });
    } else {
      router.navigate({
        pathname: "/session/[sessionId]",
        params: { sessionId: pendingDestination.sessionId, connectionId },
      });
    }
    setPendingDestination(undefined);
    void Notifications.setBadgeCountAsync(0);
  }, [connections.connections, connections.select, connections.selectedId, overview.byConnection, pendingDestination, router]);

  return null;
}
