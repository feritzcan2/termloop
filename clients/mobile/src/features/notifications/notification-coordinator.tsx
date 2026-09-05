import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import {
  notificationDestinationFromRemote,
  notificationRoute,
  resolveNotificationConnectionId,
  type NotificationDestination,
} from "@/features/notifications/notification-navigation";
import { useOverview } from "@/features/overview/overview-store";
import { mobileDiagnostics } from "@/platform/mobile-diagnostics";

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
      } catch (cause: unknown) {
        mobileDiagnostics.report("notification", "registration_failed", {
          connectionId,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
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
    let active = true;
    const receive = (response: Notifications.NotificationResponse | null) => {
      if (!active || response === null) return;
      const identifier = response.notification.request.identifier;
      if (handledResponse.current === identifier) return;
      handledResponse.current = identifier;
      const destination = notificationDestinationFromRemote(
        response.notification.request.content.data,
        response.notification.request.trigger,
      );
      mobileDiagnostics.report("notification", destination === undefined ? "response_rejected" : "response_received", {
        hasDestination: destination !== undefined,
        hasConnectionHint: destination?.connectionId !== undefined,
        reason: destination?.kind,
      });
      if (destination === undefined) {
        void clearNotificationResponse();
        return;
      }
      // Keep the native response until routing succeeds. If iOS kills the app while
      // its paired-Mac catalog is still loading, the next cold start can try again.
      setPendingDestination(destination);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(receive);
    void Notifications.getLastNotificationResponseAsync().then(receive, (cause: unknown) => {
      mobileDiagnostics.report("notification", "response_read_failed", {
        causeType: cause instanceof Error ? cause.name : typeof cause,
      });
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

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

    router.push(notificationRoute(pendingDestination, connectionId));
    mobileDiagnostics.report("notification", "route_replaced", {
      connectionId,
      reason: pendingDestination.kind,
      ...(pendingDestination.kind === "session"
        ? { sessionId: pendingDestination.sessionId }
        : { projectId: pendingDestination.projectId }),
    });
    setPendingDestination(undefined);
    void clearNotificationResponse();
    void Notifications.setBadgeCountAsync(0);
  }, [connections.connections, connections.select, connections.selectedId, overview.byConnection, pendingDestination, router]);

  return null;
}

async function clearNotificationResponse(): Promise<void> {
  try {
    await Notifications.clearLastNotificationResponseAsync();
  } catch (cause: unknown) {
    mobileDiagnostics.report("notification", "response_clear_failed", {
      causeType: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}
