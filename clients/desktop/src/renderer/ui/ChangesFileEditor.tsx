import { useEffect } from "react";
import type { FileEditor, FileEditorSnapshot } from "../file-editor.js";
import { FileEditorBody, type EditorScrollLine } from "./FileEditorOverlay.js";
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

/// The selected change's working-tree file, edited in place of its diff.
export function ChangesFileEditor({ editing, path, scrollLine }: { editing: ChangesEditing; path: string; scrollLine: EditorScrollLine }) {
  const { editor, snapshot, readOnly } = editing;
  useEffect(() => { editor.open(path); }, [editor, path]);
  const tab = snapshot.tabs.find((candidate) => candidate.path === path);
  return tab && snapshot.active === path
    ? <FileEditorBody editor={editor} snapshot={snapshot} tab={tab} readOnly={readOnly} scrollLine={scrollLine} />
    : <p className="changes-placeholder">Opening file…</p>;
}
