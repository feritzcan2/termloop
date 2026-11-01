/// A minimal stand-in for the Monaco adapter: one view or one diff view,
/// text models and the hooks the editors use. jsdom cannot run Monaco.
type Model = { value: string; language: string; disposed: boolean; getValue(): string; setValue(value: string): void; dispose(): void;
  getFullModelRange(): object; pushEditOperations(_: unknown, edits: { text: string }[]): null };
type MouseTarget = { type: number; position: { lineNumber: number } };
type ViewZone = { afterLineNumber: number; domNode: HTMLElement };

/// One side of a diff view: its gutter mouse hooks, view zones and decorations.
function fakeDiffSide() {
  const mouseDown = new Set<(event: { target: MouseTarget; event: { leftButton: boolean; preventDefault(): void } }) => void>();
  const zones = new Map<string, ViewZone>();
  const decorations: unknown[][] = [];
  let nextZone = 0;
  const view = {
    readOnly: false,
    model: undefined as Model | undefined,
    commands: new Map<number, () => void>(),
    contentListeners: new Set<() => void>(),
    zones,
    decorations,
    addCommand(key: number, run: () => void) { view.commands.set(key, run); },
    onDidChangeModelContent(listener: () => void) { view.contentListeners.add(listener); },
    onMouseMove() {},
    onMouseLeave() {},
    onMouseDown(listener: (event: { target: MouseTarget; event: { leftButton: boolean; preventDefault(): void } }) => void) { mouseDown.add(listener); },
    getModel: () => view.model,
    updateOptions(options: { readOnly?: boolean }) { if (options.readOnly !== undefined) view.readOnly = options.readOnly; },
    createDecorationsCollection(initial: unknown[] = []) {
      const index = decorations.push(initial) - 1;
      return { set: (next: unknown[]) => { decorations[index] = next; }, clear: () => { decorations[index] = []; } };
    },
    changeViewZones(change: (accessor: { addZone(zone: ViewZone): string; removeZone(id: string): void; layoutZone(id: string): void }) => void) {
      change({
        addZone: (zone) => { const id = String(++nextZone); zones.set(id, zone); return id; },
        removeZone: (id) => { zones.delete(id); },
        layoutZone: () => {},
      });
    },
    /// Presses the line-number gutter of `line`.
    clickGutter(line: number) {
      mouseDown.forEach((listener) => listener({ target: { type: 3, position: { lineNumber: line } }, event: { leftButton: true, preventDefault() {} } }));
    },
  };
  return view;
}

export function fakeMonaco() {
  const commands = new Map<number, () => void>();
  const contentListeners = new Set<() => void>();
  const models: Model[] = [];
  const state = { model: undefined as Model | undefined, readOnly: false, theme: "",
    diff: undefined as { original: ReturnType<typeof fakeDiffSide>; modified: ReturnType<typeof fakeDiffSide>; options: Record<string, unknown> } | undefined };
  const changed = () => contentListeners.forEach((listener) => listener());
  const monaco = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} },
    editor: {
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2, GUTTER_LINE_NUMBERS: 3 },
      setTheme(theme: string) { state.theme = theme; },
      createModel(value: string, language: string): Model {
        const model: Model = {
          value, language, disposed: false,
          getValue: () => model.value,
          setValue: (next) => { model.value = next; },
          dispose: () => { model.disposed = true; },
          getFullModelRange: () => ({}),
          pushEditOperations: (_, edits) => { model.value = edits[0]!.text; changed(); return null; },
        };
        models.push(model);
        return model;
      },
      createDiffEditor(_host: HTMLElement, options: Record<string, unknown>) {
        const original = fakeDiffSide();
        const modified = fakeDiffSide();
        state.theme = String(options.theme ?? "");
        state.diff = { original, modified, options: { ...options } };
        return {
          setModel(models: { original: Model; modified: Model }) { original.model = models.original; modified.model = models.modified; },
          getOriginalEditor: () => original,
          getModifiedEditor: () => modified,
          updateOptions(next: Record<string, unknown>) { Object.assign(state.diff!.options, next); },
          dispose() {},
        };
      },
      create(_host: HTMLElement, options: { readOnly?: boolean; theme?: string }) {
        state.readOnly = Boolean(options.readOnly);
        state.theme = options.theme ?? "";
        return {
          addCommand: (key: number, run: () => void) => { commands.set(key, run); },
          onDidChangeModelContent: (listener: () => void) => { contentListeners.add(listener); },
          getModel: () => state.model,
          setModel: (model: Model | null) => { state.model = model ?? undefined; },
          saveViewState: () => null,
          restoreViewState: () => {},
          focus: () => {},
          updateOptions: (options: { readOnly?: boolean }) => { if (options.readOnly !== undefined) state.readOnly = options.readOnly; },
          dispose: () => {},
        };
      },
    },
  };
  return {
    monaco,
    state,
    models,
    /// Types into the shown model the way a user edit would.
    type(value: string) { state.model!.value = value; changed(); },
    save() { commands.get(2048 | 49)!(); },
    /// Types into the diff view's working-tree side.
    typeInDiff(value: string) {
      const side = state.diff!.modified;
      side.model!.value = value;
      side.contentListeners.forEach((listener) => listener());
    },
    saveDiff() { state.diff!.modified.commands.get(2048 | 49)!(); },
  };
}
