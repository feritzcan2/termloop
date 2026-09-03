import type { SessionDto } from "@termloop/contract/current";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import {
  sessionDismissAction,
  sessionDismissErrorMessage,
} from "@/presentation/session-actions-presentation";
import {
  SESSION_SWIPE_ACTION_WIDTH,
  sessionSwipeTranslation,
  settledSessionSwipeTranslation,
} from "@/presentation/session-swipe-presentation";
import { color, geometry } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

export function SwipeableSessionRow({ session, children }: {
  session: SessionDto;
  children: ReactNode;
}) {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  const dismissal = sessionDismissAction(session);
  const translateX = useRef(new Animated.Value(0)).current;
  const translation = useRef(0);
  const gestureStart = useRef(0);
  const [busy, setBusy] = useState(false);
  const canDismiss = dismissal !== undefined && connections.selectedId !== undefined;

  const settle = useCallback((target: number) => {
    translateX.stopAnimation();
    Animated.timing(translateX, {
      toValue: target,
      duration: 160,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) translation.current = target;
    });
  }, [translateX]);

  useEffect(() => {
    translation.current = 0;
    translateX.setValue(0);
  }, [session.id, translateX]);

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => (
      canDismiss
      && Math.abs(gesture.dx) > 8
      && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.15
      && (gesture.dx < 0 || translation.current < 0)
    ),
    onPanResponderGrant: () => {
      translateX.stopAnimation((value) => {
        translation.current = value;
        gestureStart.current = value;
      });
    },
    onPanResponderMove: (_event, gesture) => {
      const value = sessionSwipeTranslation(gestureStart.current, gesture.dx);
      translation.current = value;
      translateX.setValue(value);
    },
    onPanResponderRelease: (_event, gesture) => {
      settle(settledSessionSwipeTranslation(translation.current, gesture.vx));
    },
    onPanResponderTerminate: (_event, gesture) => {
      settle(settledSessionSwipeTranslation(translation.current, gesture.vx));
    },
    onPanResponderTerminationRequest: () => true,
  }), [canDismiss, settle, translateX]);

  const confirmDismissal = () => {
    const connectionId = connections.selectedId;
    if (!dismissal || !connectionId || busy) return;
    Alert.alert(dismissal.label, dismissal.detail, [
      { text: "Cancel", style: "cancel" },
      {
        text: dismissal.command === "terminate" ? "Close" : "Remove",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void (async () => {
            try {
              if (dismissal.command === "terminate") {
                await runtime.sessionActions.terminate(connectionId, session.id);
              }
              await runtime.sessionActions.close(connectionId, session.id);
              settle(0);
              overview.refresh();
            } catch (cause: unknown) {
              Alert.alert("Could not remove Session", sessionDismissErrorMessage(cause));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  };

  return (
    <View style={styles.clip}>
      {canDismiss ? (
        <View style={styles.actionRail}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={dismissal.label}
            accessibilityHint="Confirms before removing this Session"
            disabled={busy}
            onPress={confirmDismissal}
            style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
          >
            {busy ? <ActivityIndicator color={color.onAccent} /> : (
              <Text style={styles.actionLabel}>
                {dismissal.command === "terminate" ? "Close" : "Remove"}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}
      <Animated.View
        {...(canDismiss ? panResponder.panHandlers : {})}
        style={[styles.foreground, { transform: [{ translateX }] }]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: "hidden",
    backgroundColor: color.bgRaised,
  },
  actionRail: {
    ...StyleSheet.absoluteFill,
    alignItems: "flex-end",
    backgroundColor: color.danger,
  },
  action: {
    width: SESSION_SWIPE_ACTION_WIDTH,
    minHeight: geometry.sessionRowMinHeight,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.danger,
  },
  actionPressed: { opacity: 0.75 },
  actionLabel: {
    color: color.onAccent,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "800",
  },
  foreground: { backgroundColor: color.bgRaised },
});
