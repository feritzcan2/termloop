import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getTermLoopClient } from './termloop-client-singleton';
import { getConnections } from './connections';
import { getTermLoopPassword } from './secrets';
import {
  ensurePermission,
  registerNotificationCategories,
  onNotificationAction,
  type NotificationActionResponse,
} from './termloop-notifications';

let cachedToken: { token: string; platform: 'ios' | 'android' } | null = null;

async function fetchDeviceToken(): Promise<{ token: string; platform: 'ios' | 'android' } | null> {
  if (cachedToken) return cachedToken;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  if (!(await ensurePermission())) return null;
  try {
    const result = await Notifications.getDevicePushTokenAsync();
    if (!result?.data) return null;
    cachedToken = { token: result.data, platform: Platform.OS as 'ios' | 'android' };
    return cachedToken;
  } catch (e) {
    console.warn('getDevicePushTokenAsync failed', e);
    return null;
  }
}

const environment: 'development' | 'production' =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'development' : 'production';

async function registerWithTermLoop(): Promise<void> {
  const tok = await fetchDeviceToken();
  if (!tok) return;
  try {
    const client = getTermLoopClient();
    await client.pushRegister(tok.token, tok.platform, environment);
  } catch (e) {
    console.warn('push.register RPC failed', e);
  }
}

/**
 * Make sure the termloop singleton is connected before handling an action.
 * Chooses the most-recently connected termloop entry from AsyncStorage.
 * Throws with a user-facing message on any failure.
 */
export async function ensureTermLoopReady(): Promise<void> {
  const client = getTermLoopClient();
  if (client.currentState === 'ready') return;

  const connections = await getConnections();
  const candidates = connections
    .filter((c) => c.host && c.termloop?.port)
    .sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0));
  if (candidates.length === 0) {
    throw new Error('Kayıtlı TermLoop bağlantısı yok');
  }
  const conn = candidates[0];
  const pw = await getTermLoopPassword(conn.id);
  if (!pw) {
    throw new Error(`${conn.label || conn.host}: TermLoop şifresi yok (bağlantıyı yeniden kaydet)`);
  }
  if (client.currentState !== 'idle' && client.currentState !== 'disconnected' && client.currentState !== 'error') {
    // currently connecting/authenticating — wait up to 3s
    await new Promise<void>((resolve) => {
      const unsub = client.onStateChange((s) => {
        if (s === 'ready' || s === 'error' || s === 'disconnected') {
          unsub();
          resolve();
        }
      });
      setTimeout(() => { unsub(); resolve(); }, 3000);
    });
    if (client.currentState === 'ready') return;
  }
  await client.connect(conn.host, conn.termloop.port, pw);
}

export type PushLifecycleOptions = {
  onAction: (resp: NotificationActionResponse) => void | Promise<void>;
};

export async function startPushLifecycle(opts: PushLifecycleOptions): Promise<() => void> {
  await registerNotificationCategories();
  await registerWithTermLoop();

  const client = getTermLoopClient();
  const offReconn = client.onReconnect(() => {
    void registerWithTermLoop();
  });

  const offAction = onNotificationAction((resp) => {
    void opts.onAction(resp);
  });

  // Handle the cold-start case: app was killed, user tapped an action, iOS
  // relaunched us. `addNotificationResponseReceivedListener` doesn't fire
  // for responses received before the listener was attached — we have to
  // pull the last response manually.
  try {
    const last = await Notifications.getLastNotificationResponseAsync();
    if (last) {
      const ws = last.notification.request.content.data?.workspaceId;
      if (typeof ws === 'string') {
        const rawAction = last.actionIdentifier;
        const isDefault = rawAction === Notifications.DEFAULT_ACTION_IDENTIFIER;
        void opts.onAction({
          actionId: isDefault ? 'default' : (rawAction as any),
          workspaceId: ws,
          userText: last.userText,
        });
      }
    }
  } catch (e) {
    console.warn('[push] getLastNotificationResponseAsync failed', e);
  }

  return () => {
    offReconn();
    offAction();
  };
}
