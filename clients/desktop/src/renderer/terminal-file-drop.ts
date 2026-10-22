// Formats local file paths dropped onto a terminal into prompt text, the
// way Ghostty and Orca do: each path becomes one shell word, words are
// space-separated, and a trailing space keeps later typing from gluing onto
// the last path. Agent TUIs (Claude Code, Codex) undo the shell escaping
// before checking for a dropped image, so images need no special framing.

export type DropTargetShell = "posix" | "windows";

export const MAX_DROPPED_PATHS = 64;

const PLAIN_POSIX_PATH = /^[A-Za-z0-9_\-./@:+,%=~]+$/;
const PLAIN_WINDOWS_PATH = /^[A-Za-z0-9_\-./@:\\]+$/;
const POSIX_SPECIAL = /[\s\\'"`()[\]{}<>!#$&;|*?]/g;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function dropTargetShell(userAgent: string): DropTargetShell {
  return /Windows/i.test(userAgent) ? "windows" : "posix";
}

export function shellEscapeDroppedPath(path: string, shell: DropTargetShell): string | undefined {
  // A pasted newline would submit the prompt mid-path; refuse instead.
  if (path.length === 0 || CONTROL_CHARACTER.test(path)) return undefined;
  if (shell === "windows") {
    if (PLAIN_WINDOWS_PATH.test(path)) return path;
    return path.includes("\"") ? undefined : `"${path}"`;
  }
  return PLAIN_POSIX_PATH.test(path) ? path : path.replace(POSIX_SPECIAL, (character) => `\\${character}`);
}

export type DroppedPathsText = { text: string; skipped: number };

export function droppedPathsText(paths: readonly string[], shell: DropTargetShell): DroppedPathsText {
  const words: string[] = [];
  let skipped = Math.max(0, paths.length - MAX_DROPPED_PATHS);
  for (const path of paths.slice(0, MAX_DROPPED_PATHS)) {
    const word = shellEscapeDroppedPath(path, shell);
    if (word === undefined) skipped += 1;
    else words.push(word);
  }
  return { text: words.length > 0 ? `${words.join(" ")} ` : "", skipped };
}
