const MAX_REMEMBERED_SESSIONS = 32;

export type TerminalInputMode = "compose" | "live";

interface ComposerMemory {
  draft: string;
  mode: TerminalInputMode | undefined;
}

const memory = new Map<string, ComposerMemory>();

export function composerMemoryKey(connectionId: string, sessionId: string, runtimeEpoch: number): string {
  return `${connectionId}\u0000${sessionId}\u0000${runtimeEpoch}`;
}

/// Unsent text and the input mode, kept per Session while the app runs.
///
/// In memory only, like a launch-time pending input: a draft can hold anything the
/// user typed, and it must not outlive the process in ordinary storage. Bounded and
/// least-recently-used, so walking through many Sessions cannot grow it.
function touch(key: string): ComposerMemory {
  const existing = memory.get(key) ?? { draft: "", mode: undefined };
  memory.delete(key);
  memory.set(key, existing);
  while (memory.size > MAX_REMEMBERED_SESSIONS) {
    const oldest = memory.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  return existing;
}

export function rememberedDraft(key: string): string {
  return memory.get(key)?.draft ?? "";
}

export function rememberDraft(key: string, draft: string): void {
  if (draft.length === 0 && memory.get(key)?.mode === undefined) {
    memory.delete(key);
    return;
  }
  touch(key).draft = draft;
}

/// A shell takes keystrokes; an agent takes a composed turn. The user's explicit
/// choice for this Session wins over that default for as long as it is remembered.
export function rememberedInputMode(key: string, agent: boolean): TerminalInputMode {
  return memory.get(key)?.mode ?? (agent ? "compose" : "live");
}

export function rememberInputMode(key: string, mode: TerminalInputMode): void {
  touch(key).mode = mode;
}

export function clearComposerMemoryForTests(): void {
  memory.clear();
}
