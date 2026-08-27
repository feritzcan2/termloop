export type TerminalBufferProbe = {
  lines: number;
  cursorX: number;
  cursorY: number;
  text: string;
  bufferType: "normal" | "alternate";
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any";
};

export type TerminalSurface = {
  mount(container: HTMLElement, preferWebgl: boolean): void;
  unmount(): void;
  write(data: Uint8Array, callback: () => void): void;
  writeln(message: string): void;
  focus(): void;
  probe(): TerminalBufferProbe | undefined;
  diagnosticText?(): Promise<string | undefined>;
  setVisible?(visible: boolean): void;
  dispose(): void;
};

export type TerminalSurfaceFactory = (
  onInput: (data: string | Uint8Array) => void,
  onResize: (rows: number, cols: number) => void,
) => TerminalSurface;
