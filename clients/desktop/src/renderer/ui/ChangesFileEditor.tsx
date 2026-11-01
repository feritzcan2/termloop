import type { FileEditor, FileEditorSnapshot } from "../file-editor.js";
import type { ChangeEntry } from "./ChangeFileTree.js";

/// Editor tabs for the reviewed Project checkout or Task worktree.
export type ChangesEditing = { editor: FileEditor; snapshot: FileEditorSnapshot; readOnly: boolean };

/// The worktree path a local change can be edited at. Committed and pull
/// request changes, deletions, and paths shown through an opaque identifier
/// have no working-tree file to open.
export function editableChangePath(entry: ChangeEntry | undefined): string | undefined {
  if (!entry || !("side" in entry) || entry.kind === "deleted" || entry.path_encoding !== "utf8") return undefined;
  return entry.display_path;
}
