import { NativeModules, Platform } from "react-native";

type DictationResult = {
  text?: string;
};

type NativeVoiceDictation = {
  start?: () => Promise<void>;
  stop?: () => Promise<DictationResult>;
  cancel?: () => Promise<void>;
};

const nativeModule = NativeModules.TermLoopVoiceDictation as
  | NativeVoiceDictation
  | undefined;

export function isVoiceDictationAvailable(): boolean {
  return Platform.OS === "ios" && Boolean(nativeModule?.start && nativeModule.stop);
}

export async function startVoiceDictation(): Promise<void> {
  if (!isVoiceDictationAvailable() || !nativeModule?.start) {
    throw new Error("Voice input is available on iOS development builds.");
  }
  await nativeModule.start();
}

export async function stopVoiceDictation(): Promise<string> {
  if (!isVoiceDictationAvailable() || !nativeModule?.stop) {
    throw new Error("Voice input is available on iOS development builds.");
  }
  const result = await nativeModule.stop();
  return result?.text?.trim() ?? "";
}

export async function cancelVoiceDictation(): Promise<void> {
  if (!isVoiceDictationAvailable() || !nativeModule?.cancel) return;
  await nativeModule.cancel();
}

