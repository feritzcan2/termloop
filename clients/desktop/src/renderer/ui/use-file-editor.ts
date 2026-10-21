import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkspaceFileReadResult, WorkspaceFilesParams, WorkspaceFileWriteParams, WorkspaceFileWriteResult } from "@termloop/contract/current";
import type { FilesSubject } from "../file-browser.js";
import { FileEditor } from "../file-editor.js";

/** One disposable set of editor tabs for the current Project or Task root. */
export function useFileEditor(
  subject: FilesSubject | undefined,
  rootIdentity: string,
  read: (params: WorkspaceFilesParams) => Promise<WorkspaceFileReadResult>,
  write: (params: WorkspaceFileWriteParams) => Promise<WorkspaceFileWriteResult>,
) {
  const io = useRef({ read, write });
  io.current = { read, write };
  const projectId = subject?.projectId;
  const taskId = subject?.taskId ?? null;
  const editor = useMemo(() => new FileEditor({
    read: (path) => io.current.read({ projectId: projectId!, taskId, path }),
    write: (path, content, expectedVersion) => io.current.write({ projectId: projectId!, taskId, path, content, expectedVersion }),
  }), [projectId, taskId, rootIdentity]);
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  useEffect(() => () => editor.dispose(), [editor]);
  return { editor, snapshot };
}
