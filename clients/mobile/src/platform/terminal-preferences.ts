import * as SecureStore from "expo-secure-store";

import type { TerminalPreferencesStorage } from "@/features/terminal/terminal-preferences-store";

const STORAGE_KEY = "termloop.terminal-preferences.v1";

export const terminalPreferencesStorage: TerminalPreferencesStorage = {
  read: () => SecureStore.getItemAsync(STORAGE_KEY),
  write: (serialized) => SecureStore.setItemAsync(STORAGE_KEY, serialized),
};
