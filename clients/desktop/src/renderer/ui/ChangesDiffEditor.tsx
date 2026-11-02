import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { fileLanguage } from "../file-language.js";
import { appearanceTheme, subscribeAppearanceTheme } from "../appearance-theme.js";
import type { ChangeReviewLine, ChangeReviewNote } from "../changes-review.js";
import type { monaco as Monaco } from "../monaco-editor.js";
import type { ChangesEditing } from "./ChangesFileEditor.js";
import { FileEditorBanners, FileEditorState, FileEditorStatus, monacoAppearance, monacoTheme } from "./FileEditorOverlay.js";
import { LineReviewWidget, changeReviewDraft, type ChangeReviewDraft } from "./ChangesLineReview.js";

type CodeEditor = Monaco.editor.ICodeEditor;
type Instance = { monaco: typeof Monaco; diff: Monaco.editor.IStandaloneDiffEditor };

/// The review line a Monaco diff comment anchors to. Line numbers, not patch
/// change keys, so a comment survives the re-list that follows each save.
export function monacoReviewLine(side: "old" | "new", lineNumber: number): ChangeReviewLine {
  return { changeKey: `${side}:${lineNumber}`, lineSide: side, lineNumber };
}

/// A local working-tree change as an editable diff: the index or HEAD
/// pre-image on the left, the working-tree file on the right. Edits go
/// through the shared file editor, so saves keep its compare-and-swap.
/// Monaco computes the diff in a worker; a first result that never arrives
/// within this time is treated as failed.
export const MONACO_DIFF_TIMEOUT_MS = 8_000;

/// Why the first Monaco diff cannot be trusted, or undefined when it can.
/// `lineChanges` is null while no result exists.
export function monacoDiffFailure(lineChanges: readonly unknown[] | null, originalText: string, modifiedText: string, expectsChanges: boolean): string | undefined {
  if (lineChanges === null) return "the editable diff did not finish computing.";
  if (lineChanges.length > 0) return undefined;
  if (originalText !== modifiedText) return "the editable diff found no differences in files that differ.";
  return expectsChanges ? "the original file and the working-tree file read the same; refresh to see the current change." : undefined;
}

export function ChangesDiffEditor({ editing, path, original, viewType, fullFile, notes, draft, openLineReview, editLineReview, updateLineReview, removeLineReview, saved, expectsChanges, diffFailed }: {
  editing: ChangesEditing;
  path: string;
  /** Pre-image text; empty for an untracked file. */
  original: string;
  viewType: "unified" | "split";
  fullFile: boolean;
  notes: readonly ChangeReviewNote[];
  draft: ChangeReviewDraft | undefined;
  openLineReview(line: ChangeReviewLine): void;
  editLineReview(draft: ChangeReviewDraft | undefined): void;
  updateLineReview(draft: ChangeReviewDraft, body: string): void;
  removeLineReview(key: string): void;
  /** The file's saved version moved: a save, or a reload of an outside edit. */
  saved(): void;
  /** The Git patch for this entry has hunks. */
  expectsChanges: boolean;
  /** The first Monaco diff is missing or empty; the caller falls back to the patch. */
  diffFailed(reason: string): void;
}) {
  const { editor, snapshot, readOnly } = editing;
  const tab = snapshot.tabs.find((candidate) => candidate.path === path);
  const ready = tab?.status === "ready";
  const host = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<Instance>();
  const [failure, setFailure] = useState<string>();
  const modified = useRef<Monaco.editor.ITextModel | undefined>(undefined);
  const applying = useRef(false);
  const theme = useSyncExternalStore(subscribeAppearanceTheme, appearanceTheme, appearanceTheme);
  const openLineReviewRef = useRef(openLineReview);
  openLineReviewRef.current = openLineReview;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const firstDiffRef = useRef({ expectsChanges, diffFailed });
  firstDiffRef.current = { expectsChanges, diffFailed };
  const layout = { renderSideBySide: viewType === "split", hideUnchangedRegions: { enabled: !fullFile } };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Monaco first paints both files unaligned and uncollapsed; the surface
  // stays invisible until the first diff result lays them out.
  const [laidOut, setLaidOut] = useState(false);

  // Viewing a change opens its file only for as long as it is shown, unless
  // it was already open or still holds unsaved edits. A tab that was already
  // open may hold content from before the change was made (an agent edited
  // the file since), so a clean one re-reads the file.
  useEffect(() => {
    const alreadyOpen = editor.tab(path) !== undefined;
    editor.open(path);
    if (alreadyOpen) editor.revalidate(path);
    return () => { if (!alreadyOpen && !editor.tab(path)?.dirty) editor.close(path); };
  }, [editor, path]);

  // Monaco mounts once the file has loaded, so its model starts from the file.
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let created: { dispose(): void } | undefined;
    const models: Monaco.editor.ITextModel[] = [];
    import("../monaco-editor.js").then(({ monaco }) => {
      if (disposed || !host.current) return;
      const diff = monaco.editor.createDiffEditor(host.current, {
        ...monacoAppearance(host.current), automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: true,
        renderWhitespace: "selection", smoothScrolling: true, originalEditable: false, ignoreTrimWhitespace: false,
        renderMarginRevertIcon: false, ...layoutRef.current,
      });
      created = diff;
      const language = fileLanguage(path)?.id ?? "plaintext";
      const originalModel = monaco.editor.createModel(original, language);
      const modifiedModel = monaco.editor.createModel(editor.draft(path), language);
      models.push(originalModel, modifiedModel);
      modified.current = modifiedModel;
      diff.setModel({ original: originalModel, modified: modifiedModel });
      const modifiedEditor = diff.getModifiedEditor();
      modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void editor.save(path); });
      modifiedEditor.onDidChangeModelContent(() => {
        if (!applying.current) editor.edit(path, modifiedModel.getValue());
      });
      commentGutter(monaco, diff.getOriginalEditor(), "old", (line) => openLineReviewRef.current(line));
      commentGutter(monaco, modifiedEditor, "new", (line) => openLineReviewRef.current(line));
      // Only the first trustworthy result is checked: later edits may
      // legitimately remove every difference. Identical texts are not final
      // before the timeout, because a re-read of a stale tab or the patch
      // that says whether changes are expected may still be on its way.
      let checked = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let firstResult: { dispose(): void } | undefined;
      const check = (final: boolean) => {
        if (checked || disposed) return;
        const lineChanges = diff.getLineChanges();
        const originalText = originalModel.getValue();
        const modifiedText = modifiedModel.getValue();
        if (!final && lineChanges?.length === 0 && originalText === modifiedText) return;
        checked = true;
        setLaidOut(true);
        clearTimeout(timer);
        firstResult?.dispose();
        const reason = monacoDiffFailure(lineChanges, originalText, modifiedText, firstDiffRef.current.expectsChanges);
        if (!reason) return;
        console.warn(`[changes-diag] ${JSON.stringify({
          event: "editableDiffFallback", reason, lineChanges: lineChanges?.length ?? null,
          originalLines: originalModel.getLineCount(), modifiedLines: modifiedModel.getLineCount(),
          identical: originalText === modifiedText, expectsChanges: firstDiffRef.current.expectsChanges,
        })}`);
        firstDiffRef.current.diffFailed(reason);
      };
      firstResult = diff.onDidUpdateDiff(() => check(false));
      timer = setTimeout(() => check(true), MONACO_DIFF_TIMEOUT_MS);
      created = { dispose: () => { clearTimeout(timer); firstResult?.dispose(); diff.dispose(); } };
      setInstance({ monaco, diff });
    }, (error: unknown) => {
      if (!disposed) setFailure(error instanceof Error ? error.message : "The editor could not be loaded.");
    });
    return () => {
      disposed = true;
      created?.dispose();
      models.forEach((model) => model.dispose());
      modified.current = undefined;
      setInstance(undefined);
      setLaidOut(false);
    };
    // Later pre-image and saved-content changes arrive through the effects below.
  }, [editor, path, ready]);

  useEffect(() => { instance?.monaco.editor.setTheme(monacoTheme(theme)); }, [instance, theme]);
  useEffect(() => {
    instance?.diff.updateOptions(layoutRef.current);
  }, [fullFile, instance, viewType]);
  useEffect(() => {
    instance?.diff.getModifiedEditor().updateOptions({ readOnly: readOnly || !ready });
  }, [instance, readOnly, ready]);
  useEffect(() => {
    const model = instance?.diff.getOriginalEditor().getModel();
    if (model && model.getValue() !== original) model.setValue(original);
  }, [instance, original]);

  // A clean file follows its saved content, so a reload lands as an undoable edit.
  const savedContent = tab?.saved?.content;
  useEffect(() => {
    const model = modified.current;
    if (!instance || !model || tab?.dirty || savedContent === undefined || model.getValue() === savedContent) return;
    applying.current = true;
    try { model.pushEditOperations([], [{ range: model.getFullModelRange(), text: savedContent }], () => null); } finally { applying.current = false; }
  }, [instance, savedContent, tab?.dirty]);

  const savedVersion = tab?.saved?.version;
  const shownVersion = useRef(savedVersion);
  useEffect(() => {
    const previous = shownVersion.current;
    shownVersion.current = savedVersion;
    if (previous !== undefined && savedVersion !== undefined && previous !== savedVersion) savedRef.current();
  }, [savedVersion]);

  const targets = new Map(notes.map((note) => [note.key, changeReviewDraft(note)] as const));
  if (draft) targets.set(draft.key, draft);
  const bodies = new Map(notes.map((note) => [note.key, note.body]));

  return <div className="file-editor-body changes-diff-editor">
    {tab ? <FileEditorBanners editor={editor} tab={tab} readOnly={readOnly} /> : null}
    <div className="file-editor-surface" hidden={!ready} style={laidOut ? undefined : { visibility: "hidden" }}>
      {failure ? <p className="file-editor-message" role="alert">{failure}</p> : null}
      <div ref={host} className="file-editor-monaco" aria-label={`Editable diff of ${path}`} />
    </div>
    {tab ? <FileEditorState editor={editor} tab={tab} /> : <p className="file-editor-message" role="status">Opening file…</p>}
    {ready && !laidOut && !failure ? <p className="file-editor-message changes-diff-pending" role="status">Comparing…</p> : null}
    {instance ? <NoteMarkers monaco={instance.monaco} diff={instance.diff} lines={[...targets.values()]} /> : null}
    {instance ? [...targets.values()].map((target) => (
      <ReviewZone
        key={target.key}
        view={target.lineSide === "old" ? instance.diff.getOriginalEditor() : instance.diff.getModifiedEditor()}
        line={target.lineNumber}
      >
        <LineReviewWidget
          draft={target}
          body={bodies.get(target.key) ?? ""}
          editing={draft?.key === target.key}
          edit={() => editLineReview(target)}
          change={(body) => updateLineReview(target, body)}
          close={() => editLineReview(undefined)}
          remove={() => removeLineReview(target.key)}
        />
      </ReviewZone>
    )) : null}
    {tab ? <FileEditorStatus tab={tab} readOnly={readOnly} /> : null}
  </div>;
}

/// A "+" in the glyph margin of the hovered line; pressing it, or the line
/// number, opens a comment on that line.
function commentGutter(monaco: typeof Monaco, view: CodeEditor, side: "old" | "new", open: (line: ChangeReviewLine) => void) {
  const { MouseTargetType } = monaco.editor;
  const hover = view.createDecorationsCollection();
  const gutterLine = (target: Monaco.editor.IMouseTarget) =>
    target.type === MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === MouseTargetType.GUTTER_LINE_NUMBERS
      ? target.position?.lineNumber : undefined;
  view.onMouseMove((event) => {
    const line = gutterLine(event.target);
    hover.set(line === undefined ? [] : [{
      range: new monaco.Range(line, 1, line, 1),
      options: { glyphMarginClassName: "changes-monaco-comment-add", glyphMarginHoverMessage: { value: "Comment on this line" } },
    }]);
  });
  view.onMouseLeave(() => hover.clear());
  view.onMouseDown((event) => {
    const line = gutterLine(event.target);
    if (line === undefined || !event.event.leftButton) return;
    event.event.preventDefault();
    open(monacoReviewLine(side, line));
  });
}

/// Marks commented lines in each side's glyph margin.
function NoteMarkers({ monaco, diff, lines }: { monaco: typeof Monaco; diff: Monaco.editor.IStandaloneDiffEditor; lines: readonly ChangeReviewDraft[] }) {
  const signature = lines.map((line) => line.changeKey).sort().join(",");
  useEffect(() => {
    const collections = (["old", "new"] as const).map((side) => {
      const view = side === "old" ? diff.getOriginalEditor() : diff.getModifiedEditor();
      return view.createDecorationsCollection(lines.filter((line) => line.lineSide === side).map((line) => ({
        range: new monaco.Range(line.lineNumber, 1, line.lineNumber, 1),
        options: { isWholeLine: true, glyphMarginClassName: "changes-monaco-comment-note", className: "changes-monaco-comment-line" },
      })));
    });
    return () => collections.forEach((collection) => collection.clear());
    // `signature` names exactly the lines shown.
  }, [diff, monaco, signature]);
  return null;
}

/// Renders `children` in a Monaco view zone below `line`, sized to its content.
function ReviewZone({ view, line, children }: { view: CodeEditor; line: number; children: ReactNode }) {
  const [content, setContent] = useState<HTMLElement>();
  useLayoutEffect(() => {
    const domNode = document.createElement("div");
    domNode.className = "changes-monaco-zone";
    // React listens on the portal container, so its handlers run before this
    // stops keys from reaching Monaco's own keybindings.
    const portal = document.createElement("div");
    domNode.append(portal);
    const isolate = (event: Event) => event.stopPropagation();
    domNode.addEventListener("keydown", isolate);
    const zone: Monaco.editor.IViewZone = { afterLineNumber: line, heightInPx: 44, domNode, suppressMouseDown: true };
    let id = "";
    view.changeViewZones((accessor) => { id = accessor.addZone(zone); });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      const height = portal.offsetHeight;
      if (!height || height === zone.heightInPx) return;
      zone.heightInPx = height;
      view.changeViewZones((accessor) => accessor.layoutZone(id));
    });
    observer?.observe(portal);
    setContent(portal);
    return () => {
      observer?.disconnect();
      domNode.removeEventListener("keydown", isolate);
      view.changeViewZones((accessor) => accessor.removeZone(id));
    };
  }, [line, view]);
  return content ? createPortal(children, content) : null;
}
