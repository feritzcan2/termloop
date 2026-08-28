import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  TermLoopControlError,
  type CallArgs,
  type ContextBankCatalogGetParams,
  type ContextBankFileGetParams,
  type ContextBankFileSaveParams,
  type ContextBankSiblingConflictResolveParams,
  type ErrorCode,
  type KeepAwakeSetParams,
  type Method,
  type McpToolDescriptionResetParams,
  type McpToolDescriptionUpdateParams,
  type SkillCatalogGetParams,
  type SkillDefinitionGetParams,
  type SkillDefinitionCreateParams,
  type SkillDefinitionSaveParams,
  type SkillDeploymentSetParams,
  type ProtocolErrorDetails,
  type QuickActionParams,
  type QuickActionLaunchParams,
  type ResultFor,
  type TaskProvisionWorktreeParams,
} from "@termloop/contract/current";
import {
  connectionConfig,
  controlCall,
  controlCallFor,
  installConnectionRegistry,
  probeDaemonAlive,
  projectCwd,
  requestDiscoveredDaemonShutdown,
} from "./main/control.js";
import {
  BundledDaemonSupervisor,
  bundledDaemonMode,
  shouldRestartAgentsForClientLaunch,
} from "./main/daemon-lifecycle.js";
import { TerminalGatewayRegistry, gatewayEntry } from "./main/terminal-gateway.js";
import { ConnectionRegistry, LOCAL_CONNECTION_PROFILE_ID } from "./main/connection-registry.js";
import { currentConnectionProfileId, sourceAwareIpcHandle } from "./main/ipc-source-context.js";
import { connectionEntityKey } from "./connection-scope.js";
import { interactiveTaskCreateParams } from "./task-automation-transport.js";
import { remoteConnectionFailureMessage } from "./main/access-websocket.js";
import { connectionProfiles } from "./main/connection-profiles.js";
import type {
  ConnectionProfileConnectInput,
  RemoteHostTransport,
} from "./connection-profile-types.js";
import { RemoteHostManager } from "./main/remote-host.js";
import { TailscaleServerDiscoveryManager } from "./main/tailscale-discovery.js";
import { validatedExternalUrl, validatedLoopbackRunUrl } from "./main/external-link.js";
import { LayoutFileStore } from "./platform/layout-store.js";
import { createArchiveOperationId, createClientLaunchId } from "./platform/client-launch.js";
import {
  publishDevelopmentReadyMarker,
  removeDevelopmentReadyMarker,
} from "./platform/dev-ready.js";
import {
  applyUntaggedApplicationIcon,
  developmentApplicationName,
  developmentWindowStartMode,
  desktopUserDataPath,
  linkedWorktreeProfileStartupError,
  prioritizeDevelopmentProject,
} from "./platform/dev-profile.js";
import {
  bundledDaemonServerExists,
  bundledDaemonServerPath,
  spawnBundledDaemon,
} from "./platform/daemon-runtime.js";
import { applicationMenuTemplate, shouldRemoveApplicationMenu } from "./platform/application-menu.js";
import { windowFrameOptions } from "./platform/window-frame.js";
import { requestedTerminalRenderer, type TerminalRendererKind } from "./platform/terminal-renderer.js";
import { loadGhosttyHostAddon } from "./platform/ghostty-host.js";
import { GhosttySurfaceManager, type SurfaceFrame } from "./main/ghostty-surfaces.js";
import { NativeOverlayWindowManager, type NativeOverlayPassiveRegion } from "./main/native-overlay-window.js";
import { QuickActionImageStore } from "./platform/quick-action-image-store.js";
import { uploadQuickActionImage } from "./main/attachment-upload.js";
import { ForwardManager } from "./main/forwarding.js";
import { cursorScreenPoint } from "./platform/cursor-position.js";
import { PromptAssetStore } from "./platform/prompt-assets.js";
import {
  mobileAccessNodeExecutable,
  mobileAccessScriptPath,
  prepareMobileAccessQr,
} from "./platform/mobile-access.js";
import { UpdateManager } from "./main/update-manager.js";
import { autoUpdateSupported } from "./platform/auto-update-policy.js";
import { createAutoUpdateDriver, scheduleAutoUpdateTask } from "./platform/auto-update.js";

declare const TERMLOOP_COMPILED_DEV_PROFILE: string | null;

const directory = path.dirname(fileURLToPath(import.meta.url));
const handleIpc = sourceAwareIpcHandle(ipcMain);
const smokeRun = process.argv.includes("--smoke");
const developmentProfileStartupError = linkedWorktreeProfileStartupError(
  TERMLOOP_COMPILED_DEV_PROFILE,
  app.isPackaged,
  smokeRun,
  process.env,
);
if (developmentProfileStartupError) throw new Error(developmentProfileStartupError);
const applicationName = developmentApplicationName(process.env.TERMLOOP_DEV_PROFILE_TAG);
const windowStartMode = developmentWindowStartMode(process.env.TERMLOOP_DEV_PROFILE_TAG, smokeRun);
if (process.env.TERMLOOP_DEV_PROFILE_TAG) app.setName(applicationName);
const userDataOverride = desktopUserDataPath(
  process.env.TERMLOOP_DESKTOP_USER_DATA_DIR,
  app.isPackaged,
  smokeRun,
  process.pid,
  os.tmpdir(),
  app.getPath("appData"),
);
if (userDataOverride) app.setPath("userData", userDataOverride);
const remoteHost = new RemoteHostManager();
const tailscaleDiscovery = new TailscaleServerDiscoveryManager();
let layoutStore: LayoutFileStore | undefined;
let daemonSupervisor: BundledDaemonSupervisor | undefined;
let mainWindow: BrowserWindow | undefined;
let ghosttySurfaces: GhosttySurfaceManager | undefined;
let nativeOverlayWindow: NativeOverlayWindowManager | undefined;
let effectiveTerminalRenderer: TerminalRendererKind = "xterm";
let quickActionImageStore: QuickActionImageStore | undefined;
const forwardManager = new ForwardManager(async (profileId) => {
  const config = await connectionConfig(profileId);
  return config?.kind === "remote" ? config : undefined;
});
const attentionNotifications = new Map<string, Notification>();
const clientLaunchId = createClientLaunchId();
let clientLaunchRestartSent = false;
let restartAgentsForLocalSubscription = false;
let promptAssetStore: PromptAssetStore | undefined;

const connections = new ConnectionRegistry({
  invalidated(profileId, payload) {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      window.webContents.send("termloop:projection-invalidated", { profileId, payload });
    }
  },
  statusChanged(summary) {
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      window.webContents.send("termloop:connection-status", summary);
    }
  },
  async localSubscriptionConnected() {
    if (!restartAgentsForLocalSubscription || clientLaunchRestartSent) return;
    await controlCallFor(LOCAL_CONNECTION_PROFILE_ID, "session.restartAgentsForClientLaunch", { clientLaunchId });
    clientLaunchRestartSent = true;
  },
});
installConnectionRegistry(connections);
const gateways = new TerminalGatewayRegistry(
  gatewayEntry(directory),
  (profileId) => connections.connectionConfig(profileId),
);

function prompts(): PromptAssetStore {
  promptAssetStore ??= new PromptAssetStore(
    path.join(directory, "prompts"),
    path.join(app.getPath("userData"), "prompt-overrides"),
  );
  return promptAssetStore;
}

function quickActionImages(): QuickActionImageStore {
  quickActionImageStore ??= new QuickActionImageStore(app.getPath("userData"));
  return quickActionImageStore;
}

function requireMainRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("rendererSenderDenied");
  }
}
const ownsSingleInstance = app.requestSingleInstanceLock();
if (smokeRun && !ownsSingleInstance) {
  throw new Error(
    "smoke run did not own the single-instance lock; stop the running desktop or set TERMLOOP_DESKTOP_USER_DATA_DIR",
  );
}

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

async function minimizeWithoutFocus(window: BrowserWindow): Promise<void> {
  window.showInactive();
  window.minimize();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (window.isMinimized()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("tagged development window did not enter the minimized state");
}

async function typedControlCall<M extends Method>(
  method: M,
  ...args: CallArgs<M>
): Promise<
  | { ok: true; result: ResultFor<M> }
  | { ok: false; code: ErrorCode | undefined; details: ProtocolErrorDetails | undefined; message: string }
> {
  try {
    return { ok: true as const, result: await controlCall(method, ...args) };
  } catch (error) {
    if (error instanceof TermLoopControlError) {
      return {
        ok: false as const,
        code: error.code,
        details: error.details,
        message: error.message,
      };
    }
    throw error;
  }
}

function clientLayoutStore(): LayoutFileStore {
  const override = process.env.TERMLOOP_LAYOUT_FILE;
  layoutStore ??= new LayoutFileStore(
    override ?? path.join(app.getPath("userData"), "layout.v2.json"),
    override ? undefined : path.join(app.getPath("userData"), "layout.v1.json"),
    () => connectionProfiles().layoutMigrationProfileId(),
  );
  return layoutStore;
}

handleIpc("termloop:app-is-packaged", (event) => {
  requireMainRenderer(event);
  return app.isPackaged;
});

/// The OS folder panel, offered next to the daemon's own folder listing. It can
/// only see this computer, so the renderer asks for it exclusively on the local
/// connection; a remote Project keeps browsing through `system.browseDirectory`.
/// Main returns a path string and nothing else: no handle, no descriptor, and no
/// wider filesystem authority reaches the renderer.
handleIpc("termloop:pick-local-folder", async (event, defaultPath: unknown) => {
  requireMainRenderer(event);
  if (!mainWindow) return null;
  const start = typeof defaultPath === "string" && defaultPath.trim().length > 0 ? defaultPath.trim() : undefined;
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a Project folder",
    buttonLabel: "Choose",
    properties: ["openDirectory", "createDirectory"],
    ...(start ? { defaultPath: start } : {}),
  });
  return picked.canceled ? null : picked.filePaths[0] ?? null;
});

handleIpc("termloop:system-info", async () => {
  const config = await connectionConfig();
  if (!config) return { state: "daemonUnavailable" };
  try {
    const [version, capabilities, ping] = await Promise.all([
      controlCall("system.version"),
      controlCall("system.capabilities"),
      controlCall("system.ping"),
    ]);
    return { state: "connected", version, capabilities, ping };
  } catch (error) {
    return {
      state: "connectionError",
      message: config.kind === "remote"
        ? remoteConnectionFailureMessage(config.profileId) ?? (error instanceof Error ? error.message : String(error))
        : error instanceof Error ? error.message : String(error),
    };
  }
});

handleIpc("termloop:mobile-access-pairing", async (event) => {
  requireMainRenderer(event);
  if (app.isPackaged) {
    return { ok: false, error: "Mobile Access is not included in this packaged preview yet." } as const;
  }
  try {
    const script = mobileAccessScriptPath(directory, process.env.TERMLOOP_DEV_CHECKOUT);
    return {
      ok: true,
      qrSvg: await prepareMobileAccessQr(
        script,
        mobileAccessNodeExecutable(process.env.TERMLOOP_DEV_NODE_BINARY),
      ),
    } as const;
  } catch (cause: unknown) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : "Mobile Access could not be prepared.",
    } as const;
  }
});

handleIpc("termloop:project-list", async () => prioritizeDevelopmentProject(
  await controlCall("project.list"),
  process.env.TERMLOOP_DEV_PROJECT_DIR,
));
handleIpc("termloop:project-worktree-summary", (_event, projectId: string) =>
  controlCall("project.worktreeSummary", { projectId }),
);
handleIpc("termloop:project-worktree-change-list", (_event, projectId: string) =>
  controlCall("project.worktreeChangeList", { projectId }),
);
handleIpc(
  "termloop:project-worktree-diff",
  (_event, projectId: string, observationId: string, entryId: string) =>
    controlCall("project.worktreeDiff", { projectId, observationId, entryId }),
);
handleIpc(
  "termloop:project-worktree-pre-image",
  (_event, projectId: string, observationId: string, entryId: string) =>
    controlCall("project.worktreePreImage", { projectId, observationId, entryId }),
);
handleIpc("termloop:keep-awake-get", () => controlCall("system.keepAwake.get"));
handleIpc("termloop:keep-awake-set", (_event, params: KeepAwakeSetParams) =>
  controlCall("system.keepAwake.set", params),
);
handleIpc("termloop:voice-settings-get", () => controlCall("voice.settingsGet"));
handleIpc(
  "termloop:voice-credentials-set",
  (_event, params: import("@termloop/contract/current").VoiceCredentialsSetParams) =>
    controlCall("voice.credentialsSet", params),
);
handleIpc("termloop:mcp-tool-settings-get", () => controlCall("mcp.toolSettingsGet"));
handleIpc(
  "termloop:mcp-tool-description-update",
  (_event, params: McpToolDescriptionUpdateParams) =>
    typedControlCall("mcp.toolDescriptionUpdate", params),
);
handleIpc(
  "termloop:mcp-tool-description-reset",
  (_event, params: McpToolDescriptionResetParams) =>
    typedControlCall("mcp.toolDescriptionReset", params),
);
handleIpc("termloop:prompt-assets-get", () => prompts().list());
handleIpc("termloop:prompt-asset-update", (_event, id: string, body: string) => prompts().update(id, body));
handleIpc("termloop:prompt-asset-reset", (_event, id: string) => prompts().reset(id));
handleIpc("termloop:skill-catalog-get", (_event, params: SkillCatalogGetParams) =>
  controlCall("skill.catalogGet", params),
);
handleIpc("termloop:skill-deployment-set", (_event, params: SkillDeploymentSetParams) =>
  controlCall("skill.deploymentSet", params),
);
handleIpc("termloop:skill-definition-get", (_event, params: SkillDefinitionGetParams) =>
  controlCall("skill.definitionGet", params),
);
handleIpc("termloop:skill-definition-save", (_event, params: SkillDefinitionSaveParams) =>
  controlCall("skill.definitionSave", params),
);
handleIpc("termloop:skill-definition-create", (_event, params: SkillDefinitionCreateParams) =>
  controlCall("skill.definitionCreate", params),
);
handleIpc("termloop:context-bank-catalog-get", (_event, params: ContextBankCatalogGetParams) =>
  controlCall("contextBank.catalogGet", params),
);
handleIpc("termloop:context-bank-file-get", (_event, params: ContextBankFileGetParams) =>
  controlCall("contextBank.fileGet", params),
);
handleIpc("termloop:context-bank-file-save", (_event, params: ContextBankFileSaveParams) =>
  controlCall("contextBank.fileSave", params),
);
handleIpc("termloop:context-bank-sibling-conflict-resolve", (_event, params: ContextBankSiblingConflictResolveParams) =>
  controlCall("contextBank.siblingConflictResolve", params),
);
handleIpc("termloop:project-create", (_event, name: string, folderPath: string) =>
  controlCall("project.create", { name, folderPath }),
);
handleIpc("termloop:project-update", (_event, projectId: string, name: string, folderPath: string) =>
  controlCall("project.updateDetails", { projectId, name, folderPath }),
);
handleIpc("termloop:project-delete", async (_event, projectId: string) => {
  try {
    return { ok: true, result: await controlCall("project.delete", { projectId }) };
  } catch (error) {
    return { ok: false, error: serializableControlError(error) };
  }
});
handleIpc("termloop:project-list-local-branches", (_event, projectId: string) =>
  controlCall("project.listLocalBranches", { projectId }),
);
handleIpc("termloop:project-task-automation-get", (_event, projectId: string) =>
  controlCall("project.taskAutomationGet", { projectId }),
);
handleIpc(
  "termloop:project-task-automation-set",
  (_event, params: import("@termloop/contract/current").ProjectTaskAutomationSetParams) =>
    controlCall("project.taskAutomationSet", params),
);
handleIpc("termloop:task-list", async (
  _event,
  projectId: string,
  taskIds?: string[],
  archiveScope: "active" | "archived" | "all" = "active",
) => {
  connections.setSelectedProjectDemand(currentConnectionProfileId(), projectId);
  const page = await controlCall("task.list", {
    projectId,
    archiveScope,
    ...(taskIds ? { taskIds } : {}),
  });
  return page.items;
});
handleIpc("termloop:task-worktree-change-list", (_event, taskId: string) =>
  controlCall("task.worktreeChangeList", { taskId }),
);
handleIpc(
  "termloop:task-worktree-diff",
  (_event, taskId: string, observationId: string, entryId: string) =>
    controlCall("task.worktreeDiff", { taskId, observationId, entryId }),
);
handleIpc(
  "termloop:task-worktree-pre-image",
  (_event, taskId: string, observationId: string, entryId: string) =>
    controlCall("task.worktreePreImage", { taskId, observationId, entryId }),
);
handleIpc("termloop:task-branch-commit-summary-list", (_event, projectId: string, taskIds: string[]) =>
  controlCall("task.branchCommitSummaryList", { projectId, taskIds }),
);
handleIpc("termloop:task-branch-commit-list", (_event, taskId: string) =>
  controlCall("task.branchCommitList", { taskId }),
);
handleIpc(
  "termloop:task-branch-commit-change-list",
  (_event, taskId: string, observationId: string, commitId: string) =>
    controlCall("task.branchCommitChangeList", { taskId, observationId, commitId }),
);
handleIpc(
  "termloop:task-branch-commit-diff",
  (_event, taskId: string, observationId: string, commitId: string, entryId: string) =>
    controlCall("task.branchCommitDiff", { taskId, observationId, commitId, entryId }),
);
handleIpc("termloop:git-host-pull-request-list", (_event, projectId: string, taskIds: string[]) =>
  controlCall("gitHost.pullRequestList", { projectId, taskIds }),
);
handleIpc(
  "termloop:git-host-pull-request-change-list",
  (
    _event,
    taskId: string,
    expectedFreshnessGeneration: number,
    pullRequest: import("@termloop/contract/current").GitHostPullRequestIdentityDto,
  ) => controlCall("gitHost.pullRequestChangeList", { taskId, expectedFreshnessGeneration, pullRequest }),
);
handleIpc(
  "termloop:git-host-pull-request-diff",
  (_event, taskId: string, observationId: string, entryId: string) =>
    controlCall("gitHost.pullRequestDiff", { taskId, observationId, entryId }),
);
handleIpc("termloop:open-external", async (event, value: string, runSessionId?: string) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("externalLinkSenderDenied");
  }
  const url = runSessionId === undefined
    ? validatedExternalUrl(value)
    : await validatedAdvertisedRunUrl(value, runSessionId);
  const config = await connectionConfig();
  const parsed = new URL(url);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  const target = config?.kind === "remote" && loopback
    ? await forwardManager.localUrl(url, config)
    : url;
  await shell.openExternal(target);
});

async function validatedAdvertisedRunUrl(value: string, runSessionId: string): Promise<string> {
  if (typeof runSessionId !== "string" || runSessionId.length === 0 || runSessionId.length > 128) {
    throw new Error("runUrlDenied");
  }
  const url = validatedLoopbackRunUrl(value);
  const sessions = await controlCall("session.list");
  const session = sessions.find((candidate) =>
    candidate.id === runSessionId
    && candidate.lifecycle_state === "running"
    && candidate.run_configuration_id !== null
  );
  if (!session) throw new Error("runUrlDenied");
  const runtime = (await controlCall("run.runtimeList", { projectId: session.project_id }))
    .runs
    .find((candidate) => candidate.sessionId === session.id && candidate.exitCode === null);
  if (!runtime?.urls.some((candidate) => {
    try {
      return validatedLoopbackRunUrl(candidate) === url;
    } catch {
      return false;
    }
  })) {
    throw new Error("runUrlDenied");
  }
  return url;
}
handleIpc("termloop:copy-session-id", async (event, sessionId: string) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("clipboardSenderDenied");
  }
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
    throw new Error("invalidSessionId");
  }
  const sessions = await controlCall("session.list");
  if (!sessions.some((session) => session.id === sessionId && session.kind === "Agent")) {
    throw new Error("agentSessionNotFound");
  }
  clipboard.writeText(sessionId);
});
function surfaceFrameOrUndefined(frame: unknown): SurfaceFrame | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const candidate = frame as Record<string, unknown>;
  const values = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("invalidGhosttySurfaceFrame");
  }
  const width = candidate.width as number;
  const height = candidate.height as number;
  if (width <= 0 || height <= 0) throw new Error("invalidGhosttySurfaceFrame");
  return { x: candidate.x as number, y: candidate.y as number, width, height };
}

function requireGhosttyManager(event: Electron.IpcMainInvokeEvent): GhosttySurfaceManager {
  requireMainRenderer(event);
  if (!ghosttySurfaces) throw new Error("ghosttyUnavailable");
  return ghosttySurfaces;
}

function requireSurfaceId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("invalidGhosttySurfaceId");
  return value;
}

handleIpc("termloop:terminal-renderer-kind", (event) => {
  requireMainRenderer(event);
  return effectiveTerminalRenderer;
});
handleIpc("termloop:native-overlay-set-visible", (event, visible: unknown) => {
  requireMainRenderer(event);
  if (typeof visible !== "boolean") throw new Error("invalidNativeOverlayVisibility");
  if (!nativeOverlayWindow) throw new Error("nativeOverlayUnavailable");
  nativeOverlayWindow.setVisible(visible);
});
handleIpc("termloop:native-overlay-set-passive-visible", (event, visible: unknown) => {
  requireMainRenderer(event);
  if (typeof visible !== "boolean") throw new Error("invalidNativeOverlayPassiveVisibility");
  if (!nativeOverlayWindow) throw new Error("nativeOverlayUnavailable");
  nativeOverlayWindow.setPassiveVisible(visible);
});
handleIpc("termloop:native-overlay-set-pointer-interactive", (event, interactive: unknown) => {
  requireMainRenderer(event);
  if (typeof interactive !== "boolean") throw new Error("invalidNativeOverlayPointerInteraction");
  if (!nativeOverlayWindow) throw new Error("nativeOverlayUnavailable");
  nativeOverlayWindow.setPointerInteractive(interactive);
});
handleIpc("termloop:native-overlay-set-passive-region", (event, region: unknown) => {
  requireMainRenderer(event);
  if (!nativeOverlayWindow) throw new Error("nativeOverlayUnavailable");
  if (region === null) {
    nativeOverlayWindow.setPassiveRegion(undefined);
    return;
  }
  if (!region || typeof region !== "object") throw new Error("invalidNativeOverlayPassiveRegion");
  const candidate = region as Record<string, unknown>;
  const values = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))
    || (candidate.width as number) < 0 || (candidate.height as number) < 0) {
    throw new Error("invalidNativeOverlayPassiveRegion");
  }
  nativeOverlayWindow.setPassiveRegion({
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
  } satisfies NativeOverlayPassiveRegion);
});
handleIpc("termloop:ghostty-surface-create", (event, frame: unknown) =>
  requireGhosttyManager(event).create(surfaceFrameOrUndefined(frame)));
handleIpc("termloop:ghostty-surface-write", async (event, surfaceId: unknown, data: unknown) => {
  const manager = requireGhosttyManager(event);
  const id = requireSurfaceId(surfaceId);
  if (!(data instanceof ArrayBuffer)) throw new Error("invalidGhosttySurfaceData");
  await manager.write(id, new Uint8Array(data));
});
handleIpc(
  "termloop:ghostty-surface-set-frame",
  (event, surfaceId: unknown, x: unknown, y: unknown, width: unknown, height: unknown) => {
    const manager = requireGhosttyManager(event);
    const values = [x, y, width, height];
    if (!values.every((value) => typeof value === "number" && Number.isFinite(value)) ||
        (width as number) < 0 || (height as number) < 0) throw new Error("invalidGhosttySurfaceFrame");
    return manager.setFrame(requireSurfaceId(surfaceId), x as number, y as number, width as number, height as number);
  },
);
handleIpc("termloop:ghostty-surface-set-visible", (event, surfaceId: unknown, visible: unknown) => {
  if (typeof visible !== "boolean") throw new Error("invalidGhosttySurfaceVisibility");
  requireGhosttyManager(event).setVisible(requireSurfaceId(surfaceId), visible);
});
handleIpc("termloop:ghostty-surface-snapshot-text", (event, surfaceId: unknown) => {
  const text = requireGhosttyManager(event).probeText(requireSurfaceId(surfaceId));
  return text?.slice(0, 262_144);
});
handleIpc("termloop:ghostty-surface-snapshot-image", (event, surfaceId: unknown) => {
  const png = requireGhosttyManager(event).snapshotPng(requireSurfaceId(surfaceId));
  if (!png || png.byteLength > 32 * 1024 * 1024) return undefined;
  return `data:image/png;base64,${png.toString("base64")}`;
});
handleIpc("termloop:ghostty-surface-snapshot-and-hide", (event, surfaceId: unknown) => {
  const png = requireGhosttyManager(event).snapshotAndHidePng(requireSurfaceId(surfaceId));
  if (!png || png.byteLength > 32 * 1024 * 1024) return undefined;
  return `data:image/png;base64,${png.toString("base64")}`;
});
handleIpc("termloop:ghostty-surface-focus", (event, surfaceId: unknown) => {
  requireGhosttyManager(event).focus(requireSurfaceId(surfaceId));
});
handleIpc("termloop:ghostty-surface-diagnostic-text", (event, surfaceId: unknown) => {
  if (process.env.TERMLOOP_DESKTOP_DIAGNOSTICS !== "1") throw new Error("terminalDiagnosticsDisabled");
  return requireGhosttyManager(event).probeText(requireSurfaceId(surfaceId));
});
handleIpc("termloop:ghostty-surface-destroy", (event, surfaceId: unknown) => {
  requireGhosttyManager(event).destroy(requireSurfaceId(surfaceId));
});
function clipboardPng() {
  const image = clipboard.readImage();
  if (image.isEmpty()) throw new Error("quickActionClipboardImageMissing");
  const { width, height } = image.getSize();
  return { png: image.toPNG(), width, height, image };
}
handleIpc("termloop:quick-action-paste-image", async (event) => {
  requireMainRenderer(event);
  const { image, png, width, height } = clipboardPng();
  const previewScale = Math.min(1, 160 / Math.max(width, height));
  const preview = image.resize({
    width: Math.max(1, Math.round(width * previewScale)),
    height: Math.max(1, Math.round(height * previewScale)),
    quality: "good",
  });
  const attachment = await uploadQuickActionImage(png, width, height);
  return quickActionImages().stage(
    png,
    width,
    height,
    preview.toDataURL(),
    attachment,
    currentConnectionProfileId(),
  );
});
handleIpc("termloop:session-paste-image", async (event, sessionId: string) => {
  requireMainRenderer(event);
  if (typeof sessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(sessionId)) {
    throw new Error("invalidSessionId");
  }
  const { png, width, height } = clipboardPng();
  const attachment = await uploadQuickActionImage(png, width, height);
  return typedControlCall("session.pasteImage", { sessionId, attachments: [attachment] });
});
handleIpc("termloop:quick-action-restore-image", async (event, attachmentId: string) => {
  requireMainRenderer(event);
  if (typeof attachmentId !== "string") throw new Error("quickActionImageSelectionInvalid");
  return quickActionImages().restore(attachmentId, currentConnectionProfileId());
});
handleIpc("termloop:quick-action-discard-image", async (event, attachmentId: string) => {
  requireMainRenderer(event);
  if (typeof attachmentId !== "string") throw new Error("quickActionImageSelectionInvalid");
  await quickActionImages().discard(attachmentId, currentConnectionProfileId());
});
handleIpc("termloop:task-inspect-worktree-cleanup", (_event, taskId: string) =>
  controlCall("task.inspectWorktreeCleanup", { taskId }),
);
handleIpc("termloop:task-cleanup-worktree", (_event, params: import("@termloop/contract/current").TaskCleanupWorktreeParams) =>
  controlCall("task.cleanupWorktree", params),
);
handleIpc("termloop:task-forget-stale-worktree", (_event, params: import("@termloop/contract/current").TaskForgetStaleWorktreeParams) =>
  typedControlCall("task.forgetStaleWorktree", params),
);
handleIpc("termloop:task-discard-stale-worktree", (_event, params: import("@termloop/contract/current").TaskDiscardStaleWorktreeParams) =>
  typedControlCall("task.discardStaleWorktree", params),
);
handleIpc("termloop:task-inspect-worktree-repair", (_event, taskId: string, candidatePath: string) =>
  typedControlCall("task.inspectWorktreeRepair", { taskId, candidatePath }),
);
handleIpc("termloop:task-repair-worktree", (_event, params: import("@termloop/contract/current").TaskRepairWorktreeParams) =>
  typedControlCall("task.repairWorktree", params),
);
handleIpc("termloop:task-dismiss-worktree-repair", (_event, taskId: string, operationId: string) =>
  typedControlCall("task.dismissWorktreeRepair", { taskId, operationId }),
);
handleIpc("termloop:task-bind-branch", async (_event, taskId: string, repositoryPath: string, branchName: string) => {
  const result = await typedControlCall("task.bindBranch", { taskId, repositoryPath, branchName });
  return result.ok ? { ok: true as const, task: result.result } : result;
});
handleIpc("termloop:task-provision-worktree", async (_event, params: TaskProvisionWorktreeParams) => {
  return typedControlCall("task.provisionWorktree", params);
});
handleIpc("termloop:task-dismiss-worktree-provisioning", (_event, taskId: string, operationId: string) =>
  controlCall("task.dismissWorktreeProvisioning", { taskId, operationId }),
);
handleIpc("termloop:task-launch-terminal", (_event, taskId: string) =>
  typedControlCall("task.launchTerminal", { taskId }),
);
handleIpc("termloop:task-start-run", (_event, params: import("@termloop/contract/current").TaskStartRunParams) =>
  typedControlCall("task.startRun", params),
);
handleIpc("termloop:task-restart-run", (_event, params: import("@termloop/contract/current").TaskRestartRunParams) =>
  typedControlCall("task.restartRun", params),
);
handleIpc("termloop:project-start-run", (_event, params: import("@termloop/contract/current").ProjectStartRunParams) =>
  typedControlCall("project.startRun", params),
);
handleIpc("termloop:project-restart-run", (_event, params: import("@termloop/contract/current").ProjectRestartRunParams) =>
  typedControlCall("project.restartRun", params),
);
handleIpc("termloop:task-preview-agent", (
  _event,
  taskId: string,
  agentId: string,
  model: string,
  permission: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max",
  kickoffMessage?: string,
) =>
  typedControlCall("task.previewAgent", {
    taskId,
    agentId,
    model,
    permission,
    reasoning,
    ...(kickoffMessage ? { kickoffMessage } : {}),
  }),
);
handleIpc("termloop:task-launch-agent", (_event, taskId: string, agentId: string, launchTicket: string) =>
  typedControlCall("task.launchAgent", { taskId, agentId, launchTicket }),
);
// Interactive desktop creation resolves the Project default into choices the
// user can see and edit, then provisions and launches those exact choices. The
// create command itself must stay Task-only so it cannot race that flow.
handleIpc("termloop:task-create", (_event, projectId: string, title: string, brief: string | null) =>
  controlCall("task.create", interactiveTaskCreateParams(projectId, title, brief)),
);
handleIpc("termloop:task-rename", (_event, taskId: string, title: string) =>
  controlCall("task.rename", { taskId, title }),
);
handleIpc("termloop:task-update-brief", (_event, taskId: string, brief: string | null) =>
  controlCall("task.updateBrief", { taskId, brief }),
);
handleIpc("termloop:task-close", (_event, taskId: string) =>
  controlCall("task.close", { taskId }),
);
handleIpc("termloop:task-finalize-closed-worktree-removal", (_event, taskId: string) =>
  controlCall("task.finalizeClosedWorktreeRemoval", { taskId }),
);
handleIpc("termloop:task-inspect-archive", (_event, taskId: string) =>
  controlCall("task.inspectArchive", { taskId }),
);
handleIpc("termloop:task-archive", (_event, taskId: string, archiveTicket: string) =>
  controlCall("task.archive", {
    taskId,
    archiveTicket,
    operationId: createArchiveOperationId(),
  }),
);
handleIpc("termloop:task-abandon-archive", (_event, taskId: string, operationId: string) =>
  controlCall("task.abandonArchive", { taskId, operationId }),
);
handleIpc("termloop:task-restore", (_event, taskId: string) =>
  controlCall("task.restore", { taskId }),
);
handleIpc("termloop:task-archived-context", (_event, taskId: string) =>
  controlCall("task.archivedContext", { taskId }),
);
handleIpc("termloop:task-reopen", (_event, taskId: string) =>
  controlCall("task.reopen", { taskId }),
);
handleIpc("termloop:task-delete", (_event, taskId: string) =>
  controlCall("task.delete", { taskId }),
);
handleIpc("termloop:task-delete-archived", (_event, taskId: string) =>
  controlCall("task.deleteArchived", { taskId }),
);
handleIpc("termloop:default-projects-root", async (event) => {
  requireMainRenderer(event);
  return controlCall("system.defaultProjectsRoot");
});
handleIpc("termloop:browse-directory", async (event, folderPath: string) => {
  requireMainRenderer(event);
  if (typeof folderPath !== "string") throw new Error("directoryBrowsePathInvalid");
  return controlCall("system.browseDirectory", { path: folderPath });
});
handleIpc("termloop:layout-load", () => clientLayoutStore().load());
handleIpc("termloop:layout-save", (_event, document: unknown) => {
  clientLayoutStore().stage(document);
});
handleIpc("termloop:session-list", () => controlCall("session.list"));
handleIpc("termloop:agent-status-list", () => controlCall("agent.statusList"));
handleIpc("termloop:agent-capability-list", () => controlCall("agent.capabilityList"));
handleIpc("termloop:steward-configuration-get", (_event, projectId: string) =>
  controlCall("steward.configurationGet", { projectId }),
);
handleIpc(
  "termloop:steward-configuration-set",
  (_event, params: import("@termloop/contract/current").StewardConfigurationSetParams) =>
    controlCall("steward.configurationSet", params),
);
handleIpc(
  "termloop:steward-configuration-delete",
  (_event, params: import("@termloop/contract/current").StewardConfigurationDeleteParams) =>
    controlCall("steward.configurationDelete", params),
);
handleIpc(
  "termloop:worker-configuration-list",
  (_event, params: import("@termloop/contract/current").WorkerConfigurationListParams) =>
    controlCall("worker.configurationList", params),
);
handleIpc(
  "termloop:worker-configuration-create",
  (_event, params: import("@termloop/contract/current").WorkerConfigurationCreateParams) =>
    controlCall("worker.configurationCreate", params),
);
handleIpc(
  "termloop:worker-configuration-update",
  (_event, params: import("@termloop/contract/current").WorkerConfigurationUpdateParams) =>
    controlCall("worker.configurationUpdate", params),
);
handleIpc(
  "termloop:worker-configuration-delete",
  (_event, params: import("@termloop/contract/current").WorkerConfigurationDeleteParams) =>
    controlCall("worker.configurationDelete", params),
);
handleIpc(
  "termloop:run-configuration-list",
  (_event, params: import("@termloop/contract/current").RunConfigurationListParams) =>
    controlCall("runConfiguration.list", params),
);
handleIpc(
  "termloop:run-configuration-create",
  (_event, params: import("@termloop/contract/current").RunConfigurationCreateParams) =>
    controlCall("runConfiguration.create", params),
);
handleIpc(
  "termloop:run-configuration-update",
  (_event, params: import("@termloop/contract/current").RunConfigurationUpdateParams) =>
    controlCall("runConfiguration.update", params),
);
handleIpc(
  "termloop:run-configuration-delete",
  (_event, params: import("@termloop/contract/current").RunConfigurationDeleteParams) =>
    controlCall("runConfiguration.delete", params),
);
handleIpc(
  "termloop:run-configuration-improve-preview",
  (_event, params: import("@termloop/contract/current").RunConfigurationImprovePreviewParams) =>
    controlCall("runConfiguration.improvePreview", params),
);
handleIpc(
  "termloop:run-configuration-improve-launch",
  (_event, params: import("@termloop/contract/current").RunConfigurationImproveLaunchParams) =>
    controlCall("runConfiguration.improveLaunch", params),
);
handleIpc(
  "termloop:settings-improve-preview",
  (_event, params: import("@termloop/contract/current").SettingsImprovePreviewParams) =>
    controlCall("settings.improvePreview", params),
);
handleIpc(
  "termloop:settings-improve-launch",
  (_event, params: import("@termloop/contract/current").SettingsImproveLaunchParams) =>
    controlCall("settings.improveLaunch", params),
);
handleIpc(
  "termloop:assistant-prompt-improve-preview",
  (_event, params: import("@termloop/contract/current").AssistantPromptImprovePreviewParams) =>
    controlCall("assistantPrompt.improvePreview", params),
);
handleIpc(
  "termloop:assistant-prompt-improve-launch",
  (_event, params: import("@termloop/contract/current").AssistantPromptImproveLaunchParams) =>
    controlCall("assistantPrompt.improveLaunch", params),
);
handleIpc(
  "termloop:configuration-version-list",
  (_event, params: import("@termloop/contract/current").ConfigurationVersionListParams) =>
    controlCall("configuration.versionList", params),
);
handleIpc(
  "termloop:configuration-version-restore",
  (_event, params: import("@termloop/contract/current").ConfigurationVersionRestoreParams) =>
    controlCall("configuration.versionRestore", params),
);
handleIpc(
  "termloop:run-runtime-list",
  (_event, params: import("@termloop/contract/current").RunRuntimeListParams) =>
    controlCall("run.runtimeList", params),
);
handleIpc(
  "termloop:routine-configuration-list",
  (_event, params: import("@termloop/contract/current").RoutineConfigurationListParams) =>
    controlCall("routine.configurationList", params),
);
handleIpc(
  "termloop:routine-configuration-create",
  (_event, params: import("@termloop/contract/current").RoutineConfigurationCreateParams) =>
    controlCall("routine.configurationCreate", params),
);
handleIpc(
  "termloop:routine-configuration-update",
  (_event, params: import("@termloop/contract/current").RoutineConfigurationUpdateParams) =>
    controlCall("routine.configurationUpdate", params),
);
handleIpc(
  "termloop:routine-context-update",
  (_event, params: import("@termloop/contract/current").RoutineContextUpdateParams) =>
    controlCall("routine.contextUpdate", params),
);
handleIpc(
  "termloop:routine-configuration-delete",
  (_event, params: import("@termloop/contract/current").RoutineConfigurationDeleteParams) =>
    controlCall("routine.configurationDelete", params),
);
handleIpc(
  "termloop:routine-runtime-list",
  (_event, params: import("@termloop/contract/current").RoutineRuntimeListParams) =>
    controlCall("routine.runtimeList", params),
);
handleIpc(
  "termloop:routine-run-now",
  (_event, params: import("@termloop/contract/current").RoutineRunNowParams) =>
    controlCall("routine.runNow", params),
);
handleIpc(
  "termloop:task-source-list",
  (_event, params: import("@termloop/contract/current").TaskSourceListParams) =>
    controlCall("taskSource.list", params),
);
handleIpc(
  "termloop:task-source-board-list",
  (_event, params: import("@termloop/contract/current").TaskSourceBoardListParams) =>
    controlCall("taskSource.boardList", params),
);
handleIpc(
  "termloop:task-source-board-list-stored",
  (_event, params: import("@termloop/contract/current").TaskSourceStoredBoardListParams) =>
    controlCall("taskSource.boardListStored", params),
);
handleIpc(
  "termloop:task-source-status-list",
  (_event, params: import("@termloop/contract/current").TaskSourceStatusListParams) =>
    controlCall("taskSource.statusList", params),
);
handleIpc(
  "termloop:task-source-status-list-stored",
  (_event, params: import("@termloop/contract/current").TaskSourceStoredStatusListParams) =>
    controlCall("taskSource.statusListStored", params),
);
handleIpc(
  "termloop:task-source-create",
  (_event, params: import("@termloop/contract/current").TaskSourceCreateParams) =>
    controlCall("taskSource.create", params),
);
handleIpc(
  "termloop:task-source-update",
  (_event, params: import("@termloop/contract/current").TaskSourceUpdateParams) =>
    controlCall("taskSource.update", params),
);
handleIpc(
  "termloop:task-source-credentials-set",
  (_event, params: import("@termloop/contract/current").TaskSourceCredentialsSetParams) =>
    controlCall("taskSource.credentialsSet", params),
);
handleIpc(
  "termloop:task-source-delete",
  (_event, params: import("@termloop/contract/current").TaskSourceDeleteParams) =>
    controlCall("taskSource.delete", params),
);
handleIpc(
  "termloop:task-source-refresh",
  (_event, params: import("@termloop/contract/current").TaskSourceRefreshParams) =>
    controlCall("taskSource.refresh", params),
);
handleIpc(
  "termloop:task-source-candidate-list",
  (_event, params: import("@termloop/contract/current").TaskSourceCandidateListParams) =>
    controlCall("taskSource.candidateList", params),
);
handleIpc(
  "termloop:task-source-candidate-import",
  (_event, params: import("@termloop/contract/current").TaskSourceCandidateImportParams) =>
    controlCall("taskSource.candidateImport", params),
);
handleIpc(
  "termloop:task-source-candidate-ignore",
  (_event, params: import("@termloop/contract/current").TaskSourceCandidateIgnoreParams) =>
    controlCall("taskSource.candidateIgnore", params),
);
handleIpc(
  "termloop:task-source-candidate-unignore",
  (_event, params: import("@termloop/contract/current").TaskSourceCandidateUnignoreParams) =>
    controlCall("taskSource.candidateUnignore", params),
);
handleIpc("termloop:playbook-get", (_event, projectId: string) =>
  controlCall("playbook.get", { projectId }),
);
handleIpc("termloop:playbook-runtime", (_event, projectId: string) =>
  controlCall("playbook.runtime", { projectId }),
);
handleIpc(
  "termloop:playbook-task-position-set",
  (_event, params: import("@termloop/contract/current").PlaybookTaskPositionSetParams) =>
    typedControlCall("playbook.taskPositionSet", params),
);
handleIpc(
  "termloop:playbook-update",
  (_event, params: import("@termloop/contract/current").PlaybookUpdateParams) =>
    typedControlCall("playbook.update", params),
);
handleIpc(
  "termloop:companion-transcript-list",
  (_event, params: import("@termloop/contract/current").CompanionTranscriptListParams) =>
    controlCall("companion.transcriptList", params),
);
handleIpc(
  "termloop:companion-transcript-append",
  (_event, params: import("@termloop/contract/current").CompanionTranscriptAppendParams) =>
    controlCall("companion.transcriptAppend", params),
);
handleIpc(
  "termloop:companion-proposal-respond",
  (_event, params: import("@termloop/contract/current").CompanionProposalRespondParams) =>
    controlCall("companion.proposalRespond", params),
);
handleIpc(
  "termloop:companion-suggestion-accept",
  (_event, params: import("@termloop/contract/current").CompanionSuggestionAcceptParams) =>
    controlCall("companion.suggestionAccept", params),
);
handleIpc(
  "termloop:companion-transcript-clear",
  (_event, params: import("@termloop/contract/current").CompanionTranscriptClearParams) =>
    controlCall("companion.transcriptClear", params),
);
handleIpc("termloop:agent-attention-notify", async (_event, sessionId: string) => {
  const profileId = currentConnectionProfileId();
  const notificationKey = connectionEntityKey(profileId, sessionId);
  const [sessions, statuses] = await Promise.all([
    controlCall("session.list"),
    controlCall("agent.statusList"),
  ]);
  const session = sessions.find((value) => value.id === sessionId);
  const status = statuses.find((value) => value.sessionId === sessionId);
  if (
    !session
    || session.kind !== "Agent"
    || session.lifecycle_state !== "running"
    || status?.status !== "awaitingInput"
    || !(status.source === "hook" || status.source === "appServer")
  ) {
    return { accepted: false };
  }
  if (!Notification.isSupported()) return { accepted: false };
  const profileName = (await connectionProfiles().list())
    .find((profile) => profile.id === profileId)?.name ?? "Computer";
  attentionNotifications.get(notificationKey)?.close();
  const notification = new Notification({
    title: `${session.process.agent_id === "codex" ? "Codex" : "Claude"} needs input`,
    body: `${profileName} · ${session.name?.trim() || session.process.cwd}`,
  });
  notification.on("click", () => {
    attentionNotifications.delete(notificationKey);
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send("termloop:agent-attention-activated", {
      profileId,
      sessionId: connectionEntityKey(profileId, sessionId),
    });
    notification.close();
  });
  notification.on("close", () => {
    if (attentionNotifications.get(notificationKey) === notification) {
      attentionNotifications.delete(notificationKey);
    }
  });
  attentionNotifications.set(notificationKey, notification);
  notification.show();
  return { accepted: true };
});
handleIpc("termloop:session-rename", (_event, sessionId: string, name: string | null) =>
  controlCall("session.rename", { sessionId, name }),
);
handleIpc("termloop:terminal-launch", async (_event, projectId: string) =>
  controlCall("session.launchTerminal", { projectId, cwd: await projectCwd(projectId) }),
);
const AGENT_ID_PATTERN = /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u;
function requireAgentId(agentId: string): string {
  if (agentId.length === 0 || agentId.length > 64 || !AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("agentUnsupported");
  }
  return agentId;
}
handleIpc(
  "termloop:agent-preview",
  async (_event, projectId: string, agentId: string, model?: string, permission?: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning?: "default" | "low" | "medium" | "high" | "xhigh" | "max") => {
    return controlCall("session.previewAgent", {
      projectId,
      cwd: await projectCwd(projectId),
      agentId: requireAgentId(agentId),
      ...(model && permission && reasoning ? { model, permission, reasoning } : {}),
    });
  },
);
handleIpc(
  "termloop:agent-launch",
  async (_event, projectId: string, agentId: string, launchTicket: string) => {
    return controlCall("session.launchAgent", {
      projectId,
      cwd: await projectCwd(projectId),
      agentId: requireAgentId(agentId),
      launchTicket,
    });
  },
);
const quickActionParams = async (
  projectId: string,
  agentId: string,
  model: string,
  permission: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max",
  prompt: string,
  attachmentIds: string[],
): Promise<QuickActionParams> => ({
  projectId,
  cwd: await projectCwd(projectId),
  agentId: requireAgentId(agentId),
  model,
  permission,
  reasoning,
  templateRef: "builtin.quick-action.free-prompt",
  bindings: { prompt },
  attachments: await quickActionImages().resolve(attachmentIds, currentConnectionProfileId()),
});
handleIpc(
  "termloop:quick-action-preview",
  async (_event, projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[]) =>
    controlCall("quickAction.preview", await quickActionParams(projectId, agentId, model, permission, reasoning, prompt, attachmentIds)),
);
handleIpc(
  "termloop:quick-action-launch",
  async (_event, projectId: string, agentId: string, model: string, permission: "default" | "acceptEdits" | "plan" | "bypassPermissions", reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max", prompt: string, attachmentIds: string[], launchTicket: string) => {
    const params: QuickActionLaunchParams = {
      ...await quickActionParams(projectId, agentId, model, permission, reasoning, prompt, attachmentIds),
      launchTicket,
    };
    const result = await controlCall("quickAction.launch", params);
    await quickActionImages().discardAfterLaunch(attachmentIds, currentConnectionProfileId());
    return result;
  },
);
handleIpc("termloop:session-terminate", (_event, sessionId: string) =>
  typedControlCall("session.terminate", { sessionId }),
);
handleIpc("termloop:session-preview-resume-agent", (_event, sessionId: string) =>
  controlCall("session.previewResumeAgent", { sessionId }),
);
handleIpc("termloop:session-resume-agent", (_event, sessionId: string, launchTicket: string) =>
  controlCall("session.resumeAgent", { sessionId, launchTicket }),
);
handleIpc("termloop:session-restart-agent", (_event, sessionId: string) =>
  typedControlCall("session.restartAgent", { sessionId }),
);
handleIpc("termloop:session-preview-relocate-agent", (_event, sessionId: string, taskId: string, mode: "resume" | "fresh") =>
  controlCall("session.previewRelocateAgentToTask", { sessionId, taskId, mode }),
);
handleIpc(
  "termloop:session-relocate-agent",
  (_event, sessionId: string, taskId: string, operationId: string, relocationTicket: string) =>
    controlCall("session.relocateAgentToTask", { sessionId, taskId, operationId, relocationTicket }),
);
handleIpc("termloop:session-preview-relocate-agent-to-project", (_event, sessionId: string, projectId: string) =>
  controlCall("session.previewRelocateAgentToProject", { sessionId, projectId }),
);
handleIpc(
  "termloop:session-relocate-agent-to-project",
  (_event, sessionId: string, projectId: string, operationId: string, relocationTicket: string) =>
    controlCall("session.relocateAgentToProject", { sessionId, projectId, operationId, relocationTicket }),
);
handleIpc("termloop:session-fork-agent", (_event, sessionId: string) =>
  typedControlCall("session.forkAgent", { sessionId }),
);
handleIpc("termloop:session-repair-provider-history", (_event, sessionId: string) =>
  typedControlCall("session.repairProviderHistory", {
    sessionId,
    acknowledgeHistoryRewrite: true,
  }),
);
handleIpc("termloop:session-history-list", (_event, projectId: string, force = false, fillCache = false) =>
  controlCall("session.historyList", { projectId, force, fillCache }),
);
handleIpc("termloop:session-history-preview", (_event, projectId: string, sessionId: string) =>
  controlCall("session.historyPreview", { projectId, sessionId }),
);
handleIpc("termloop:session-history-preview-resume-agent", (_event, projectId: string, historyHandle: string) =>
  controlCall("session.previewHistoryResumeAgent", { projectId, historyHandle }),
);
handleIpc("termloop:session-history-resume-agent", (_event, projectId: string, historyHandle: string, launchTicket: string) =>
  controlCall("session.resumeHistoryAgent", { projectId, historyHandle, launchTicket }),
);
handleIpc("termloop:session-request-ask-to", (_event, sessionId: string, targetAgentId: "claude" | "codex") =>
  typedControlCall("session.requestAskTo", { sessionId, targetAgentId }),
);
handleIpc("termloop:session-request-handover-to", (_event, sessionId: string, targetSessionId: string) =>
  typedControlCall("session.requestHandoverTo", { sessionId, targetSessionId }),
);
handleIpc("termloop:session-close", (_event, sessionId: string) =>
  controlCall("session.close", { sessionId }),
);
handleIpc("termloop:session-list-archived", (_event, projectId: string) =>
  controlCall("session.listArchived", { projectId }),
);
handleIpc("termloop:session-list-deleted", (_event, projectId: string) =>
  controlCall("session.listDeleted", { projectId }),
);
handleIpc("termloop:session-inspect-archive", (_event, sessionId: string) =>
  controlCall("session.inspectArchive", { sessionId }),
);
handleIpc("termloop:session-archive", (_event, sessionId: string, archiveTicket: string) =>
  controlCall("session.archive", {
    sessionId,
    archiveTicket,
    operationId: createArchiveOperationId(),
  }),
);
handleIpc("termloop:session-restore-archived", (_event, sessionId: string) =>
  controlCall("session.restoreArchived", { sessionId }),
);
handleIpc("termloop:session-delete-archived", (_event, sessionId: string) =>
  controlCall("session.deleteArchived", { sessionId }),
);
handleIpc("termloop:session-restore-deleted", (_event, sessionId: string) =>
  controlCall("session.restoreDeleted", { sessionId }),
);
handleIpc(
  "termloop:terminal-attach",
  async (event, requestId: string, sessionId: string, runtimeEpoch: number) => {
    if (!event.senderFrame) throw new Error("rendererFrameUnavailable");
    await gateways.attach(
      currentConnectionProfileId(),
      event.senderFrame,
      requestId,
      sessionId,
      runtimeEpoch,
    );
    return { accepted: true };
  },
);
handleIpc("termloop:connection-profile-list", async (event) => {
  requireMainRenderer(event);
  return connections.summaries();
});
handleIpc("termloop:connection-profile-reconnect", async (event, profileId: string) => {
  requireMainRenderer(event);
  await connections.reconnect(profileId);
  return connections.summaries();
});
handleIpc("termloop:connection-profile-connect", async (event, input: ConnectionProfileConnectInput) => {
  requireMainRenderer(event);
  const result = await connectionProfiles().connect(input);
  await connections.sync();
  return result;
});
handleIpc("termloop:connection-profile-set-enabled", async (event, profileId: string, enabled: boolean) => {
  requireMainRenderer(event);
  await connectionProfiles().setEnabled(profileId, enabled);
  await connections.sync();
  gateways.retain(new Set(await connections.enabledProfileIds()));
  if (!enabled) forwardManager.stopProfile(profileId);
  return connections.summaries();
});
handleIpc("termloop:connection-profile-remove", async (event, profileId: string) => {
  requireMainRenderer(event);
  await connectionProfiles().remove(profileId);
  await connections.sync();
  gateways.retain(new Set(await connections.enabledProfileIds()));
  forwardManager.stopProfile(profileId);
  return connections.summaries();
});
handleIpc("termloop:tailscale-server-discover", async (event) => {
  requireMainRenderer(event);
  return tailscaleDiscovery.discover();
});
handleIpc("termloop:remote-host-status", async (event) => {
  requireMainRenderer(event);
  return remoteHost.status();
});
handleIpc("termloop:remote-host-enable", async (event, transport: RemoteHostTransport) => {
  requireMainRenderer(event);
  if (transport !== "tailscale" && transport !== "ssh") throw new Error("Connection transport is invalid");
  return remoteHost.enable(transport);
});
handleIpc("termloop:remote-host-disable", async (event) => {
  requireMainRenderer(event);
  return remoteHost.disable();
});

if (ownsSingleInstance) app.whenReady().then(async () => {
  if (shouldRemoveApplicationMenu()) Menu.setApplicationMenu(null);
  else Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()));
  // Bundled desktop flavor: a packaged application that ships the daemon
  // binaries supervises its own daemon. Development, smoke, and client-only
  // flows (env override or unpackaged) never reach the spawn path, and a live
  // externally started daemon discovered through runtime.json is left alone.
  const bundledServerPath = bundledDaemonServerPath(process.resourcesPath);
  const bundledServerAvailable = app.isPackaged && await bundledDaemonServerExists(bundledServerPath);
  const daemonMode = bundledDaemonMode({
    isPackaged: app.isPackaged,
    envControlUrl: process.env.TERMLOOP_CONTROL_URL,
    bundledServerExists: bundledServerAvailable,
  });
  restartAgentsForLocalSubscription = shouldRestartAgentsForClientLaunch({ daemonMode, smokeRun });
  if (daemonMode === "manage") {
    daemonSupervisor = new BundledDaemonSupervisor({
      probeDaemonAlive,
      spawnDaemon: () => spawnBundledDaemon(bundledServerPath),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // Control-plane graceful shutdown for the managed child; the supervisor
      // only invokes this for a daemon it spawned, so clientOnly and external
      // daemons are never asked to shut down.
      requestDaemonShutdown: requestDiscoveredDaemonShutdown,
    });
    // Boots in the background; ControlSubscription and controlCall keep
    // retrying discovery until runtime.json answers.
    void daemonSupervisor.start();
  }
  applyUntaggedApplicationIcon(
    app,
    process.env.TERMLOOP_DEV_PROFILE_TAG,
    path.join(directory, "termloop-main-icon.png"),
  );
  const window = new BrowserWindow({
    title: applicationName,
    show: windowStartMode === "visible",
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#1e2325",
    // macOS-only hiddenInset; Windows/Linux keep the native frame so the OS
    // provides window controls.
    ...windowFrameOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(directory, "preload.cjs"),
    },
  });
  mainWindow = window;
  if (requestedTerminalRenderer() === "ghostty") {
    const addon = loadGhosttyHostAddon(app.getAppPath());
    if (addon) {
      ghosttySurfaces = new GhosttySurfaceManager(
        addon,
        window,
        path.join(directory, "ghostty-embedded.conf"),
      );
      effectiveTerminalRenderer = "ghostty";
    }
  }
  const nativeOverlayManager = effectiveTerminalRenderer === "ghostty"
    ? new NativeOverlayWindowManager(window, () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("termloop:native-overlay-closed");
      }
    }, cursorScreenPoint)
    : undefined;
  nativeOverlayWindow = nativeOverlayManager;
  window.webContents.setWindowOpenHandler((details) =>
    nativeOverlayManager?.handleWindowOpen(details) ?? { action: "deny" });
  window.webContents.on("did-create-window", (child, details) => nativeOverlayManager?.adopt(child, details));
  window.webContents.on("will-navigate", (event, target) => {
    if (target !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("closed", () => {
    ghosttySurfaces?.dispose();
    ghosttySurfaces = undefined;
    nativeOverlayManager?.dispose();
    if (nativeOverlayWindow === nativeOverlayManager) nativeOverlayWindow = undefined;
    effectiveTerminalRenderer = "xterm";
    if (mainWindow === window) mainWindow = undefined;
  });
  await window.loadFile(
    path.join(directory, "index.html"),
    process.env.TERMLOOP_DESKTOP_DIAGNOSTICS === "1" ? { query: { diagnostics: "1" } } : undefined,
  );
  window.setTitle(applicationName);
  if (windowStartMode === "minimized") {
    await minimizeWithoutFocus(window);
  }
  await publishDevelopmentReadyMarker(process.env.TERMLOOP_DEV_READY_FILE, process.pid);
  await connections.start();
  if (autoUpdateSupported(app.isPackaged)) {
    new UpdateManager({
      driver: createAutoUpdateDriver(),
      schedule: scheduleAutoUpdateTask,
      async confirmRestart(version) {
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        const decision = await dialog.showMessageBox(mainWindow, {
          type: "info",
          title: "TermLoop update ready",
          message: `TermLoop ${version} is ready to install.`,
          detail: "Running terminals and the managed local service will shut down gracefully before TermLoop restarts.",
          buttons: ["Restart and update", "Later"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return decision.response === 0;
      },
      async prepareForRestart() {
        await prepareForApplicationExit();
        readyToQuit = true;
      },
    }).start();
  }
  if (process.argv.includes("--smoke")) {
    const applicationUrl = window.webContents.getURL();
    if (effectiveTerminalRenderer === "ghostty") {
      for (let attempt = 0; attempt < 40 && BrowserWindow.getAllWindows().length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const initialWindowCount = BrowserWindow.getAllWindows().length;
    const expectedWindowCount = effectiveTerminalRenderer === "ghostty" ? 2 : 1;
    if (initialWindowCount !== expectedWindowCount) throw new Error("unexpected initial window count");
    await window.webContents.executeJavaScript(`window.open("https://github.com/evil/repo/pull/1")`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (BrowserWindow.getAllWindows().length !== initialWindowCount) throw new Error("new-window navigation was not denied");
    if (effectiveTerminalRenderer === "ghostty") {
      const manager = ghosttySurfaces;
      if (!manager) throw new Error("Ghostty surface manager was not created");
      const capturedSurface = manager.create();
      let capturedSnapshotDataUrl: string | undefined;
      try {
        // This surface exists only to prove that AppKit can yield a native
        // pixel snapshot. Keep it outside the content view while Ghostty
        // renders it: an in-window test surface can otherwise be caught by a
        // concurrent visual smoke capture as "GHOSTTY-PIXEL-SNAPSHOT".
        manager.setFrame(capturedSurface.surfaceId, -320, -180, 320, 180);
        manager.setVisible(capturedSurface.surfaceId, true);
        await manager.write(capturedSurface.surfaceId, new TextEncoder().encode("\u001b[31mGHOSTTY-PIXEL-SNAPSHOT\u001b[0m"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Overlay transitions must capture the still-visible AppKit frame and
        // hide it as one ordered operation. Reversing this order produces the
        // blank terminal seen behind context menus and Quick Action.
        const png = manager.snapshotAndHidePng(capturedSurface.surfaceId);
        const snapshot = png ? nativeImage.createFromBuffer(png) : undefined;
        if (!png || !snapshot || snapshot.isEmpty() || snapshot.getSize().width <= 0 || snapshot.getSize().height <= 0) {
          throw new Error("Ghostty AppKit pixel snapshot was not captured");
        }
        capturedSnapshotDataUrl = `data:image/png;base64,${png.toString("base64")}`;
      } finally {
        manager.destroy(capturedSurface.surfaceId);
      }
      const overlay = BrowserWindow.getAllWindows().find((candidate) => candidate !== window);
      if (!overlay) throw new Error("native overlay window was not created");
      const overlaySecurity = await overlay.webContents.executeJavaScript(`({
        processType: typeof globalThis.process,
        requireType: typeof globalThis.require,
        apiType: typeof globalThis.termloop
      })`);
      if (overlaySecurity.processType !== "undefined" || overlaySecurity.requireType !== "undefined" || overlaySecurity.apiType !== "undefined") {
        throw new Error("native overlay renderer privilege leak");
      }
      let portalReady = { root: false, styled: false };
      for (let attempt = 0; attempt < 40 && (!portalReady.root || !portalReady.styled); attempt += 1) {
        portalReady = await overlay.webContents.executeJavaScript(`({
          root: document.querySelector("#native-overlay-root") !== null,
          styled: document.styleSheets.length > 0
        })`);
        if (!portalReady.root || !portalReady.styled) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!portalReady.root || !portalReady.styled) {
        throw new Error(`native overlay portal was not initialized: ${JSON.stringify(portalReady)}`);
      }
      await window.webContents.executeJavaScript(`(() => {
        const wrapper = document.createElement("div");
        wrapper.id = "native-overlay-smoke-terminal-wrapper";
        wrapper.style.position = "fixed";
        wrapper.style.left = "100px";
        wrapper.style.top = "100px";
        wrapper.style.width = "500px";
        wrapper.style.height = "300px";
        wrapper.style.boxSizing = "border-box";
        wrapper.style.padding = "40px 0 0 20px";
        const host = document.createElement("div");
        host.id = "native-overlay-smoke-terminal";
        host.className = "assistant-terminal-host";
        host.style.flex = "none";
        host.style.width = "320px";
        host.style.height = "180px";
        wrapper.append(host);
        document.body.append(wrapper);
        document.querySelector('[aria-label="Open command palette"]')?.click();
      })()`);
      for (let attempt = 0; attempt < 80 && !overlay.isVisible(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!overlay.isVisible()) throw new Error("native overlay portal did not become visible");
      const emptyMasks = await overlay.webContents.executeJavaScript(`document.querySelectorAll("#native-overlay-terminal-masks > div").length`);
      if (emptyMasks !== 0) throw new Error("native overlay rendered an empty terminal mask before a snapshot was ready");
      await window.webContents.executeJavaScript(`(() => {
        const host = document.querySelector("#native-overlay-smoke-terminal");
        if (!(host instanceof HTMLElement)) return;
        const snapshot = document.createElement("pre");
        snapshot.className = "terminal-native-snapshot";
        snapshot.textContent = "CURRENT-GHOSTTY-SNAPSHOT";
        host.append(snapshot);
      })()`);
      const mainSnapshotFrame = await window.webContents.executeJavaScript(`(() => {
        const snapshot = document.querySelector("#native-overlay-smoke-terminal > .terminal-native-snapshot");
        if (!(snapshot instanceof HTMLElement)) return undefined;
        const rect = snapshot.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`);
      if (!mainSnapshotFrame || mainSnapshotFrame.left !== 120 || mainSnapshotFrame.top !== 140 || mainSnapshotFrame.width !== 320 || mainSnapshotFrame.height !== 180) {
        throw new Error(`assistant terminal snapshot escaped its host: ${JSON.stringify(mainSnapshotFrame)}`);
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const copied = await overlay.webContents.executeJavaScript(`document.querySelector("#native-overlay-terminal-masks > div")?.textContent === "CURRENT-GHOSTTY-SNAPSHOT"`);
        if (copied) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const terminalMask = await overlay.webContents.executeJavaScript(`(() => {
        const mask = document.querySelector("#native-overlay-terminal-masks > div");
        if (!(mask instanceof HTMLElement)) return undefined;
        const rect = mask.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, background: getComputedStyle(mask).backgroundColor, text: mask.textContent };
      })()`);
      if (!terminalMask || terminalMask.left !== 120 || terminalMask.top !== 140 || terminalMask.width !== 320 || terminalMask.height !== 180 || terminalMask.background !== "rgb(40, 44, 52)" || terminalMask.text !== "CURRENT-GHOSTTY-SNAPSHOT") {
        throw new Error(`native terminal mask was not rendered: ${JSON.stringify(terminalMask)}`);
      }
      await window.webContents.executeJavaScript(`(() => {
        const host = document.querySelector("#native-overlay-smoke-terminal");
        if (!(host instanceof HTMLElement)) return;
        host.replaceChildren();
        const snapshot = document.createElement("img");
        snapshot.className = "terminal-native-snapshot terminal-native-snapshot-image";
        snapshot.src = ${JSON.stringify(capturedSnapshotDataUrl)};
        host.append(snapshot);
      })()`);
      let imageLoaded = false;
      for (let attempt = 0; attempt < 40 && !imageLoaded; attempt += 1) {
        imageLoaded = await overlay.webContents.executeJavaScript(`(() => {
          const image = document.querySelector("#native-overlay-terminal-masks img");
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        })()`);
        if (!imageLoaded) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!imageLoaded) throw new Error("Ghostty snapshot data URL did not load in the native overlay renderer");
      const closedFromPortal = await overlay.webContents.executeJavaScript(`(() => {
        const close = document.querySelector('[aria-label="Close command palette"]');
        if (!(close instanceof HTMLElement)) return false;
        close.click();
        return true;
      })()`);
      let portalContentClosed = false;
      for (let attempt = 0; attempt < 40 && !portalContentClosed; attempt += 1) {
        portalContentClosed = await overlay.webContents.executeJavaScript(`document.querySelector('[aria-label="Close command palette"]') === null`);
        if (!portalContentClosed) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!closedFromPortal || !portalContentClosed) throw new Error("native overlay portal interaction failed");
      await window.webContents.executeJavaScript(`(() => {
        const shift = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: "ShiftLeft", key: "Shift", shiftKey: true, bubbles: true }));
        shift("keydown");
        shift("keyup");
        shift("keydown");
        shift("keyup");
      })()`);
      let quickActionReady = false;
      for (let attempt = 0; attempt < 40 && !quickActionReady; attempt += 1) {
        quickActionReady = await overlay.webContents.executeJavaScript(`(() => {
          const image = document.querySelector("#native-overlay-terminal-masks img");
          return document.querySelector(".quick-action") !== null
            && image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        })()`);
        if (!quickActionReady) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!quickActionReady) {
        const overlayState = await overlay.webContents.executeJavaScript(`(() => {
          const image = document.querySelector("#native-overlay-terminal-masks img");
          return {
            quickAction: document.querySelector(".quick-action") !== null,
            commandPalette: document.querySelector('[aria-label="Close command palette"]') !== null,
            maskCount: document.querySelectorAll("#native-overlay-terminal-masks > div").length,
            imagePresent: image instanceof HTMLImageElement,
            imageComplete: image instanceof HTMLImageElement && image.complete,
            imageNaturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          };
        })()`);
        const mainState = await window.webContents.executeJavaScript(`(() => {
          const host = document.querySelector("#native-overlay-smoke-terminal");
          const snapshot = host?.querySelector(":scope > .terminal-native-snapshot");
          const rect = host instanceof HTMLElement ? host.getBoundingClientRect() : undefined;
          return {
            hostPresent: host instanceof HTMLElement,
            hostWidth: rect?.width ?? 0,
            hostHeight: rect?.height ?? 0,
            snapshotTag: snapshot?.tagName ?? null,
            imageComplete: snapshot instanceof HTMLImageElement && snapshot.complete,
            imageNaturalWidth: snapshot instanceof HTMLImageElement ? snapshot.naturalWidth : 0,
          };
        })()`);
        throw new Error(`Quick Action did not preserve the Ghostty snapshot behind its native overlay: ${JSON.stringify({ overlayState, mainState })}`);
      }
      const quickActionClosed = await overlay.webContents.executeJavaScript(`(() => {
        const backdrop = document.querySelector('[aria-label="Dismiss Quick Action"]');
        if (!(backdrop instanceof HTMLElement)) return false;
        backdrop.click();
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!quickActionClosed || await overlay.webContents.executeJavaScript(`document.querySelector(".quick-action") !== null`)) {
        throw new Error("Quick Action native overlay interaction failed");
      }
      await window.webContents.executeJavaScript(`document.querySelector("#native-overlay-smoke-terminal-wrapper")?.remove()`);
      const overlayManager = nativeOverlayWindow;
      if (!overlayManager) throw new Error("native overlay manager was not created");
      overlayManager.setPassiveVisible(false);
      overlayManager.setPointerInteractive(false);
      overlayManager.setVisible(false);
      if (overlay.isVisible()) throw new Error("native overlay window did not hide after passive content closed");
      overlayManager.setVisible(true);
      if (!overlay.isVisible()) throw new Error("native overlay window did not become visible");
      overlayManager.setVisible(false);
      if (overlay.isVisible()) throw new Error("native overlay window did not hide");
      const closedOverlayId = overlay.id;
      overlay.close();
      for (let attempt = 0; attempt < 120 && !BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.id !== closedOverlayId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!BrowserWindow.getAllWindows().some((candidate) => candidate !== window && candidate.id !== closedOverlayId)) {
        throw new Error("native overlay window did not recover after closing");
      }
    }
    await window.webContents.executeJavaScript(`location.href = "https://github.com/evil/repo/pull/1"`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (window.webContents.getURL() !== applicationUrl) throw new Error("top-level navigation was not denied");
    const security = await window.webContents.executeJavaScript(`({
      processType: typeof globalThis.process,
      requireType: typeof globalThis.require,
      apiKeys: Object.keys(globalThis.termloop ?? {}).sort(),
      credentialKeys: Object.keys(globalThis.termloop ?? {}).filter((key) => /token|credential|secret/i.test(key)),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '',
      shell: document.querySelector('[aria-label="Projects and sessions"]')?.getAttribute('aria-label') ?? ''
    })`);
    if (security.processType !== "undefined" || security.requireType !== "undefined") {
      throw new Error("renderer privilege leak");
    }
    if (security.apiKeys.includes("call") || security.credentialKeys.length > 0) {
      throw new Error("renderer capability leak");
    }
    if (!security.csp.includes("default-src 'self'") || !security.csp.includes("connect-src 'none'")) {
      throw new Error("CSP missing");
    }
    if (security.shell !== "Projects and sessions") throw new Error("desktop shell did not render");
    console.log("TERMLOOP_DESKTOP_SMOKE_READY");
    app.quit();
  }
});

function serializableControlError(error: unknown): {
  message: string;
  code?: string;
  details?: { blocker: "worktrees" };
} {
  const value = typeof error === "object" && error ? error as {
    message?: unknown;
    code?: unknown;
    details?: { blocker?: unknown };
  } : undefined;
  const blocker = value?.details?.blocker;
  const result: {
    message: string;
    code?: string;
    details?: { blocker: "worktrees" };
  } = { message: typeof value?.message === "string" ? value.message : String(error) };
  if (typeof value?.code === "string") result.code = value.code;
  if (blocker === "worktrees") result.details = { blocker };
  return result;
}

let readyToQuit = false;
let flushingBeforeQuit = false;
let applicationExitPromise: Promise<void> | undefined;

function disposeApplicationResources(): void {
  ghosttySurfaces?.dispose();
  ghosttySurfaces = undefined;
  gateways.stop();
  connections.stopAll();
  connectionProfiles().stop();
  forwardManager.stop();
  for (const notification of attentionNotifications.values()) notification.close();
  attentionNotifications.clear();
}

function prepareForApplicationExit(): Promise<void> {
  disposeApplicationResources();
  applicationExitPromise ??= Promise.allSettled([
    layoutStore?.flush() ?? Promise.resolve(),
    removeDevelopmentReadyMarker(process.env.TERMLOOP_DEV_READY_FILE),
    daemonSupervisor?.stop() ?? Promise.resolve(),
  ]).then(() => undefined);
  return applicationExitPromise;
}

app.on("before-quit", (event) => {
  disposeApplicationResources();
  if (readyToQuit) return;
  event.preventDefault();
  if (flushingBeforeQuit) return;
  flushingBeforeQuit = true;
  void prepareForApplicationExit().finally(() => {
    readyToQuit = true;
    app.quit();
  });
});
app.on("window-all-closed", () => app.quit());
