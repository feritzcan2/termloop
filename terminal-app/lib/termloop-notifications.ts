import * as Notifications from 'expo-notifications';

export type AttentionPayload = {
  workspaceId: string;
  projectId?: string;
  workspaceName: string;
  messagePreview: string;
  kind: 'stop' | 'notification';
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

let permissionGranted: boolean | null = null;

export async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') {
    permissionGranted = true;
    return true;
  }
  const req = await Notifications.requestPermissionsAsync();
  permissionGranted = req.status === 'granted';
  return permissionGranted;
}

export async function fireAttentionNotification(p: AttentionPayload): Promise<void> {
  if (!(await ensurePermission())) return;
  const title =
    p.kind === 'notification' ? `${p.workspaceName} · izin bekliyor` : p.workspaceName;
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body: p.messagePreview,
      data: { workspaceId: p.workspaceId, kind: p.kind },
    },
    trigger: null,
  });
}

export const CATEGORY_ATTENTION = 'TERMLOOP_ATTENTION';

export type NotificationActionId = 'continue' | 'stop' | 'reply';

export type NotificationActionResponse = {
  actionId: NotificationActionId | 'default';
  workspaceId: string;
  userText?: string;
};

export async function registerNotificationCategories(): Promise<void> {
  try {
    const result = await Notifications.setNotificationCategoryAsync(
      CATEGORY_ATTENTION,
      [
        {
          identifier: 'continue',
          buttonTitle: 'Devam Et',
          options: { opensAppToForeground: false },
        },
        {
          identifier: 'reply',
          buttonTitle: 'Cevap Yaz',
          textInput: { submitButtonTitle: 'Gönder', placeholder: 'Cevap yaz' },
          options: { opensAppToForeground: false },
        },
        {
          identifier: 'stop',
          buttonTitle: 'Dur',
          options: { opensAppToForeground: false, isDestructive: true },
        },
      ]
    );
    console.log('[push] registered category', CATEGORY_ATTENTION, 'actions:', result?.actions?.length);
  } catch (e) {
    console.warn('[push] setNotificationCategoryAsync failed', e);
  }
}

export function onNotificationAction(
  cb: (resp: NotificationActionResponse) => void
): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const ws = response.notification.request.content.data?.workspaceId;
    if (typeof ws !== 'string') return;
    const rawAction = response.actionIdentifier;
    const isDefault = rawAction === Notifications.DEFAULT_ACTION_IDENTIFIER;
    cb({
      actionId: isDefault ? 'default' : (rawAction as NotificationActionId),
      workspaceId: ws,
      userText: response.userText,
    });
  });
  return () => sub.remove();
}
