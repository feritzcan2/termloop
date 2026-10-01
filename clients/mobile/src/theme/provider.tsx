import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";
import { Appearance } from "react-native";

import { createAppearanceStore, type AppearancePreferences, type AppearanceStore } from "./appearance-store";
import { ThemeContext } from "./context";
import { themes } from "./tokens";

const AppearanceContext = createContext<AppearanceStore | undefined>(undefined);

export function ThemeProvider({ preferences, children }: PropsWithChildren<{ preferences: AppearancePreferences }>) {
  const [store] = useState(() => createAppearanceStore(preferences));
  const mode = useSyncExternalStore(store.subscribe, store.getMode, store.getMode);
  const ready = useSyncExternalStore(store.subscribe, store.isReady, store.isReady);

  useEffect(() => { void store.initialize(); }, [store]);
  useEffect(() => {
    Appearance.setColorScheme(mode);
  }, [mode]);

  // Restore the preference before mounting navigation or opening a connection.
  if (!ready) return null;
  return (
    <AppearanceContext.Provider value={store}>
      <ThemeContext.Provider value={themes[mode]}>{children}</ThemeContext.Provider>
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  const store = useContext(AppearanceContext);
  if (store === undefined) throw new Error("Appearance requires ThemeProvider");
  return store;
}
