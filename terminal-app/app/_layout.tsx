import React, { useEffect, useRef, useState } from 'react';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { Alert, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  useFonts,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import { colors } from '../lib/design';
import { palette } from '../lib/palette';
import { startPushLifecycle, ensureTermLoopReady } from '../lib/push';
import { getTermLoopClient } from '../lib/termloop-client-singleton';
import { formatRpcError } from '../lib/termloop-client';
import { getRestorableTerminalResumeRoutes } from '../lib/terminal-resume-route';
import { getTerminalRouteIdentity } from '../lib/terminal-route-instance';
import * as OwnedSessions from '../lib/owned-claude-sessions';

function summarizeTerminalRoute(route: {
  id: string;
  instanceId?: string;
  resume?: string;
  workspaceId?: string;
}): string {
  const bits = [
    route.workspaceId ?? '-',
    route.resume ?? '-',
    route.instanceId ?? route.id,
  ];
  return bits.join(' | ');
}

export default function RootLayout() {
  const [loaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    JetBrainsMono_700Bold,
  });

  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const startupNavigationHandledRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const restoreDebugShownRef = useRef(false);
  const [pushLifecycleReady, setPushLifecycleReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    startPushLifecycle({
      onAction: async (resp) => {
        const { actionId, workspaceId, userText } = resp;
        startupNavigationHandledRef.current = true;
        console.log('[push] action', actionId, workspaceId, userText ? 'userText=' + userText.length + 'ch' : '');

        if (actionId === 'default') {
          router.push(`/termloop/reply/${workspaceId}`);
          return;
        }

        const textToSend =
          actionId === 'continue' ? 'devam et\n' :
          actionId === 'stop'     ? 'dur\n' :
          actionId === 'reply' && userText ? userText + '\n' :
          null;
        if (textToSend == null) return;

        try {
          await ensureTermLoopReady();
          const client = getTermLoopClient();
          await client.surfaceSendText(workspaceId, textToSend);
          console.log('[push] action sent', actionId);
        } catch (e) {
          const msg = formatRpcError(e);
          console.warn('[push] action failed', actionId, msg);
          Alert.alert(`"${actionId}" gönderilemedi`, msg);
        }
      },
    }).then((fn) => {
      dispose = fn;
      if (!cancelled) setPushLifecycleReady(true);
    }).catch((e) => {
      console.warn('[push] startPushLifecycle failed', e);
      if (!cancelled) setPushLifecycleReady(true);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [router]);

  useEffect(() => {
    if (!loaded || !pushLifecycleReady) return;
    if (startupNavigationHandledRef.current) return;
    if (!rootNavigationState?.key) return;
    if (restoreInFlightRef.current) return;

    let cancelled = false;
    restoreInFlightRef.current = true;
    getRestorableTerminalResumeRoutes()
      .then((routes) => {
        if (cancelled || startupNavigationHandledRef.current) return;
        OwnedSessions.replaceAll(
          routes
            .filter((route) => route.workspaceId)
            .map((route) => ({
              workspaceId: route.workspaceId!,
              sessionId: route.resume,
            }))
        );
        const currentTerminalIds = new Set(
          rootNavigationState.routes
            .filter((route) => route.name === 'terminal/[id]')
            .map((route) =>
              getTerminalRouteIdentity(route.params as Record<string, unknown> | undefined)
            )
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
        );
        const currentTerminalSummaries = rootNavigationState.routes
          .filter((route) => route.name === 'terminal/[id]')
          .map((route) => {
            const params = route.params as Record<string, unknown> | undefined;
            return summarizeTerminalRoute({
              id: typeof params?.id === 'string' ? params.id : route.key,
              instanceId: getTerminalRouteIdentity(params),
              resume: typeof params?.resume === 'string' ? params.resume : undefined,
              workspaceId: typeof params?.workspaceId === 'string' ? params.workspaceId : undefined,
            });
          });
        const missingRoutes = routes.filter(
          (route) => !currentTerminalIds.has(route.instanceId)
        );
        const persistedSummaries = routes.map((route) =>
          summarizeTerminalRoute({
            id: route.id,
            instanceId: route.instanceId,
            resume: route.resume,
            workspaceId: route.workspaceId,
          })
        );
        const missingSummaries = missingRoutes.map((route) =>
          summarizeTerminalRoute({
            id: route.id,
            instanceId: route.instanceId,
            resume: route.resume,
            workspaceId: route.workspaceId,
          })
        );
        console.warn(
          '[terminal][restore-debug]',
          JSON.stringify(
            {
              persistedCount: routes.length,
              currentCount: currentTerminalSummaries.length,
              missingCount: missingSummaries.length,
              persisted: persistedSummaries,
              current: currentTerminalSummaries,
              missing: missingSummaries,
            },
            null,
            2
          )
        );
        if (!restoreDebugShownRef.current && routes.length > 0) {
          restoreDebugShownRef.current = true;
          Alert.alert(
            'Terminal Restore Debug',
            [
              `persisted=${routes.length}`,
              `current=${currentTerminalSummaries.length}`,
              `missing=${missingSummaries.length}`,
              '',
              `persisted: ${persistedSummaries.join(' || ') || '-'}`,
              `current: ${currentTerminalSummaries.join(' || ') || '-'}`,
              `missing: ${missingSummaries.join(' || ') || '-'}`,
            ].join('\n')
          );
        }
        if (missingRoutes.length === 0) return;
        void (async () => {
          for (const route of missingRoutes) {
            if (cancelled) return;
            router.push({
              pathname: '/terminal/[id]',
              params: {
                id: route.id,
                instanceId: route.instanceId,
                resume: route.resume,
                ...(route.cwd ? { cwd: route.cwd } : {}),
                ...(route.workspaceId ? { workspaceId: route.workspaceId } : {}),
              },
            });
            // Native stack pushes issued in the same task can collapse into a
            // single screen. Yield between restores so every terminal gets its
            // own route entry.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        })();
      })
      .catch((e) => {
        console.warn('[terminal] startup restore failed', e);
      })
      .finally(() => {
        restoreInFlightRef.current = false;
      });

    return () => {
      cancelled = true;
    };
  }, [loaded, pushLifecycleReady, rootNavigationState, router]);

  if (!loaded) {
    return (
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: palette.bg }} />
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerTintColor: palette.ink1,
        headerTitleStyle: { fontSize: 16, fontWeight: '600' },
        contentStyle: { backgroundColor: palette.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="terminal/[id]"
        options={{
          headerTitle: 'Terminal',
          headerBackTitle: 'Back',
        }}
        getId={({ params }) => getTerminalRouteIdentity(params as Record<string, unknown> | undefined)}
      />
      <Stack.Screen
        name="termloop/[id]"
        options={{
          headerShown: false,
        }}
      />
      {/* E1: Quick-reply screens */}
      <Stack.Screen
        name="termloop/attention"
        options={{ headerTitle: 'Waiting Agents' }}
      />
      <Stack.Screen
        name="termloop/reply/[workspaceId]"
        options={{ headerTitle: '' }}
      />
      <Stack.Screen
        name="termloop/changes/[workspaceId]"
        options={{ headerTitle: '' }}
      />
      <Stack.Screen
        name="connection/new"
        options={{
          headerTitle: 'New Connection',
          presentation: 'modal',
        }}
      />
      <Stack.Screen
        name="connection/[id]"
        options={{
          headerTitle: 'Connection',
          headerBackTitle: 'Back',
        }}
      />
    </Stack>
    </GestureHandlerRootView>
  );
}
