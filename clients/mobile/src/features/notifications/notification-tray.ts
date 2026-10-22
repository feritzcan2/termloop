import * as Notifications from "expo-notifications";

import {
  attentionNotificationOf,
  staleAttentionNotifications,
  type AttentionScope,
  type PresentedAttentionNotification,
} from "@/features/notifications/notification-reconciliation";
import { mobileDiagnostics } from "@/platform/mobile-diagnostics";

/// Removes agent alerts whose attention was already handled on another device.
/// Tray inspection is best-effort: a failure leaves the alerts for the next read.
export async function reconcileAttentionTray(scopes: readonly AttentionScope[]): Promise<void> {
  if (scopes.length === 0) return;
  await dismissPresented("reconciled", (presented) => staleAttentionNotifications(presented, scopes));
}

/// Opening an Agent on the phone answers every alert that pointed at it.
export async function dismissSessionNotifications(sessionId: string): Promise<void> {
  await dismissPresented("session_opened", (presented) => presented
    .filter((notification) => notification.sessionId === sessionId)
    .map(({ identifier }) => identifier));
}

async function dismissPresented(
  reason: string,
  select: (presented: readonly PresentedAttentionNotification[]) => readonly string[],
): Promise<void> {
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    const presented = delivered.flatMap((notification) => {
      const attention = attentionNotificationOf(
        notification.request.identifier,
        notification.date,
        notification.request.content.data,
        notification.request.trigger,
      );
      return attention === undefined ? [] : [attention];
    });
    const identifiers = new Set(select(presented));
    if (identifiers.size === 0) return;
    await Promise.all([...identifiers].map((identifier) => Notifications.dismissNotificationAsync(identifier)));
    await Notifications.setBadgeCountAsync(delivered.length - identifiers.size);
    mobileDiagnostics.report("notification", "tray_dismissed", { reason, count: identifiers.size });
  } catch (cause: unknown) {
    mobileDiagnostics.report("notification", "tray_dismiss_failed", {
      reason,
      causeType: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}
