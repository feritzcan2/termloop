import { createMockRuntime } from "@/adapters/mock/mock-runtime";
import { createProductionRuntime } from "@/adapters/production/production-runtime";
import { nativeSecretStore } from "@/platform/native-secret-store";
import { createSecureConnectionRepository } from "@/platform/secure-connections";
import { watchSyncBridge } from "@/platform/watch-sync";
import { createWatchTargetSettings } from "@/platform/watch-target-settings";

const productionRuntime = createProductionRuntime({
  repository: createSecureConnectionRepository(nativeSecretStore),
  watchTargetSettings: createWatchTargetSettings(nativeSecretStore),
  watchBridge: watchSyncBridge,
});

export const mobileRuntime = __DEV__ && process.env.EXPO_PUBLIC_TERMLOOP_RUNTIME !== "production"
  ? createMockRuntime()
  : productionRuntime;
