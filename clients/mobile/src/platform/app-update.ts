export type AppUpdatePhase = "checking" | "downloading" | "reloading";
export type AppUpdateResult = "current" | "disabled" | "reloading";

export interface AppUpdateClient {
  readonly enabled: boolean;
  fetch(): Promise<{ isNew: boolean; isRollBackToEmbedded: boolean }>;
  reload(): Promise<void>;
}

/// Pulls the newest update compatible with the installed native runtime and
/// immediately swaps to it. The client seam keeps release-only expo-updates
/// behavior testable without pretending Expo Go can execute an OTA reload.
export async function forceLatestAppUpdate(options: {
  client: AppUpdateClient;
  onPhase?: (phase: AppUpdatePhase) => void;
}): Promise<AppUpdateResult> {
  const client = options.client;
  if (!client.enabled) return "disabled";

  options.onPhase?.("checking");
  options.onPhase?.("downloading");
  const update = await client.fetch();
  if (!update.isNew && !update.isRollBackToEmbedded) return "current";

  options.onPhase?.("reloading");
  await client.reload();
  return "reloading";
}
