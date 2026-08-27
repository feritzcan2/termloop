import { useCallback, useEffect, useState } from "react";

import type { ContextBankFileDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";

export function ContextBankEditorPanel({ fileId, load, save, onSaved, close }: {
  fileId: string;
  load(fileId: string): Promise<ContextBankFileDto>;
  save(fileId: string, expectedContentSha256: string, content: string): Promise<ContextBankFileDto>;
  onSaved?: ((file: ContextBankFileDto) => void) | undefined;
  close(): void;
}) {
  const [file, setFile] = useState<ContextBankFileDto>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setFile(undefined);
    setDraft("");
    setLoading(true);
    setError(undefined);
    void load(fileId).then((result) => {
      if (!active) return;
      setFile(result);
      setDraft(result.content);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [fileId, load, reloadToken]);

  const dirty = file !== undefined && draft !== file.content;
  const currentLineCount = draft.split("\n").length;

  const saveDraft = useCallback(async () => {
    if (!file || saving || draft === file.content) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await save(file.fileId, file.contentSha256, draft);
      setFile(result);
      setDraft(result.content);
      onSaved?.(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [draft, file, onSaved, save, saving]);

  return <section className="stage-editor context-bank-editor" aria-label={file ? `${file.relativePath} Context Bank editor` : "Context Bank editor"}>
    <header className="stage-editor-head">
      <div className="stage-editor-title">
        <span>Context Bank</span>
        <h2>{file?.relativePath ?? "Project instructions"}</h2>
        {file ? <code title={file.path}>{file.path}</code> : null}
      </div>
      <div className="stage-editor-actions">
        {file && !file.editable ? <em className="stage-editor-readonly">Read only</em> : null}
        {dirty ? <button className="secondary-button" type="button" disabled={saving} onClick={reload}>Discard</button> : null}
        <button className="primary-button" type="button" disabled={!dirty || saving || !file?.editable} onClick={() => void saveDraft()}>{saving ? "Saving…" : "Save"}</button>
        <button className="icon-button quiet" type="button" aria-label="Close Context Bank editor" onClick={close}><Icon name="close" /></button>
      </div>
    </header>
    {error ? <p className="settings-rail-error" role="alert">{error}<button className="secondary-button" type="button" onClick={reload}>Reload</button></p> : null}
    {loading && !file ? <p className="settings-rail-empty">Loading Project instructions…</p> : null}
    {file?.isSymlink ? <p className="context-editor-notice"><Icon name="copy" />This file links to <code>{file.symlinkTargetPath}</code>. Saving preserves the link and updates its in-Project target.</p> : null}
    {file ? <textarea
      className="stage-editor-source"
      value={draft}
      spellCheck={false}
      readOnly={!file.editable || saving}
      aria-label={`${file.relativePath} content`}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          void saveDraft();
        }
      }}
    /> : null}
    {file ? <footer className="context-editor-footer">
      <span className={`context-capacity large${currentLineCount > file.lineLimit ? " over-limit" : ""}`}>{currentLineCount}/{file.lineLimit} lines</span>
      <span>{file.kind === "agents" ? "Codex / shared agents" : file.kind === "claude" ? "Claude" : "Gemini"}</span>
    </footer> : null}
  </section>;
}
