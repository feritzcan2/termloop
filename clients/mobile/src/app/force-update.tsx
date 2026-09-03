import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { Banner, Card, PrimaryButton, SecondaryButton } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import {
  forceLatestAppUpdate,
  type AppUpdatePhase,
  type AppUpdateResult,
} from "@/platform/app-update";
import { expoAppUpdateClient } from "@/platform/expo-app-update-client";
import { color, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

type UpdateState = AppUpdatePhase | AppUpdateResult | "error";

const statusCopy: Record<Exclude<UpdateState, "error">, string> = {
  checking: "Checking the production channel…",
  downloading: "Downloading the latest compatible update…",
  reloading: "Update ready. Restarting TermLoop…",
  current: "This phone is already running the latest compatible update.",
  disabled: "OTA updates are not available in this build.",
};

export default function ForceUpdateRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ group?: string | string[] }>();
  const group = typeof params.group === "string" && /^[A-Za-z0-9-]{1,128}$/.test(params.group)
    ? params.group
    : undefined;
  const [state, setState] = useState<UpdateState>("checking");
  const [error, setError] = useState<string>();

  const update = useCallback(async () => {
    setError(undefined);
    setState("checking");
    try {
      const result = await forceLatestAppUpdate({ client: expoAppUpdateClient, onPhase: setState });
      setState(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update could not be downloaded.");
      setState("error");
    }
  }, []);

  useEffect(() => { void update(); }, [update]);

  const busy = state === "checking" || state === "downloading" || state === "reloading";
  return (
    <Screen>
      <ScreenHeader title="Force update" />
      <View style={styles.content}>
        <Card style={styles.card}>
          <View style={styles.hero}>
            {busy ? <ActivityIndicator color={color.accentStrong} size="large" /> : null}
            <Text style={styles.title}>TermLoop Mobile</Text>
            <Text style={styles.status}>
              {state === "error" ? "The update failed." : statusCopy[state]}
            </Text>
            {group === undefined ? null : (
              <Text style={styles.group} numberOfLines={1}>release {group}</Text>
            )}
          </View>
          {error === undefined ? null : <Banner kind="danger" message={error} />}
          <PrimaryButton
            label={busy ? "Updating…" : "Check again"}
            disabled={busy}
            onPress={() => { void update(); }}
          />
          <SecondaryButton label="Back to Projects" onPress={() => router.replace("/")} />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: "center", padding: space.screen },
  card: { gap: space.lg, padding: space.xl },
  hero: { alignItems: "center", gap: space.sm },
  title: { color: color.text, fontSize: 22, fontWeight: "700" },
  status: { color: color.textSecondary, fontSize: 14, lineHeight: 20, textAlign: "center" },
  group: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10 },
});
