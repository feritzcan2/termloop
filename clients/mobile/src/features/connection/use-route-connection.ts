import { useFocusEffect } from "expo-router";
import { useCallback } from "react";

// Retained native-stack routes must not fight over the global selection. Select
// on focus (or a route parameter change), without reacting to later selections
// made by a notification or another screen before navigation finishes.
export function useRouteConnection(
  connectionId: string | undefined,
  select: (connectionId: string) => void,
): void {
  useFocusEffect(useCallback(() => {
    if (connectionId !== undefined) select(connectionId);
  }, [connectionId, select]));
}
