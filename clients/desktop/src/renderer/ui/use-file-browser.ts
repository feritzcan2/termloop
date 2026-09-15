import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkspaceDirectoryResult, WorkspaceFileReadResult, WorkspaceFilesParams } from "@termloop/contract/current";
import { FileBrowser, type FilesSubject } from "../file-browser.js";

/** One disposable browser for the currently visible Project or Task root. */
export function useFileBrowser(
  subject: FilesSubject | undefined,
  rootIdentity: string,
  list: (params: WorkspaceFilesParams) => Promise<WorkspaceDirectoryResult>,
  read: (params: WorkspaceFilesParams) => Promise<WorkspaceFileReadResult>,
) {
  const reader = useRef({ list, read });
  reader.current = { list, read };
  const projectId = subject?.projectId;
  const taskId = subject?.taskId ?? null;
  const browser = useMemo(() => new FileBrowser({
    list: (path, afterName) => reader.current.list({ projectId: projectId!, taskId, path, ...(afterName ? { afterName } : {}) }),
    read: (path) => reader.current.read({ projectId: projectId!, taskId, path }),
  }), [projectId, taskId, rootIdentity]);
  const snapshot = useSyncExternalStore(browser.subscribe, browser.getSnapshot, browser.getSnapshot);
  useEffect(() => {
    if (projectId) browser.start();
    return () => browser.dispose();
  }, [browser, projectId]);
  return { browser, snapshot };
}
