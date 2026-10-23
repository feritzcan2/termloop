import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react";

import {
  createTerminalPreferencesStore,
  type TerminalPreferences,
  type TerminalPreferencesStorage,
  type TerminalPreferencesStore,
} from "./terminal-preferences-store";

const TerminalPreferencesContext = createContext<TerminalPreferencesStore | undefined>(undefined);

/// Unlike appearance, nothing waits on this: the terminal starts on defaults and
/// adopts the stored choices the moment they are read.
export function TerminalPreferencesProvider({ storage, children }: PropsWithChildren<{ storage: TerminalPreferencesStorage }>) {
  const [store] = useState(() => createTerminalPreferencesStore(storage));
  useEffect(() => { void store.initialize(); }, [store]);
  return <TerminalPreferencesContext.Provider value={store}>{children}</TerminalPreferencesContext.Provider>;
}

export function useTerminalPreferencesStore(): TerminalPreferencesStore {
  const store = useContext(TerminalPreferencesContext);
  if (store === undefined) throw new Error("Terminal preferences require TerminalPreferencesProvider");
  return store;
}

export function useTerminalPreferences(): TerminalPreferences {
  const store = useTerminalPreferencesStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
