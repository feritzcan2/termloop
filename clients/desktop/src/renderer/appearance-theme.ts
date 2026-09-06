export type AppearanceTheme = "dark" | "light";
export type AppearancePreference = "system" | AppearanceTheme;

export type SystemAppearanceQuery = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
};

const STORAGE_KEY = "termloop.appearance-theme";
const preferenceListeners = new Set<() => void>();
const themeListeners = new Set<() => void>();
let currentPreference: AppearancePreference = "system";
let currentTheme: AppearanceTheme = "dark";
let systemAppearanceQuery: SystemAppearanceQuery | undefined;

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function documentRoot(): HTMLElement | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement;
}

function browserSystemAppearanceQuery(): SystemAppearanceQuery | undefined {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return undefined;
  }
}

export function readAppearancePreference(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): AppearancePreference {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

export function appearancePreference(): AppearancePreference {
  return currentPreference;
}

export function appearanceTheme(): AppearanceTheme {
  return currentTheme;
}

export function initializeAppearanceTheme(
  query: SystemAppearanceQuery | undefined = browserSystemAppearanceQuery(),
): AppearanceTheme {
  replaceSystemAppearanceQuery(query);
  currentPreference = readAppearancePreference();
  currentTheme = resolveAppearanceTheme(currentPreference);
  applyAppearanceTheme(currentTheme);
  publish(preferenceListeners);
  publish(themeListeners);
  return currentTheme;
}

export function setAppearancePreference(preference: AppearancePreference): void {
  if (preference !== "system" && preference !== "dark" && preference !== "light") return;
  try {
    browserStorage()?.setItem(STORAGE_KEY, preference);
  } catch {}

  if (preference !== currentPreference) {
    currentPreference = preference;
    publish(preferenceListeners);
  }

  updateResolvedTheme(resolveAppearanceTheme(currentPreference));
}

export function subscribeAppearancePreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

export function subscribeAppearanceTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function replaceSystemAppearanceQuery(query: SystemAppearanceQuery | undefined): void {
  systemAppearanceQuery?.removeEventListener("change", handleSystemAppearanceChange);
  systemAppearanceQuery = query;
  systemAppearanceQuery?.addEventListener("change", handleSystemAppearanceChange);
}

function handleSystemAppearanceChange(event: { matches: boolean }): void {
  if (currentPreference !== "system") return;
  updateResolvedTheme(event.matches ? "dark" : "light");
}

function resolveAppearanceTheme(preference: AppearancePreference): AppearanceTheme {
  if (preference !== "system") return preference;
  if (!systemAppearanceQuery) return "dark";
  return systemAppearanceQuery.matches ? "dark" : "light";
}

function updateResolvedTheme(theme: AppearanceTheme): void {
  if (theme === currentTheme) {
    applyAppearanceTheme(theme);
    return;
  }
  currentTheme = theme;
  applyAppearanceTheme(theme);
  publish(themeListeners);
}

function publish(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

function applyAppearanceTheme(theme: AppearanceTheme, root = documentRoot()): void {
  if (!root) return;
  root.dataset.appearance = theme;
  root.style.colorScheme = theme;
}
