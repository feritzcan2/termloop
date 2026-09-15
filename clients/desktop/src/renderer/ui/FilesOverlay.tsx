import { useEffect } from "react";
import { filePreviewMessage, type FilesSubject, type FilePreview } from "../file-browser.js";
import { Icon } from "./Icon.js";
import { FileCodePreview } from "./FileCodePreview.js";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.js";
import { fileLanguage, sourceLines } from "../file-language.js";
import "../../files.css";

export function FilesOverlay({ subject, preview, close }: { subject: FilesSubject; preview: FilePreview; close(): void }) {
  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return <section className="changes-overlay files-overlay" aria-label={`Files for ${subject.title}`} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  }}>
    <header className="changes-header">
      <div><span className="files-eyebrow">{subject.taskId ? "TASK WORKTREE" : "PROJECT"}</span><h1>Files <span className="files-subject">/ {subject.title}</span></h1><p>Read-only preview</p></div>
      <div className="changes-header-actions">
        <button type="button" className="icon-button" aria-label="Close file preview" title="Close file preview (Esc)" onClick={close}><Icon name="close" /></button>
      </div>
    </header>
    <FileContentPreview preview={preview} />
  </section>;
}

export function FileContentPreview({ preview }: { preview: FilePreview }) {
  if (preview.status === "empty") return <div className="files-preview-empty"><Icon name="fileText" /><h2>Select a file</h2><p>Browse folders on the left to preview their contents.</p></div>;
  const result = preview.status === "ready" ? preview.result : undefined;
  const message = preview.status === "loading" ? "Loading file…" : preview.status === "error" ? preview.message : result ? filePreviewMessage(result.state) : undefined;
  const content = result?.state === "text" ? result.content ?? "" : undefined;
  const lines = content === undefined ? [] : sourceLines(content);
  const language = fileLanguage(preview.path);
  return <section className="files-preview" aria-label="File preview" aria-busy={preview.status === "loading"}>
    <header><span className="files-preview-path" title={preview.path}><WorkspaceFileIcon entry={{ name: preview.path.split("/").at(-1)!, kind: "file" }} />{preview.path}</span>{content !== undefined ? <small>{language?.label ?? "Plain text"} · {lines.length.toLocaleString()} lines · {new TextEncoder().encode(content).length.toLocaleString()} bytes</small> : null}</header>
    {message ? <p className="files-preview-message" role={preview.status === "error" ? "alert" : "status"}>{message}</p>
      : content === "" ? <p className="files-preview-message">Empty file</p>
        : <FileCodePreview path={preview.path} content={content!} />}
  </section>;
}
