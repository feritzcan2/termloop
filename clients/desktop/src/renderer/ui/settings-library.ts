import { useCallback, useEffect, useState } from "react";

/// One loaded copy of an application-settings catalog, shared by the rail that
/// lists it and the stage page that edits one entry. A save in the editor hands
/// the fresh catalog back through `set`, so the rail behind it updates without a
/// second daemon read. Nothing loads until something is actually showing it.
export function useSettingsLibrary<T>(load: () => Promise<T>, active: boolean): {
  value: T | undefined;
  error: string | undefined;
  loading: boolean;
  set(value: T): void;
  reload(): void;
} {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!active) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    void load().then((result) => {
      if (live) setValue(result);
    }).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, [active, load, reloadToken]);

  return {
    value,
    error,
    loading,
    set: setValue,
    reload: useCallback(() => setReloadToken((current) => current + 1), []),
  };
}
