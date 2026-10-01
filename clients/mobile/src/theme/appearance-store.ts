import type { AppearanceMode } from "./tokens";

export interface AppearancePreferences {
  read(): Promise<string | null>;
  write(mode: AppearanceMode): Promise<void>;
}

export function createAppearanceStore(preferences: AppearancePreferences) {
  let mode: AppearanceMode = "light";
  let ready = false;
  let selected = false;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };

  return {
    getMode: () => mode,
    isReady: () => ready,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    initialize() {
      return initialization ??= preferences.read().then((stored) => {
        if (!selected && (stored === "light" || stored === "dark")) mode = stored;
      }).catch(() => {}).finally(() => {
        ready = true;
        publish();
      });
    },
    setMode(next: AppearanceMode) {
      selected = true;
      mode = next;
      publish();
      // Serialize writes so rapid toggles cannot persist an older selection last.
      writes = writes.then(() => preferences.write(next)).catch(() => {});
      return writes;
    },
  };
}

export type AppearanceStore = ReturnType<typeof createAppearanceStore>;
