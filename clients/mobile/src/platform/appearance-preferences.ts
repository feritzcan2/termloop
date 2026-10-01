import * as SecureStore from "expo-secure-store";

import type { AppearancePreferences } from "../theme/appearance-store";

const STORAGE_KEY = "termloop.appearance.v1";

export const appearancePreferences: AppearancePreferences = {
  read: () => SecureStore.getItemAsync(STORAGE_KEY),
  write: (mode) => SecureStore.setItemAsync(STORAGE_KEY, mode),
};
