import { parseKeySequence } from "../../presentation/terminal-keys";

/// Terminal choices that belong to this phone, not to the Mac's Session.
///
/// None of this reaches the daemon: text size, autocorrect, the extra keys, and the
/// saved commands are how this device types, and the desktop keeps its own.

export interface CustomTerminalKey {
  readonly id: string;
  readonly label: string;
  /// As written in the editor; see `parseKeySequence`. Kept in source form so the
  /// editor can show it back exactly.
  readonly sequence: string;
}

export interface QuickCommand {
  readonly id: string;
  readonly label: string;
  /// Literal text, sent exactly as saved.
  readonly body: string;
  /// Presses Return after the body. Off leaves the command on the prompt to edit.
  readonly enter: boolean;
}

export interface TerminalPreferences {
  readonly textSizeIndex: number;
  readonly autocorrect: boolean;
  readonly customKeys: readonly CustomTerminalKey[];
  readonly quickCommands: readonly QuickCommand[];
}

export const TERMINAL_TEXT_SIZE_COUNT = 6;
/// 13pt, the size the terminal used before sizes became adjustable.
export const DEFAULT_TEXT_SIZE_INDEX = 2;
export const MAX_CUSTOM_KEYS = 12;
export const MAX_CUSTOM_KEY_LABEL = 10;
export const MAX_CUSTOM_KEY_SEQUENCE = 256;
export const MAX_QUICK_COMMANDS = 24;
export const MAX_QUICK_COMMAND_LABEL = 40;
export const MAX_QUICK_COMMAND_BODY = 2_000;

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  textSizeIndex: DEFAULT_TEXT_SIZE_INDEX,
  /// Off, so iOS never rewrites a command, a flag, or a path on its way to the PTY.
  autocorrect: false,
  customKeys: [],
  quickCommands: [],
};

export interface TerminalPreferencesStorage {
  read(): Promise<string | null>;
  write(serialized: string): Promise<void>;
}

/// Identifies a saved key or command on this phone only; never sent anywhere.
export function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clampTextSizeIndex(index: number): number {
  if (!Number.isInteger(index)) return DEFAULT_TEXT_SIZE_INDEX;
  return Math.min(TERMINAL_TEXT_SIZE_COUNT - 1, Math.max(0, index));
}

export function customKeyProblem(label: string, sequence: string): string | undefined {
  if (label.trim().length === 0) return "Give the key a label.";
  if (label.length > MAX_CUSTOM_KEY_LABEL) return `Keep the label to ${MAX_CUSTOM_KEY_LABEL} characters.`;
  if (sequence.length > MAX_CUSTOM_KEY_SEQUENCE) return `Keep the sequence to ${MAX_CUSTOM_KEY_SEQUENCE} characters.`;
  const parsed = parseKeySequence(sequence);
  return parsed.ok ? undefined : parsed.error;
}

export function quickCommandProblem(label: string, body: string): string | undefined {
  if (body.length === 0) return "The command is empty.";
  if (body.length > MAX_QUICK_COMMAND_BODY) return `Keep the command to ${MAX_QUICK_COMMAND_BODY} characters.`;
  if (label.length > MAX_QUICK_COMMAND_LABEL) return `Keep the name to ${MAX_QUICK_COMMAND_LABEL} characters.`;
  return undefined;
}

/// Restores what was stored, dropping anything that would not pass the editor's own
/// checks. A damaged entry costs that entry, never the whole set.
export function parseTerminalPreferences(serialized: string | null): TerminalPreferences {
  if (serialized === null) return DEFAULT_TERMINAL_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return DEFAULT_TERMINAL_PREFERENCES;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_TERMINAL_PREFERENCES;
  const candidate = value as Record<string, unknown>;
  const customKeys = Array.isArray(candidate.customKeys)
    ? candidate.customKeys.filter((entry): entry is CustomTerminalKey => (
      isRecord(entry) && typeof entry.id === "string" && typeof entry.label === "string"
        && typeof entry.sequence === "string" && customKeyProblem(entry.label, entry.sequence) === undefined
    )).slice(0, MAX_CUSTOM_KEYS).map(({ id, label, sequence }) => ({ id, label, sequence }))
    : [];
  const quickCommands = Array.isArray(candidate.quickCommands)
    ? candidate.quickCommands.filter((entry): entry is QuickCommand => (
      isRecord(entry) && typeof entry.id === "string" && typeof entry.label === "string"
        && typeof entry.body === "string" && typeof entry.enter === "boolean"
        && quickCommandProblem(entry.label, entry.body) === undefined
    )).slice(0, MAX_QUICK_COMMANDS).map(({ id, label, body, enter }) => ({ id, label, body, enter }))
    : [];
  return {
    textSizeIndex: typeof candidate.textSizeIndex === "number"
      ? clampTextSizeIndex(candidate.textSizeIndex)
      : DEFAULT_TEXT_SIZE_INDEX,
    autocorrect: candidate.autocorrect === true,
    customKeys,
    quickCommands,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTerminalPreferencesStore(storage: TerminalPreferencesStorage) {
  let preferences = DEFAULT_TERMINAL_PREFERENCES;
  let changed = false;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();

  const update = (next: TerminalPreferences) => {
    changed = true;
    preferences = next;
    for (const listener of listeners) listener();
    const serialized = JSON.stringify(next);
    // Serialized so a quick run of edits cannot persist an older set last.
    writes = writes.then(() => storage.write(serialized)).catch(() => {});
    return writes;
  };

  return {
    get: () => preferences,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    initialize() {
      return initialization ??= storage.read().then((stored) => {
        // An edit made while storage was still loading is newer than what it holds.
        if (changed) return;
        preferences = parseTerminalPreferences(stored);
        for (const listener of listeners) listener();
      }).catch(() => {});
    },
    /// A pinch held past the last preset keeps asking; an unchanged value is not
    /// another keychain write.
    setTextSizeIndex(index: number) {
      const textSizeIndex = clampTextSizeIndex(index);
      return textSizeIndex === preferences.textSizeIndex ? writes : update({ ...preferences, textSizeIndex });
    },
    setAutocorrect: (autocorrect: boolean) => autocorrect === preferences.autocorrect
      ? writes
      : update({ ...preferences, autocorrect }),
    saveCustomKey(key: CustomTerminalKey) {
      if (customKeyProblem(key.label, key.sequence) !== undefined) return writes;
      const exists = preferences.customKeys.some(({ id }) => id === key.id);
      if (!exists && preferences.customKeys.length >= MAX_CUSTOM_KEYS) return writes;
      return update({
        ...preferences,
        customKeys: exists
          ? preferences.customKeys.map((current) => current.id === key.id ? key : current)
          : [...preferences.customKeys, key],
      });
    },
    removeCustomKey: (id: string) => update({
      ...preferences,
      customKeys: preferences.customKeys.filter((key) => key.id !== id),
    }),
    saveQuickCommand(command: QuickCommand) {
      if (quickCommandProblem(command.label, command.body) !== undefined) return writes;
      const exists = preferences.quickCommands.some(({ id }) => id === command.id);
      if (!exists && preferences.quickCommands.length >= MAX_QUICK_COMMANDS) return writes;
      return update({
        ...preferences,
        quickCommands: exists
          ? preferences.quickCommands.map((current) => current.id === command.id ? command : current)
          : [...preferences.quickCommands, command],
      });
    },
    removeQuickCommand: (id: string) => update({
      ...preferences,
      quickCommands: preferences.quickCommands.filter((command) => command.id !== id),
    }),
  };
}

export type TerminalPreferencesStore = ReturnType<typeof createTerminalPreferencesStore>;

/// Display name for a quick command without an explicit one: its first line.
export function quickCommandTitle(command: QuickCommand): string {
  if (command.label.trim().length !== 0) return command.label.trim();
  const firstLine = command.body.split("\n", 1)[0] ?? "";
  return firstLine.length > MAX_QUICK_COMMAND_LABEL ? `${firstLine.slice(0, MAX_QUICK_COMMAND_LABEL - 1)}…` : firstLine;
}
