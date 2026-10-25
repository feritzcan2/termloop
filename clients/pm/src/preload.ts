// The only bridge between the sandboxed renderer and main. It exposes named
// operations; `call` forwards only allowlisted control methods, and main
// enforces the same allowlist again.
import { contextBridge, ipcRenderer } from "electron";
import { IPC, isRendererMethod, isSessionId, type PmApi, type PmConnectionState, type PmEvent, type PmTerminalMessage } from "./pm-api.js";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const api: PmApi = {
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
