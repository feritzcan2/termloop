// Electron main for TermLoop PM: starts the PM daemon, owns the control
// client and the terminal bridge, and serves the allowlisted `window.pm`
// bridge to one sandboxed window.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GhosttySurfaceManager } from "@termloop/ghostty-host";
import { IPC, isSessionId, TERMINAL_RENDERER_ARG, type PmConnectionState, type PmTerminalMessage } from "./pm-api.js";
import { PmControl } from "./main/control.js";
import { PmDaemonSupervisor, type PmDiscovery } from "./main/daemon-lifecycle.js";
import { PM_NATIVE_INPUT_POLICY, ghosttyHandlers, nativeShortcutMessage } from "./main/ghostty-ipc.js";
import { handleRendererCall, isOpenableUrl, isTrustedSender } from "./main/ipc.js";
import { TerminalBridge } from "./main/terminal-bridge.js";
import {
  createDaemonDeps,
  createSmokeDirectories,
  daemonBinaryExists,
  resolveDaemonBinary,
  signDevDaemon,
} from "./platform/daemon-process.js";
import { loadGhosttyHostAddon } from "./platform/ghostty-host.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const smokeRun = process.argv.includes("--smoke");

let mainWindow: BrowserWindow | undefined;
let supervisor: PmDaemonSupervisor | undefined;
let control: PmControl | undefined;
let terminals: TerminalBridge | undefined;
let ghosttySurfaces: GhosttySurfaceManager | undefined;
let connection: PmConnectionState = { state: "starting" };
let smokeDirectories: Awaited<ReturnType<typeof createSmokeDirectories>> | undefined;
let quitting = false;

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  return isTrustedSender(
    window ? { webContents: window.webContents, mainFrame: window.webContents.mainFrame } : undefined,
    event,
  );
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function setConnection(next: PmConnectionState): void {
  connection = next;
  sendToRenderer(IPC.connectionStateChanged, next);
}

function registerIpc(): void {
  ipcMain.handle(IPC.call, async (event, method: unknown, params: unknown) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    if (!control) return { ok: false, error: { code: "unavailable", message: "The PM daemon is not connected." } };
    return handleRendererCall(control, method, params);
  });
  ipcMain.handle(IPC.connectionState, (event) => {
    if (!trusted(event)) throw new Error("untrusted sender");
    return connection;
  });
  ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
    if (!trusted(event) || !isOpenableUrl(url)) return;
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.pickFolder, async (event) => {
    if (!trusted(event) || !mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.terminalAttach, (event, sessionId: unknown, rows: unknown, cols: unknown) => {
    if (!trusted(event) || !isSessionId(sessionId)) throw new Error("invalid terminal attach");
    if (!terminals) throw new Error("The PM daemon is not connected.");
    terminals.attach(sessionId, typeof rows === "number" ? rows : undefined, typeof cols === "number" ? cols : undefined);
  });
  ipcMain.on(IPC.terminalDetach, (event, sessionId: unknown) => {
    if (trusted(event) && isSessionId(sessionId)) terminals?.detach(sessionId);
  });
  ipcMain.on(IPC.terminalInput, (event, sessionId: unknown, data: unknown) => {
    if (trusted(event) && isSessionId(sessionId) && data instanceof Uint8Array) terminals?.input(sessionId, data);
  });
  ipcMain.on(IPC.terminalResize, (event, sessionId: unknown, rows: unknown, cols: unknown) => {
    if (trusted(event) && isSessionId(sessionId) && typeof rows === "number" && typeof cols === "number") {
      terminals?.resize(sessionId, rows, cols);
    }
  });
  ipcMain.on(IPC.terminalCredit, (event, sessionId: unknown, bytes: unknown) => {
    if (trusted(event) && isSessionId(sessionId) && typeof bytes === "number") terminals?.credit(sessionId, bytes);
  });
  for (const [channel, handler] of Object.entries(ghosttyHandlers(() => ghosttySurfaces))) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("untrusted sender");
      return handler(...args);
    });
  }
}

async function connectDaemon(): Promise<PmDiscovery> {
  if (smokeRun) smokeDirectories = await createSmokeDirectories();
  const binary = resolveDaemonBinary({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
  if (!daemonBinaryExists(binary)) {
    throw new Error(`The PM daemon binary was not found at ${binary}. Run \`cargo build -p termloop-pm-daemon\` or set TERMLOOP_PM_DAEMON.`);
  }
  await signDevDaemon(binary, app.isPackaged);
  supervisor = new PmDaemonSupervisor(createDaemonDeps(binary, smokeDirectories?.env), (code) => {
    if (quitting) return;
    terminals?.stop();
    control?.stop();
    control = undefined;
    terminals = undefined;
    setConnection({ state: "failed", message: `The PM daemon exited unexpectedly (code ${String(code)}). Restart the app.` });
  });
  const discovery = await supervisor.start();
  control = new PmControl(
    discovery,
    (event) => sendToRenderer(IPC.event, event),
    // A re-established subscription may have missed events; tell the
    // renderer to reread the selected project.
    () => sendToRenderer(IPC.event, { event: "pmResubscribed", payload: {} }),
  );
  control.start();
  terminals = new TerminalBridge(
    discovery.terminalUrl,
    discovery.token,
    discovery.runtimeEpoch,
    (message: PmTerminalMessage) => sendToRenderer(IPC.terminalMessage, message),
  );
  const version = await control.call("pm_system_version", {}) as { version: string };
  setConnection({ state: "connected", version: version.version });
  return discovery;
}

async function createWindow(): Promise<BrowserWindow> {
  // Load before the window exists so the preload learns the renderer from argv.
  const ghosttyAddon = loadGhosttyHostAddon(app.getAppPath(), app.isPackaged);
  const window = new BrowserWindow({
    title: "TermLoop PM",
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: !smokeRun,
    backgroundColor: "#0f1115",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(directory, "preload.cjs"),
      additionalArguments: [`${TERMINAL_RENDERER_ARG}${ghosttyAddon ? "ghostty" : "xterm"}`],
    },
  });
  mainWindow = window;
  if (ghosttyAddon) {
    // PM is dark-only, so the dark config also stands in for the light one.
    const config = path.join(directory, "ghostty-embedded.conf");
    ghosttySurfaces = new GhosttySurfaceManager(ghosttyAddon, window, config, config, {
      input: (surfaceId, data) => sendToRenderer(IPC.ghosttyInput, { surfaceId, data }),
      closed: (surfaceId) => sendToRenderer(IPC.ghosttyClosed, { surfaceId }),
      shortcut: (shortcut) => {
        const message = nativeShortcutMessage(shortcut);
        if (message) sendToRenderer(IPC.nativeShortcut, message);
      },
    }, PM_NATIVE_INPUT_POLICY);
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (target !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("closed", () => {
    ghosttySurfaces?.dispose();
    ghosttySurfaces = undefined;
    if (mainWindow === window) mainWindow = undefined;
  });
  await window.loadFile(path.join(directory, "index.html"));
  return window;
}

async function shutdown(): Promise<void> {
  quitting = true;
  terminals?.stop();
  control?.stop();
  await supervisor?.stop();
  await smokeDirectories?.dispose();
}

async function runSmoke(window: BrowserWindow): Promise<void> {
  // Isolation is observable from the page: only the bridge, no Node globals.
  const exposure = await window.webContents.executeJavaScript(
    `({ pm: typeof window.pm, call: typeof window.pm?.call, require: typeof require, process: typeof process })`,
  ) as Record<string, string>;
  if (exposure["pm"] !== "object" || exposure["call"] !== "function" || exposure["require"] !== "undefined" || exposure["process"] !== "undefined") {
    throw new Error(`unexpected renderer exposure ${JSON.stringify(exposure)}`);
  }
  const version = await window.webContents.executeJavaScript(`window.pm.call("pm_system_version", {})`) as { ok: boolean; result?: { product: string } };
  if (!version.ok || version.result?.product !== "termloop-pm") throw new Error("pm_system_version failed through the bridge");
  const refused = await window.webContents.executeJavaScript(`window.pm.call("pm_subscribe", { events: [] })`) as { ok: boolean };
  if (refused.ok) throw new Error("the bridge forwarded a method outside the renderer allowlist");
  const rendered = await window.webContents.executeJavaScript(
    `new Promise((resolve) => { const started = Date.now(); const poll = () => { const text = document.body.innerText; if (text.includes("TermLoop PM") || Date.now() - started > 10000) resolve(text.includes("TermLoop PM")); else setTimeout(poll, 100); }; poll(); })`,
  ) as boolean;
  if (!rendered) throw new Error("the renderer did not render the PM shell");
  console.log("pm-app-smoke: PASS pm_system_version through window.pm");
}

app.whenReady().then(async () => {
  registerIpc();
  const window = await createWindow();
  try {
    await connectDaemon();
  } catch (error) {
    setConnection({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    if (smokeRun) throw error;
  }
  if (smokeRun) {
    await runSmoke(window);
    await shutdown();
    app.exit(0);
  }
}).catch(async (error: unknown) => {
  console.error(`pm-app: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await shutdown().catch(() => {});
  app.exit(1);
});

let shutdownDone = false;
app.on("before-quit", (event) => {
  if (shutdownDone) return;
  event.preventDefault();
  if (quitting) return;
  void shutdown().finally(() => {
    shutdownDone = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
