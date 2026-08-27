import { contextBridge, ipcRenderer } from "electron";

import type { LayoutDocument } from "./layout/model.js";
import type {
  ConnectionProfileConnectInput,
  RemoteHostTransport,
} from "./connection-profile-types.js";
import {
  PROFILED_DESKTOP_OPERATIONS,
  connectionProfileEnvelope,
} from "./source-operations.js";
import { unwrapConnectionEntities } from "./connection-scope.js";

const profiledBridgeOperations = Object.fromEntries(
  Object.entries(PROFILED_DESKTOP_OPERATIONS).map(([name, channel]) => [
    name,
    (profileId: string, ...args: unknown[]) => ipcRenderer.invoke(
      channel,
      ...unwrapConnectionEntities(args, profileId),
      connectionProfileEnvelope(profileId),
    ),
  ]),
);

ipcRenderer.on("termloop:terminal-port", (event, message: { requestId: string }) => {
  window.postMessage(
    { source: "termloop", type: "terminal-port", requestId: message.requestId },
    "*",
    event.ports,
  );
});

ipcRenderer.on("termloop:ghostty-input", (_event, message: { surfaceId: number; data: ArrayBuffer }) => {
  window.postMessage({ source: "termloop", type: "ghostty-input", ...message }, "*");
});

ipcRenderer.on("termloop:ghostty-closed", (_event, message: { surfaceId: number }) => {
  window.postMessage({ source: "termloop", type: "ghostty-closed", ...message }, "*");
});

ipcRenderer.on("termloop:ghostty-shell-shortcut", (_event, message: { shortcut: string }) => {
  window.postMessage({ source: "termloop", type: "ghostty-shell-shortcut", ...message }, "*");
});

ipcRenderer.on("termloop:gateway-state", (_event, message: { profileId: string; state: string }) => {
  window.postMessage({ source: "termloop", type: "gateway-state", ...message }, "*");
});

for (const [channel, type] of [
  ["termloop:projection-invalidated", "projection-invalidated"],
  ["termloop:connection-status", "connection-status"],
  ["termloop:agent-attention-activated", "agent-attention-activated"],
] as const) {
  ipcRenderer.on(channel, (_event, payload: unknown) => {
    window.postMessage({ source: "termloop", type, payload }, "*");
  });
}

ipcRenderer.on("termloop:native-overlay-closed", () => {
  window.postMessage({ source: "termloop", type: "native-overlay-closed" }, "*");
});

contextBridge.exposeInMainWorld("termloop", {
  isPackaged: () => ipcRenderer.invoke("termloop:app-is-packaged"),
  pickLocalFolder: (defaultPath?: string) => ipcRenderer.invoke("termloop:pick-local-folder", defaultPath),
  mobileAccessPairing: () => ipcRenderer.invoke("termloop:mobile-access-pairing"),
  connectionProfileList: () => ipcRenderer.invoke("termloop:connection-profile-list"),
  connectionProfileReconnect: (profileId: string) =>
    ipcRenderer.invoke("termloop:connection-profile-reconnect", profileId),
  connectionProfileConnect: (input: ConnectionProfileConnectInput) =>
    ipcRenderer.invoke("termloop:connection-profile-connect", input),
  connectionProfileSetEnabled: (profileId: string, enabled: boolean) =>
    ipcRenderer.invoke("termloop:connection-profile-set-enabled", profileId, enabled),
  connectionProfileRemove: (profileId: string) =>
    ipcRenderer.invoke("termloop:connection-profile-remove", profileId),
  tailscaleServerDiscover: () => ipcRenderer.invoke("termloop:tailscale-server-discover"),
  remoteHostStatus: () => ipcRenderer.invoke("termloop:remote-host-status"),
  remoteHostEnable: (transport: RemoteHostTransport) => ipcRenderer.invoke("termloop:remote-host-enable", transport),
  remoteHostDisable: () => ipcRenderer.invoke("termloop:remote-host-disable"),
  terminalRendererKind: () => ipcRenderer.invoke("termloop:terminal-renderer-kind"),
  nativeOverlaySetVisible: (visible: boolean) =>
    ipcRenderer.invoke("termloop:native-overlay-set-visible", visible),
  nativeOverlaySetPassiveVisible: (visible: boolean) =>
    ipcRenderer.invoke("termloop:native-overlay-set-passive-visible", visible),
  nativeOverlaySetPointerInteractive: (interactive: boolean) =>
    ipcRenderer.invoke("termloop:native-overlay-set-pointer-interactive", interactive),
  nativeOverlaySetPassiveRegion: (region: { x: number; y: number; width: number; height: number } | null) =>
    ipcRenderer.invoke("termloop:native-overlay-set-passive-region", region),
  ghosttySurfaceCreate: (frame?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("termloop:ghostty-surface-create", frame),
  ghosttySurfaceWrite: (surfaceId: number, data: ArrayBuffer) =>
    ipcRenderer.invoke("termloop:ghostty-surface-write", surfaceId, data),
  ghosttySurfaceSetFrame: (surfaceId: number, x: number, y: number, width: number, height: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-set-frame", surfaceId, x, y, width, height),
  ghosttySurfaceSetVisible: (surfaceId: number, visible: boolean) =>
    ipcRenderer.invoke("termloop:ghostty-surface-set-visible", surfaceId, visible),
  ghosttySurfaceSnapshotText: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-snapshot-text", surfaceId),
  ghosttySurfaceSnapshotImage: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-snapshot-image", surfaceId),
  ghosttySurfaceSnapshotAndHide: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-snapshot-and-hide", surfaceId),
  ghosttySurfaceFocus: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-focus", surfaceId),
  ghosttySurfaceDiagnosticText: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-diagnostic-text", surfaceId),
  ghosttySurfaceDestroy: (surfaceId: number) =>
    ipcRenderer.invoke("termloop:ghostty-surface-destroy", surfaceId),
  promptAssetsGet: () => ipcRenderer.invoke("termloop:prompt-assets-get"),
  promptAssetUpdate: (id: string, body: string) =>
    ipcRenderer.invoke("termloop:prompt-asset-update", id, body),
  promptAssetReset: (id: string) => ipcRenderer.invoke("termloop:prompt-asset-reset", id),
  layoutLoad: () => ipcRenderer.invoke("termloop:layout-load") as Promise<LayoutDocument>,
  layoutSave: (document: LayoutDocument) => ipcRenderer.invoke("termloop:layout-save", document),
  ...profiledBridgeOperations,
});
