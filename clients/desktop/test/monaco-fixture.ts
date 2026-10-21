/// A minimal stand-in for the Monaco adapter: one view, text models and the
/// command/content hooks the editor overlay uses. jsdom cannot run Monaco.
type Model = { value: string; language: string; disposed: boolean; getValue(): string; dispose(): void;
  getFullModelRange(): object; pushEditOperations(_: unknown, edits: { text: string }[]): null };

export function fakeMonaco() {
  const commands = new Map<number, () => void>();
  const contentListeners = new Set<() => void>();
  const models: Model[] = [];
  const state = { model: undefined as Model | undefined, readOnly: false, theme: "" };
  const changed = () => contentListeners.forEach((listener) => listener());
  const monaco = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    editor: {
      setTheme(theme: string) { state.theme = theme; },
      createModel(value: string, language: string): Model {
        const model: Model = {
          value, language, disposed: false,
          getValue: () => model.value,
          dispose: () => { model.disposed = true; },
          getFullModelRange: () => ({}),
          pushEditOperations: (_, edits) => { model.value = edits[0]!.text; changed(); return null; },
        };
        models.push(model);
        return model;
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
  };
}
