import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FilesSubject } from "../file-browser.js";
import type { FileEditor, FileEditorSnapshot, FileEditorTab } from "../file-editor.js";
import { fileLanguage } from "../file-language.js";
import { appearanceTheme, subscribeAppearanceTheme } from "../appearance-theme.js";
import { Icon } from "./Icon.js";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.js";
import type { monaco as Monaco } from "../monaco-editor.js";
import "../../files.css";

const fileName = (path: string) => path.split("/").at(-1)!;

/// Editor tabs over the terminal stage. Terminal hosts stay mounted beneath it.
export function FileEditorOverlay({ subject, editor, snapshot, readOnly, hide, closeTab }: {
  subject: FilesSubject;
  editor: FileEditor;
  snapshot: FileEditorSnapshot;
  readOnly: boolean;
  hide(): void;
  closeTab(path: string): void;
}) {
  const tab = snapshot.tabs.find((candidate) => candidate.path === snapshot.active);
  return <section className="changes-overlay file-editor" aria-label={`Editor for ${subject.title}`} onKeyDown={(event) => {
    // Monaco's own widgets (find, rename, suggestions) consume Escape first.
    if (event.key !== "Escape" || (event.target as Element).closest?.(".monaco-editor")) return;
    event.stopPropagation();
    hide();
  }}>
    <header className="file-editor-tabs">
      <div role="tablist" aria-label="Open files">
        {snapshot.tabs.map((candidate) => {
          const { dirty } = candidate;
          const active = candidate.path === snapshot.active;
          return <div key={candidate.path} className={`file-editor-tab${active ? " active" : ""}`} title={candidate.path}>
            <button type="button" role="tab" aria-selected={active} onClick={() => editor.activate(candidate.path)}
              onAuxClick={(event) => { if (event.button === 1) closeTab(candidate.path); }}
            ><WorkspaceFileIcon entry={{ name: fileName(candidate.path), kind: "file" }} /><span>{fileName(candidate.path)}</span></button>
            <button type="button" className={`file-editor-tab-close${dirty ? " dirty" : ""}`}
              aria-label={`Close ${candidate.path}${dirty ? " (unsaved changes)" : ""}`} title={dirty ? "Unsaved changes · Close" : "Close"}
              onClick={() => closeTab(candidate.path)}
            >{dirty ? <span className="file-editor-dirty" aria-hidden="true" /> : null}<Icon name="close" /></button>
          </div>;
        })}
      </div>
      <button type="button" className="icon-button quiet" aria-label="Hide editor" title="Hide editor (Esc)" onClick={hide}><Icon name="panelDown" /></button>
    </header>
    {tab ? <FileEditorBody editor={editor} snapshot={snapshot} tab={tab} readOnly={readOnly} /> : null}
  </section>;
}

function FileEditorBody({ editor, snapshot, tab, readOnly }: { editor: FileEditor; snapshot: FileEditorSnapshot; tab: FileEditorTab; readOnly: boolean }) {
  const { dirty } = tab;
  const editable = tab.status === "ready" && !readOnly;
  return <div className="file-editor-body">
    {tab.conflict ? <div className="file-editor-banner" role="alert">
      <span>{tab.conflict.version ? "This file changed on disk since it was opened." : "This file changed on disk and is now too large to compare."}</span>
      <button type="button" className="secondary-button" onClick={() => editor.reload(tab.path)}>Reload from disk</button>
      {tab.conflict.version && editable ? <button type="button" className="danger-button" onClick={() => void editor.save(tab.path, true)}>Overwrite</button> : null}
    </div> : null}
    {tab.message && tab.status === "ready" ? <div className="file-editor-banner" role="alert"><span>{tab.message}</span></div> : null}
    <MonacoSurface editor={editor} snapshot={snapshot} readOnly={!editable} hidden={tab.status !== "ready"} />
    {tab.status === "loading" ? <p className="file-editor-message" role="status">Loading file…</p>
      : tab.status === "unavailable" ? <p className="file-editor-message" role="alert">{tab.message}</p> : null}
    <footer className="file-editor-status">
      <span title={tab.path}>{tab.path}</span>
      <span>{fileLanguage(tab.path)?.label ?? "Plain text"}</span>
      <span role="status">{tab.status !== "ready" ? "" : readOnly ? "Read-only" : tab.saving ? "Saving…" : dirty ? "Unsaved · ⌘S to save" : "Saved"}</span>
    </footer>
  </div>;
}

/// One Monaco instance for all tabs: each path keeps its own model, so undo
/// history, selections and scroll survive switching tabs.
function MonacoSurface({ editor, snapshot, readOnly, hidden }: { editor: FileEditor; snapshot: FileEditorSnapshot; readOnly: boolean; hidden: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<{ monaco: typeof Monaco; view: Monaco.editor.IStandaloneCodeEditor }>();
  const [failure, setFailure] = useState<string>();
  const models = useRef(new Map<string, Monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const shown = useRef<string | undefined>(undefined);
  const applying = useRef(false);
  const theme = useSyncExternalStore(subscribeAppearanceTheme, appearanceTheme, appearanceTheme);

  useEffect(() => {
    let disposed = false;
    let created: { dispose(): void } | undefined;
    import("../monaco-editor.js").then(({ monaco }) => {
      if (disposed || !host.current) return;
      const view = monaco.editor.create(host.current, {
        automaticLayout: true, fontFamily: getComputedStyle(host.current).getPropertyValue("--font-mono") || "monospace",
        fontSize: 12, lineHeight: 19, minimap: { enabled: true }, scrollBeyondLastLine: false,
        renderWhitespace: "selection", stickyScroll: { enabled: true }, smoothScrolling: true,
        model: null, theme: appearanceTheme() === "light" ? "vs" : "vs-dark",
      });
      view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (shown.current) void editor.save(shown.current);
      });
      view.onDidChangeModelContent(() => {
        const model = view.getModel();
        if (!applying.current && model && shown.current) editor.edit(shown.current, model.getValue());
      });
      created = view;
      setInstance({ monaco, view });
    }, (error: unknown) => {
      if (!disposed) setFailure(error instanceof Error ? error.message : "The editor could not be loaded.");
    });
    return () => {
      disposed = true;
      created?.dispose();
      models.current.forEach((model) => model.dispose());
      models.current.clear();
    };
  }, [editor]);

  useEffect(() => { instance?.monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark"); }, [instance, theme]);
  useEffect(() => { instance?.view.updateOptions({ readOnly }); }, [instance, readOnly]);

  // Bring models in line with the store: create on first load, apply reloads
  // of clean tabs as undoable edits, and drop the models of closed tabs.
  useEffect(() => {
    if (!instance) return;
    const { monaco, view } = instance;
    const open = new Set(snapshot.tabs.map((tab) => tab.path));
    for (const [path, model] of models.current) {
      if (!open.has(path)) { model.dispose(); models.current.delete(path); viewStates.current.delete(path); }
    }
    for (const tab of snapshot.tabs) {
      if (tab.status !== "ready" || !tab.saved) continue;
      const model = models.current.get(tab.path);
      if (!model) {
        models.current.set(tab.path, monaco.editor.createModel(editor.draft(tab.path), fileLanguage(tab.path)?.id ?? "plaintext"));
      } else if (!tab.dirty && model.getValue() !== tab.saved.content) {
        applying.current = true;
        try { model.pushEditOperations([], [{ range: model.getFullModelRange(), text: tab.saved.content }], () => null); } finally { applying.current = false; }
      }
    }
    const path = snapshot.active && models.current.has(snapshot.active) ? snapshot.active : undefined;
    if (shown.current === path) return;
    if (shown.current && models.current.has(shown.current)) viewStates.current.set(shown.current, view.saveViewState());
    shown.current = path;
    view.setModel(path ? models.current.get(path)! : null);
    if (!path) return;
    const state = viewStates.current.get(path);
    if (state) view.restoreViewState(state);
    view.focus();
  }, [editor, instance, snapshot]);

  return <div className="file-editor-surface" hidden={hidden}>
    {failure ? <p className="file-editor-message" role="alert">{failure}</p> : null}
    <div ref={host} className="file-editor-monaco" aria-label="File contents" />
  </div>;
}
