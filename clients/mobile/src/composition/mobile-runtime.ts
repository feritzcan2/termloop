import { createMockRuntime } from "@/adapters/mock/mock-runtime";
import { createProductionRuntime } from "@/adapters/production/production-runtime";
import { waitForGatewayReachability } from "@/adapters/production/gateway-compatibility";
import { nativeSecretStore } from "@/platform/native-secret-store";
import { createSecureConnectionRepository } from "@/platform/secure-connections";
import { createStewardVoiceReceiptStore } from "@/platform/steward-voice-receipts";
import { watchSyncBridge } from "@/platform/watch-sync";
import { createWatchTargetSettings } from "@/platform/watch-target-settings";

const productionRuntime = createProductionRuntime({
  repository: createSecureConnectionRepository(nativeSecretStore),
  multiplexSocketFactory: (url) => new WebSocket(url) as never,
  connectionPreflight: (connection) => waitForGatewayReachability(connection, fetch),
  voiceReceipts: createStewardVoiceReceiptStore(nativeSecretStore),
  watchTargetSettings: createWatchTargetSettings(nativeSecretStore),
  watchBridge: watchSyncBridge,
});

export const mobileRuntime = __DEV__ && process.env.EXPO_PUBLIC_TERMLOOP_RUNTIME !== "production"
  ? createMockRuntime()
  : productionRuntime;
