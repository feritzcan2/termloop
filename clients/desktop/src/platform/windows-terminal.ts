import { createRequire } from "node:module";
import path from "node:path";

export type WindowsTerminalFrame = { x: number; y: number; width: number; height: number };
export type WindowsTerminalGrid = { surfaceId: number; rows: number; cols: number };
export type WindowsTerminalEvent = "input" | "closed" | "shortcut";
export type WindowsTerminalAddon = {
  initialize(library: string): void;
  create(handle: Buffer, frame: WindowsTerminalFrame, listener: (kind: WindowsTerminalEvent, id: number, value?: string) => void): WindowsTerminalGrid;
  write(id: number, text: string): void;
  setFrame(id: number, x: number, y: number, width: number, height: number): WindowsTerminalGrid;
  setVisible(id: number, visible: boolean): void;
  setColorScheme(id: number, theme: "dark" | "light"): void;
  focus(id: number): void;
  scrollToBottom(id: number): void;
  readText(id: number): Promise<string>;
  snapshot(id: number): { data: Buffer; width: number; height: number } | undefined;
  destroy(id: number): void;
};

export function loadWindowsTerminalAddon(appPath: string): WindowsTerminalAddon | undefined {
  if (process.platform !== "win32") return undefined;
  const directory = path.basename(appPath) === "app.asar"
    ? path.join(process.resourcesPath, "native", "windows-terminal")
    : path.join(appPath, "native", "windows-terminal", "build", "Release");
  try {
    const addon = createRequire(import.meta.url)(path.join(directory, "windows_terminal.node")) as WindowsTerminalAddon;
    addon.initialize(path.join(directory, "Microsoft.Terminal.Control.dll"));
    return addon;
  } catch (error) {
    console.warn("Windows Terminal native renderer unavailable; using xterm", error);
    return undefined;
  }
}
