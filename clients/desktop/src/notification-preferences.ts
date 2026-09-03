export type RemoteNotificationPreferences = {
  enabled: boolean;
  agentNeedsInput: boolean;
  agentReadyForReview: boolean;
  stewardMessages: boolean;
  playSound: boolean;
};

export type DesktopNotificationPreferences = {
  enabled: boolean;
  notifyWhenFocused: boolean;
  playSound: boolean;
};

export type NotificationPreferences = DesktopNotificationPreferences & {
  mobile: RemoteNotificationPreferences;
  watch: RemoteNotificationPreferences;
};

const defaultRemoteNotificationPreferences: Readonly<RemoteNotificationPreferences> = Object.freeze({
  enabled: true,
  agentNeedsInput: true,
  agentReadyForReview: true,
  stewardMessages: true,
  playSound: true,
});

export const defaultNotificationPreferences: Readonly<NotificationPreferences> = Object.freeze({
  enabled: true,
  notifyWhenFocused: false,
  playSound: true,
  mobile: defaultRemoteNotificationPreferences,
  watch: defaultRemoteNotificationPreferences,
});

export function notificationPreferencesOf(value: unknown): NotificationPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== "boolean"
    || typeof candidate.notifyWhenFocused !== "boolean"
    || typeof candidate.playSound !== "boolean"
  ) return undefined;
  const mobile = candidate.mobile === undefined
    ? { ...defaultRemoteNotificationPreferences }
    : remoteNotificationPreferencesOf(candidate.mobile);
  const watch = candidate.watch === undefined
    ? { ...defaultRemoteNotificationPreferences }
    : remoteNotificationPreferencesOf(candidate.watch);
  if (!mobile || !watch) return undefined;
  return {
    enabled: candidate.enabled,
    notifyWhenFocused: candidate.notifyWhenFocused,
    playSound: candidate.playSound,
    mobile,
    watch,
  };
}

function remoteNotificationPreferencesOf(value: unknown): RemoteNotificationPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.enabled !== "boolean"
    || typeof candidate.agentNeedsInput !== "boolean"
    || typeof candidate.agentReadyForReview !== "boolean"
    || typeof candidate.stewardMessages !== "boolean"
    || typeof candidate.playSound !== "boolean"
  ) return undefined;
  return {
    enabled: candidate.enabled,
    agentNeedsInput: candidate.agentNeedsInput,
    agentReadyForReview: candidate.agentReadyForReview,
    stewardMessages: candidate.stewardMessages,
    playSound: candidate.playSound,
  };
}

export function shouldShowAgentAttentionNotification(
  preferences: DesktopNotificationPreferences,
  context: { supported: boolean; appFocused: boolean },
): boolean {
  return preferences.enabled
    && context.supported
    && (preferences.notifyWhenFocused || !context.appFocused);
}
