// The only bridge between the sandboxed renderer and main. It exposes named
// operations; `call` forwards only allowlisted control methods, and main
// enforces the same allowlist again.
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  isRendererMethod,
  isSessionId,
  parseNativeShortcut,
  terminalRendererFromArgv,
  type PmApi,
  type PmConnectionState,
  type PmEvent,
  type PmGhosttyApi,
  type PmTerminalMessage,
} from "./pm-api.js";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const ghostty: PmGhosttyApi = {
  create: (frame) => ipcRenderer.invoke(IPC.ghosttyCreate, frame),
  write: (surfaceId, data) => ipcRenderer.invoke(IPC.ghosttyWrite, surfaceId, data),
  setFrame: (surfaceId, frame) => ipcRenderer.invoke(IPC.ghosttySetFrame, surfaceId, frame),
  setVisible: (surfaceId, visible) => ipcRenderer.invoke(IPC.ghosttySetVisible, surfaceId, visible),
  focus: (surfaceId) => ipcRenderer.invoke(IPC.ghosttyFocus, surfaceId),
  scrollToBottom: (surfaceId) => ipcRenderer.invoke(IPC.ghosttyScrollBottom, surfaceId),
  paste: (surfaceId, text) => ipcRenderer.invoke(IPC.ghosttyPaste, surfaceId, text),
  snapshotText: (surfaceId) => ipcRenderer.invoke(IPC.ghosttySnapshotText, surfaceId),
  snapshotImage: (surfaceId) => ipcRenderer.invoke(IPC.ghosttySnapshotImage, surfaceId),
  snapshotAndHide: (surfaceId) => ipcRenderer.invoke(IPC.ghosttySnapshotAndHide, surfaceId),
  destroy: (surfaceId) => ipcRenderer.invoke(IPC.ghosttyDestroy, surfaceId),
  onInput: (listener) => subscribe<{ surfaceId: number; data: ArrayBuffer }>(
    IPC.ghosttyInput,
    ({ surfaceId, data }) => listener(surfaceId, new Uint8Array(data)),
  ),
  onClosed: (listener) => subscribe<{ surfaceId: number }>(IPC.ghosttyClosed, ({ surfaceId }) => listener(surfaceId)),
};

const api: PmApi = {
  terminalRenderer: terminalRendererFromArgv(process.argv),
  ghostty,
  call: async (method, params) => {
    if (!isRendererMethod(method)) {
      return { ok: false, error: { code: "methodNotAllowed", message: "method is not available to the renderer" } };
    }
    return ipcRenderer.invoke(IPC.call, method, params);
  },
  connectionState: () => ipcRenderer.invoke(IPC.connectionState),
  onConnectionState: (listener) => subscribe<PmConnectionState>(IPC.connectionStateChanged, listener),
  onEvent: (listener) => subscribe<PmEvent>(IPC.event, listener),
  openExternal: async (url) => { await ipcRenderer.invoke(IPC.openExternal, url); },
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  onNativeShortcut: (listener) => subscribe<{ shortcut: unknown }>(IPC.nativeShortcut, (message) => {
    const shortcut = parseNativeShortcut(message?.shortcut);
    if (shortcut) listener(shortcut);
  }),
  terminal: {
    attach: async (sessionId, rows, cols) => {
      if (!isSessionId(sessionId)) throw new Error("invalid session id");
      await ipcRenderer.invoke(IPC.terminalAttach, sessionId, rows, cols);
    },
    detach: (sessionId) => ipcRenderer.send(IPC.terminalDetach, sessionId),
    input: (sessionId, data) => ipcRenderer.send(IPC.terminalInput, sessionId, data),
    resize: (sessionId, rows, cols) => ipcRenderer.send(IPC.terminalResize, sessionId, rows, cols),
    credit: (sessionId, bytes) => ipcRenderer.send(IPC.terminalCredit, sessionId, bytes),
    onMessage: (listener) => subscribe<PmTerminalMessage>(IPC.terminalMessage, listener),
  },
};

contextBridge.exposeInMainWorld("pm", api);
