import type { AppearanceTheme } from "../surface.js";

export type GhosttyGrid = { rows: number; cols: number };
export type GhosttyFrame = { x: number; y: number; width: number; height: number };

export type GhosttyBridge = {
  create(frame?: GhosttyFrame): Promise<{ surfaceId: number; rows: number; cols: number }>;
  write(surfaceId: number, data: Uint8Array): Promise<void>;
  setFrame(surfaceId: number, x: number, y: number, width: number, height: number): Promise<GhosttyGrid | undefined>;
  setVisible(surfaceId: number, visible: boolean): Promise<void>;
  setColorScheme(surfaceId: number, theme: AppearanceTheme): Promise<void>;
  snapshotText(surfaceId: number): Promise<string | undefined>;
  snapshotImage(surfaceId: number): Promise<string | undefined>;
  snapshotAndHide(surfaceId: number): Promise<string | undefined>;
  scrollToBottom?(surfaceId: number): Promise<void>;
  focus(surfaceId: number): Promise<void>;
  diagnosticText(surfaceId: number): Promise<string | undefined>;
  destroy(surfaceId: number): Promise<void>;
  onInput(surfaceId: number, listener: (data: Uint8Array) => void): () => void;
  onClosed(surfaceId: number, listener: () => void): () => void;
};
