export type AppearanceTheme = "dark" | "light";

const STORAGE_KEY = "termloop.appearance-theme";
const listeners = new Set<() => void>();
let currentTheme: AppearanceTheme = "dark";

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

export function readAppearanceTheme(
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): AppearanceTheme {
  try {
    return storage?.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function appearanceTheme(): AppearanceTheme {
  return currentTheme;
}

export function initializeAppearanceTheme(): AppearanceTheme {
  currentTheme = readAppearanceTheme();
  applyAppearanceTheme(currentTheme);
  for (const listener of listeners) listener();
  return currentTheme;
}

export function setAppearanceTheme(theme: AppearanceTheme): void {
  if (theme !== "dark" && theme !== "light") return;
  try {
    browserStorage()?.setItem(STORAGE_KEY, theme);
  } catch {}
  if (theme === currentTheme) {
    applyAppearanceTheme(theme);
    return;
  }
  currentTheme = theme;
  applyAppearanceTheme(theme);
  for (const listener of listeners) listener();
}

export function subscribeAppearanceTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyAppearanceTheme(theme: AppearanceTheme, root = documentRoot()): void {
  if (!root) return;
  root.dataset.appearance = theme;
  root.style.colorScheme = theme;
}
