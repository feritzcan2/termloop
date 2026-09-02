export type NotificationPreferences = {
  enabled: boolean;
  notifyWhenFocused: boolean;
  playSound: boolean;
};

export const defaultNotificationPreferences: Readonly<NotificationPreferences> = Object.freeze({
  enabled: true,
  notifyWhenFocused: false,
  playSound: true,
});

export function notificationPreferencesOf(value: unknown): NotificationPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== "boolean"
    || typeof candidate.notifyWhenFocused !== "boolean"
    || typeof candidate.playSound !== "boolean"
  ) return undefined;
  return {
    enabled: candidate.enabled,
    notifyWhenFocused: candidate.notifyWhenFocused,
    playSound: candidate.playSound,
  };
}

export function shouldShowAgentAttentionNotification(
  preferences: NotificationPreferences,
  context: { supported: boolean; appFocused: boolean },
): boolean {
  return preferences.enabled
    && context.supported
    && (preferences.notifyWhenFocused || !context.appFocused);
}
