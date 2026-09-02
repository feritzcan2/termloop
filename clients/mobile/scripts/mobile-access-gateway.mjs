import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  createGatewayDiagnosticReporter,
  mobileDiagnosticContext,
} from "./mobile-access-diagnostics.mjs";
import {
  configureWebSocketHeartbeat,
  sweepWebSocketHeartbeats,
  trackWebSocketHeartbeat,
} from "./mobile-access-heartbeat.mjs";
import {
  enableTerminalInputAckFrame,
  terminalFrameMetadata,
  terminalInputReceipt,
} from "./mobile-access-input-receipt.mjs";
import { mobileUpdatePage } from "./mobile-access-update-page.mjs";
import {
  apnsPayload,
  attentionTransitions,
  isStewardOrWorkerSession,
  loadApnsProvider,
  macDesktopRecentlyActive,
  nextStatusMap,
  pendingStewardDecisionNotifications,
  retainCurrentAttention,
  sendApns,
  stewardTranscriptNotifications,
  upsertPushDevice,
  withNotificationPreview,
} from "./mobile-access-push.mjs";
import {
  WATCH_PATCH_ENTRY_LIMIT,
  parseWatchTarget,
  patchTextOf,
  validatePairCode,
  watchChatMessageOf,
  watchProjectWorktreeOf,
  watchSessionOf,
  watchTaskOf,
  watchTaskWorktreeOf,
} from "./mobile-access-watch.mjs";
import {
  sendTerminalInput,
  validWatchReply,
  WATCH_REPLY_MAX_CHARS,
} from "./mobile-access-terminal-input.mjs";
import { readTerminalNotificationPreview } from "./mobile-access-terminal-preview.mjs";
import {
  ensureTranscriber,
  transcribeAudioFile,
  validVoiceUpload,
  voiceContainerOf,
  voiceUploadLimitBytes,
} from "./mobile-access-transcribe.mjs";

const MOBILE_API_VERSION = 1;
const MOBILE_TRANSPORT_VERSION = 2;
const GATEWAY_IDENTITY = typeof __TERMLOOP_GATEWAY_IDENTITY__ === "undefined"
  ? Object.freeze({
    manifestVersion: 1,
    buildId: "source-development",
    releaseVersion: "2.0.0",
    channel: "development",
    sequence: 2,
    owner: "termloop.source",
    compatibility: {
      mobileTransport: { min: MOBILE_TRANSPORT_VERSION, max: MOBILE_TRANSPORT_VERSION },
      mobileApi: { min: MOBILE_API_VERSION, max: MOBILE_API_VERSION },
      configSchema: { min: 1, max: 2 },
    },
  })
  : __TERMLOOP_GATEWAY_IDENTITY__;
const GATEWAY_VERSION_HEADERS = Object.freeze({
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-termloop-gateway-build": GATEWAY_IDENTITY.buildId,
  "x-termloop-mobile-transport-min": String(GATEWAY_IDENTITY.compatibility.mobileTransport.min),
  "x-termloop-mobile-transport-max": String(GATEWAY_IDENTITY.compatibility.mobileTransport.max),
});
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;
const DOWNSTREAM_HEARTBEAT_MS = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const IMAGE_MEDIA_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
/// The daemon's own read-only scope. These reach upstream on the read-only
/// token, so the gateway cannot turn a phone into a writer by accident.
const MOBILE_CONTROL_METHODS = new Set([
  "system.version",
  "project.list",
  "session.list",
  "agent.statusList",
  "agent.capabilityList",
  "task.list",
  "steward.configurationGet",
]);
/// Methods outside the daemon's read-only scope that a paired phone may still
/// reach, each named individually and routed on the full token exactly as the
/// Watch chat paths already are. A phone already holds terminal-input authority
/// over every running Agent, so the boundary here is not "reads only" — it is
/// "this exact list": a Task's bounded worktree snapshot and patches, the delivery
/// pipeline it sits on, its position on it, one inspected Agent launch, and the
/// Steward conversation. Nothing else in the contract becomes reachable, and every
/// entry is still gated by core's own commands and safety gates on arrival. Session
/// lifecycle and coordination entries back the mobile long-press menu; they remain
/// exact methods rather than turning the owner credential into arbitrary forwarding.
const MOBILE_FULL_CONTROL_METHODS = new Set([
  // Worktree content reads are full-control in the daemon contract. Keeping
  // them named here gives the phone a bounded review surface without exposing
  // any broader Git or filesystem authority.
  "task.worktreeChangeList",
  "task.worktreeDiff",
  "task.worktreePreImage",
  "playbook.get",
  "playbook.runtime",
  "playbook.taskPositionSet",
  "routine.configurationList",
  "routine.runNow",
  "task.previewAgent",
  "task.launchAgent",
  "session.previewAgent",
  "session.launchAgent",
  "session.forkAgent",
  "session.repairProviderHistory",
  "session.requestAskTo",
  "session.requestHandoverTo",
  "session.restartAgent",
  "session.previewRelocateAgentToTask",
  "session.relocateAgentToTask",
  "session.previewRelocateAgentToProject",
  "session.relocateAgentToProject",
  "session.rename",
  "session.terminate",
  "session.close",
  "quickAction.preview",
  "quickAction.launch",
  "companion.transcriptList",
  "companion.transcriptAppend",
  "companion.suggestionAccept",
  "companion.proposalRespond",
]);
let controlRequestSequence = 0;
let downstreamConnectionSequence = 0;
const upstreamControlConnections = new Map();
const MAX_UPSTREAM_CONTROL_IN_FLIGHT = 128;

const configFile = process.argv[2];
if (!configFile) throw new Error("usage: mobile-access-gateway <config-file>");
const config = validateConfig(JSON.parse(await readFile(configFile, "utf8")));
await boundLog();
const diagnostics = createGatewayDiagnosticReporter((line) => process.stdout.write(`${line}\n`));
const sockets = new Set();
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

const server = http.createServer(async (request, response) => {
  if (request.url === "/.well-known/termloop-mobile-access") {
    response.writeHead(200, GATEWAY_VERSION_HEADERS);
    response.end(JSON.stringify(GATEWAY_IDENTITY));
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/mobile-update") {
    const page = mobileUpdatePage(request.url);
    response.writeHead(200, page.headers);
    response.end(page.body);
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200, GATEWAY_VERSION_HEADERS);
    response.end(JSON.stringify({ ready: true, ...GATEWAY_IDENTITY }));
    return;
  }
  if (request.method === "POST" && request.url === "/push/register") {
    await registerPushDevice(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/session/image") {
    await uploadSessionImage(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/steward/voice") {
    await mobileStewardVoiceSend(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/steward/transcribe") {
    await mobileStewardTranscribe(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/steward/speech") {
    await mobileStewardSpeech(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/pair") {
    await watchPair(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/credential") {
    watchCredential(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/worktrees") {
    await watchWorktrees(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/patches") {
    await watchPatches(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/status") {
    await watchStatus(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/tasks") {
    await watchTasks(request, response);
    return;
  }
  if (request.method === "GET" && safePathname(request.url) === "/watch/chat") {
    await watchChatList(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/chat") {
    await watchChatSend(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/steward-action") {
    await watchStewardAction(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/watch/voice") {
    await watchVoiceSend(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/speech") {
    await watchStewardSpeech(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/reply") {
    await watchReply(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/watch/reply-voice") {
    await watchVoiceReply(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/watch/transcribe") {
    await watchTranscribe(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/task-agent") {
    await watchTaskAgent(request, response);
    return;
  }
  if (request.method === "POST" && request.url === "/watch/project-agent") {
    await watchProjectAgent(request, response);
    return;
  }
  if (request.method === "POST" && safePathname(request.url) === "/watch/project-agent-voice") {
    await watchProjectAgentVoice(request, response);
    return;
  }
  response.writeHead(404).end();
});

server.on("upgrade", (request, socket, head) => {
  const pathname = safePathname(request.url);
  if (pathname !== "/control" && pathname !== "/terminal" && pathname !== "/mobile") {
    diagnostics.report("downstream", "upgrade_refused", { reason: "unsupportedPath" });
    unsupportedUpgrade(socket);
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (client) => {
    const connectionId = ++downstreamConnectionSequence;
    const channel = pathname === "/control" ? "control"
      : pathname === "/terminal" ? "terminal" : "mobile";
    const startedAtEpochMs = Date.now();
    sockets.add(client);
    trackWebSocketHeartbeat(client, { connectionId, channel }, {
      /// Existing unified clients did not advertise an application heartbeat.
      /// Keep probing them, but never treat a missing native Pong as proof that
      /// their React Native socket is dead.
      enforceTimeout: channel !== "mobile",
    });
    diagnostics.report("downstream", "accepted", { connectionId, channel });
    client.once("error", (error) => {
      diagnostics.report("downstream", "socket_error", {
        connectionId,
        channel,
        errorType: error?.name,
      });
    });
    client.once("close", (code, reason) => {
      sockets.delete(client);
      diagnostics.report("downstream", "closed", {
        connectionId,
        channel,
        closeCode: code,
        closeReasonBytes: reason?.byteLength,
        lifetimeMs: Date.now() - startedAtEpochMs,
      });
    });
    if (pathname === "/control") acceptControl(client, connectionId);
    else if (pathname === "/terminal") acceptTerminal(client, connectionId);
    else acceptMobile(client, connectionId);
  });
});

const heartbeatTimer = setInterval(() => {
  sweepWebSocketHeartbeats(sockets, ({ connectionId, channel }) => {
    diagnostics.report("downstream", "heartbeat_timeout", { connectionId, channel });
  });
}, DOWNSTREAM_HEARTBEAT_MS);
heartbeatTimer.unref();

server.listen(config.port, "127.0.0.1", () => {
  // A restart loop is otherwise indistinguishable from a silent gateway, so
  // record the one fact every diagnosis starts from. Never log credentials.
  diagnostics.report("gateway", "listening", { port: config.port });
});
server.on("error", (error) => {
  diagnostics.report("gateway", "server_error", { errorType: error?.name });
});
if (config.push !== undefined) startAttentionMonitor();
// Compile the wrist transcriber before the first request needs it: a cold
// compile costs ~20s, longer than the watch is willing to wait for a reply.
ensureTranscriber(path.dirname(configFile)).catch(() => {
  // The first transcription request will retry the build and surface failure.
});

// The supervisor holds this file open in append mode, so copying then truncating
// in place keeps its descriptor valid. Preserve one complete overflow generation:
// losing the exact interval that crossed the cap made the hardest incidents
// impossible to diagnose.
async function boundLog() {
  if (config.logFile === undefined) return false;
  try {
    if ((await stat(config.logFile)).size <= LOG_LIMIT_BYTES) return false;
    const overflowFile = `${config.logFile}.overflow`;
    await copyFile(config.logFile, overflowFile);
    await chmod(overflowFile, 0o600);
    await truncate(config.logFile, 0);
    return true;
  } catch { /* A missing or unreadable log must never stop mobile access. */ }
  return false;
}

setInterval(() => {
  void boundLog().then((truncated) => {
    if (truncated) diagnostics.report("gateway", "log_rotated", { limitBytes: LOG_LIMIT_BYTES });
  });
}, 60_000).unref();

async function registerPushDevice(request, response) {
  if (config.push === undefined) return json(response, 404, { registered: false });
  const authorization = request.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const authorized = constantTimeEqual(bearer, config.controlToken)
    || (config.watchToken !== undefined && constantTimeEqual(bearer, config.watchToken));
  if (!authorized) {
    return json(response, 401, { registered: false });
  }
  try {
    const body = JSON.parse(await readBody(request, 4096));
    const current = await readPushDevices();
    const next = upsertPushDevice(current, body);
    await writeFile(config.push.devicesFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(config.push.devicesFile, 0o600);
    return json(response, 200, { registered: true });
  } catch {
    return json(response, 400, { registered: false });
  }
}

/// Images are deliberately not terminal frames: the terminal plane remains raw
/// PTY bytes only. The owner-authenticated gateway stages the bytes in the
/// target Session's ignored runtime directory, then the phone sends that relative
/// path as ordinary user input to the already-running agent.
async function uploadSessionImage(request, response) {
  if (!ownerAuthorized(request)) return json(response, 401, { uploaded: false });
  const sessionId = new URL(request.url, "http://127.0.0.1").searchParams.get("sessionId") ?? "";
  if (!validSessionId(sessionId)) return json(response, 400, { uploaded: false });
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.toLowerCase() ?? "";
  const extension = IMAGE_MEDIA_TYPES.get(mediaType);
  if (extension === undefined) return json(response, 415, { uploaded: false });
  try {
    const bytes = await readBytes(request, MAX_IMAGE_BYTES);
    if (bytes.length === 0) return json(response, 400, { uploaded: false });
    const runtime = await currentRuntime();
    const sessions = await callCurrentControl(runtime, "session.list", {});
    const session = Array.isArray(sessions)
      ? sessions.find((candidate) => candidate?.id === sessionId)
      : undefined;
    if (session?.kind !== "Agent" || session.lifecycle_state !== "running"
      || typeof session?.process?.cwd !== "string") {
      return json(response, 409, { uploaded: false });
    }
    const directory = await attachmentDirectory(session.process.cwd);
    await pruneAttachments(directory);
    const fileName = `${randomUUID()}.${extension}`;
    const temporary = path.join(directory, `.${fileName}.uploading`);
    const destination = path.join(directory, fileName);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    return json(response, 201, {
      uploaded: true,
      attachmentPath: path.posix.join(".termloop-runtime", "mobile-attachments", fileName),
    });
  } catch {
    return json(response, 503, { uploaded: false });
  }
}

function ownerAuthorized(request) {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ")
    && constantTimeEqual(authorization.slice("Bearer ".length), config.controlToken);
}

function validSessionId(value) {
  return /^[A-Za-z0-9-]{1,128}$/.test(value);
}

async function attachmentDirectory(cwd) {
  const root = await realpath(cwd);
  const runtimeDirectory = path.join(root, ".termloop-runtime");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimeInfo = await lstat(runtimeDirectory);
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) throw new Error("invalid runtime directory");
  const directory = path.join(runtimeDirectory, "mobile-attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid attachment directory");
  return directory;
}

async function pruneAttachments(directory) {
  const before = Date.now() - IMAGE_RETENTION_MS;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const target = path.join(directory, entry.name);
    try {
      if ((await stat(target)).mtimeMs < before) await unlink(target);
    } catch { /* A concurrent upload may have completed its cleanup first. */ }
  }
}

const watchPairFile = path.join(path.dirname(configFile), "watch-pair.json");

async function watchPair(request, response) {
  if (config.watchToken === undefined) return json(response, 404, { paired: false });
  try {
    const body = JSON.parse(await readBody(request, 512));
    let stored;
    try {
      stored = JSON.parse(await readFile(watchPairFile, "utf8"));
    } catch {
      stored = undefined;
    }
    if (!validatePairCode(stored, body?.code)) return json(response, 401, { paired: false });
    await rm(watchPairFile, { force: true });
    return json(response, 200, { paired: true, token: config.watchToken });
  } catch {
    return json(response, 400, { paired: false });
  }
}

// A paired phone provisions its companion watch silently: the phone proves the
// full mobile credential and receives the watch-scoped token to forward over
// WatchConnectivity. The six-digit /watch/pair code remains the phone-less
// fallback for standalone watch installs.
function watchCredential(request, response) {
  if (config.watchToken === undefined) return json(response, 404, { paired: false });
  const authorization = request.headers.authorization ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!constantTimeEqual(bearer, config.controlToken)) return json(response, 401, { paired: false });
  return json(response, 200, { paired: true, token: config.watchToken });
}

function watchAuthorized(request) {
  const authorization = request.headers.authorization ?? "";
  return config.watchToken !== undefined
    && authorization.startsWith("Bearer ")
    && constantTimeEqual(authorization.slice("Bearer ".length), config.watchToken);
}

function controlCaller(runtime, token) {
  return (method, params) => callCurrentControl(runtime, method, params ?? {}, token);
}

// The daemon gates task.worktreeChangeList/Diff behind the full-control scope,
// so those two read methods use the discovery file's full token; every other
// facade call stays on the read-only credential like the rest of the gateway.
async function watchWorktrees(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const readOnly = controlCaller(runtime, runtime.readOnlyToken);
    const full = controlCaller(runtime, runtime.fullToken);
    const worktrees = [];
    for (const project of await readOnly("project.list", {})) {
      try {
        const changes = await full("project.worktreeChangeList", { projectId: project.id });
        if (changes.entries.length > 0) worktrees.push(watchProjectWorktreeOf(project, changes));
      } catch { /* Project checkout may be unavailable; keep the rest. */ }
      const page = await readOnly("task.list", { projectId: project.id, archiveScope: "active" });
      for (const task of page.items) {
        if (task.status !== "open" || !task.worktree) continue;
        try {
          const changes = await full("task.worktreeChangeList", { taskId: task.id });
          if (changes.entries.length > 0) worktrees.push(watchTaskWorktreeOf(task, changes));
        } catch { /* Worktree may be mid-provisioning; keep the rest. */ }
      }
    }
    return json(response, 200, { worktrees });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

async function watchPatches(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  const target = parseWatchTarget(new URL(request.url, "http://127.0.0.1").searchParams.get("wt"));
  if (!target) return json(response, 400, { error: "invalid worktree target" });
  try {
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const full = controlCaller(runtime, runtime.fullToken);
    const changes = target.scope === "task"
      ? await full("task.worktreeChangeList", { taskId: target.id })
      : await full("project.worktreeChangeList", { projectId: target.id });
    const observationId = changes.observation_id;
    const files = [];
    for (const entry of changes.entries.slice(0, WATCH_PATCH_ENTRY_LIMIT)) {
      let text;
      try {
        const diff = target.scope === "task"
          ? await full("task.worktreeDiff", { taskId: target.id, observationId, entryId: entry.entry_id })
          : await full("project.worktreeDiff", { projectId: target.id, observationId, entryId: entry.entry_id });
        text = patchTextOf(diff);
      } catch {
        text = "(diff unavailable)";
      }
      files.push({ path: entry.display_path, patch: text });
    }
    if (changes.entries.length > WATCH_PATCH_ENTRY_LIMIT) {
      files.push({ path: "…", patch: `(${changes.entries.length - WATCH_PATCH_ENTRY_LIMIT} more files not shown)` });
    }
    return json(response, 200, { files });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

async function watchStatus(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const runtime = await currentRuntime();
    const readOnly = controlCaller(runtime, runtime.readOnlyToken);
    const [projects, sessions, statuses] = await Promise.all([
      readOnly("project.list", {}),
      readOnly("session.list", {}),
      readOnly("agent.statusList", {}),
    ]);
    const statusesBySession = new Map(statuses.map((entry) => [entry.sessionId, entry.status]));
    const agents = sessions
      .filter((session) => session.kind === "Agent"
        && session.lifecycle_state === "running"
        && !isStewardOrWorkerSession(session))
      .map((session) => watchSessionOf(session, statusesBySession));
    return json(response, 200, {
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      sessions: agents,
    });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

async function watchTasks(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const runtime = await currentRuntime();
    const readOnly = controlCaller(runtime, runtime.readOnlyToken);
    const tasks = [];
    for (const project of await readOnly("project.list", {})) {
      const page = await readOnly("task.list", { projectId: project.id, archiveScope: "active" });
      for (const task of page.items) {
        if (task.status === "open") tasks.push(watchTaskOf(task, project.name));
      }
    }
    return json(response, 200, { tasks });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

async function watchChatList(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  const projectId = new URL(request.url, "http://127.0.0.1").searchParams.get("project") ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) return json(response, 400, { error: "invalid project" });
  try {
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const full = controlCaller(runtime, runtime.fullToken);
    const result = await full("companion.transcriptList", { projectId, limit: 30 });
    return json(response, 200, { messages: result.messages.map(watchChatMessageOf) });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

/// A watch chat message is an ordinary Companion transcript append: the
/// daemon's built-in chat wake brings the Steward up exactly as it does for
/// the desktop chat. The attention monitor watches every Project transcript,
/// so later Steward replies reach the Watch even when the request began on
/// another client or arrived after the watch app left the foreground.
async function watchChatSend(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const body = JSON.parse(await readBody(request, 64 * 1024));
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId) || content.length === 0 || content.length > 8192) {
      return json(response, 400, { error: "invalid chat message" });
    }
    const message = await appendStewardMessage(projectId, content);
    return json(response, 200, { message });
  } catch {
    return json(response, 503, { error: "TermLoop is unavailable" });
  }
}

async function appendStewardMessage(projectId, content, inputMode) {
  const runtime = await currentRuntime();
  if (runtime.fullToken === undefined) throw new Error("TermLoop is unavailable");
  const full = controlCaller(runtime, runtime.fullToken);
  const params = inputMode === undefined ? { projectId, content } : { projectId, inputMode, content };
  const result = await full("companion.transcriptAppend", params);
  return watchChatMessageOf(result.message);
}

async function watchStewardAction(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const body = JSON.parse(await readBody(request, 4096));
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    const action = typeof body?.action === "string" ? body.action : "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)
      || messageId.length === 0 || messageId.length > 256
      || !["approve", "decline", "accept"].includes(action)) {
      return json(response, 400, { error: "invalid steward action" });
    }
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const full = controlCaller(runtime, runtime.fullToken);
    const result = action === "accept"
      ? await full("companion.suggestionAccept", { projectId, suggestionMessageId: messageId })
      : await full("companion.proposalRespond", {
        projectId,
        proposalMessageId: messageId,
        decision: action,
      });
    return json(response, 200, { message: watchChatMessageOf(result.message) });
  } catch (cause) {
    const code = cause instanceof UpstreamControlError ? cause.controlError?.code : undefined;
    return json(response, code === "conflict" ? 409 : 503, {
      error: code === "conflict" ? "This Steward request is no longer pending" : "TermLoop is unavailable",
    });
  }
}

/// Wrist audio is sent through the daemon-owned OpenAI voice capability. The
/// gateway never sees the API key. If cloud transcription is not configured or
/// temporarily unavailable, the existing on-device Mac recognizer remains a
/// no-secret fallback.
async function watchVoiceSend(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  return stewardVoiceSend(request, response);
}

async function mobileStewardVoiceSend(request, response) {
  if (!ownerAuthorized(request)) return json(response, 401, {});
  return stewardVoiceSend(request, response);
}

async function mobileStewardTranscribe(request, response) {
  if (!ownerAuthorized(request)) return json(response, 401, {});
  const transcription = await transcribeStewardRequest(request);
  if (transcription.status !== 200) {
    return json(response, transcription.status, { error: transcription.error });
  }
  return json(response, 200, { transcript: transcription.text });
}

async function stewardVoiceSend(request, response) {
  const projectId = new URL(request.url, "http://127.0.0.1").searchParams.get("project") ?? "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) return json(response, 400, { error: "invalid project" });
  const transcription = await transcribeStewardRequest(request);
  if (transcription.status !== 200) {
    return json(response, transcription.status, { error: transcription.error });
  }
  try {
    const message = await appendStewardMessage(projectId, transcription.text.slice(0, 8192), "voice");
    return json(response, 200, { transcript: transcription.text, message });
  } catch {
    return json(response, 503, { error: "transcription unavailable" });
  }
}

async function transcribeStewardRequest(request) {
  let audio;
  try {
    audio = await readBinaryBody(request, voiceUploadLimitBytes);
  } catch {
    return { status: 413, error: "recording too large" };
  }
  if (!validVoiceUpload(request.headers["content-type"], audio.length)) {
    return { status: 400, error: "invalid recording" };
  }
  try {
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) throw new Error("TermLoop is unavailable");
    const text = await transcribeStewardAudio(runtime, audio, request.headers["content-type"]);
    if (text.length === 0) {
      return { status: 422, error: "no speech recognized" };
    }
    return { status: 200, text };
  } catch {
    // Keep the generic response. Provider and credential details stay private.
    return { status: 503, error: "transcription unavailable" };
  }
}

async function transcribeStewardAudio(runtime, audio, contentType) {
  let providerStatus = "unreachable";
  try {
    const provider = await daemonVoiceFetch(runtime, "/voice/transcriptions", {
      method: "POST",
      headers: { "content-type": contentType },
      body: audio,
    });
    providerStatus = String(provider.status);
    if (provider.ok) {
      const payload = await provider.json();
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (text.length > 0 && text.length <= 64 * 1024) {
        process.stdout.write(
          `${new Date().toISOString()} steward transcription provider=openai status=${provider.status} container=${voiceContainerOf(audio)} bytes=${audio.length}\n`,
        );
        return text;
      }
    }
  } catch {
    // The no-secret local recognizer below preserves the existing wrist path.
  }
  const runtimeDir = path.dirname(configFile);
  const audioFile = path.join(runtimeDir, `watch-voice-${randomUUID()}.m4a`);
  try {
    await writeFile(audioFile, audio, { mode: 0o600 });
    const transcription = await transcribeAudioFile(runtimeDir, audioFile);
    process.stdout.write(
      `${new Date().toISOString()} steward transcription provider=${transcription.onDevice ? "apple-on-device" : "apple-speech"} status=200 container=${voiceContainerOf(audio)} bytes=${audio.length}\n`,
    );
    return transcription.text;
  } catch (cause) {
    process.stdout.write(
      `${new Date().toISOString()} steward transcription failed provider=${providerStatus} container=${voiceContainerOf(audio)} bytes=${audio.length}\n`,
    );
    throw cause;
  } finally {
    await rm(audioFile, { force: true });
  }
}

async function watchStewardSpeech(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  return stewardSpeech(request, response);
}

async function mobileStewardSpeech(request, response) {
  if (!ownerAuthorized(request)) return json(response, 401, {});
  return stewardSpeech(request, response);
}

async function stewardSpeech(request, response) {
  try {
    const body = JSON.parse(await readBody(request, 4096));
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const sequence = Number(body?.sequence);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)
      || !Number.isSafeInteger(sequence) || sequence < 1) {
      return json(response, 400, { error: "invalid speech target" });
    }
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const full = controlCaller(runtime, runtime.fullToken);
    const transcript = await full("companion.transcriptList", { projectId, limit: 100 });
    const message = transcript.messages.find((entry) => entry.sequence === sequence && entry.author === "steward");
    if (message === undefined) return json(response, 404, { error: "Steward reply was not found" });
    const provider = await daemonVoiceFetch(runtime, "/voice/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message.content }),
    });
    if (!provider.ok) return json(response, 503, { error: "Steward voice is unavailable" });
    const audio = Buffer.from(await provider.arrayBuffer());
    if (audio.length === 0 || audio.length > 10 * 1024 * 1024) {
      return json(response, 503, { error: "Steward voice is unavailable" });
    }
    response.writeHead(200, {
      "content-type": "audio/mpeg",
      "content-length": audio.length,
      "cache-control": "no-store",
    });
    response.end(audio);
  } catch {
    return json(response, 503, { error: "Steward voice is unavailable" });
  }
}

function daemonVoiceFetch(runtime, pathname, options) {
  const endpoint = new URL(runtime.controlUrl);
  endpoint.protocol = "http:";
  endpoint.pathname = pathname;
  endpoint.search = "";
  endpoint.hash = "";
  return fetch(endpoint, {
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${runtime.fullToken}` },
    signal: AbortSignal.timeout(30_000),
  });
}

async function watchReply(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const body = JSON.parse(await readBody(request, 64 * 1024));
    if (!validWatchReply(body)) return json(response, 400, { error: "invalid reply" });
    const runtime = await currentRuntime();
    const delivered = await sendTerminalInput(WebSocket, runtime.terminalUrl, runtime.terminalToken, body);
    return json(response, delivered ? 200 : 503, { delivered });
  } catch {
    return json(response, 503, { delivered: false });
  }
}

async function watchVoiceReply(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  const url = new URL(request.url, "http://127.0.0.1");
  const sessionId = url.searchParams.get("session") ?? "";
  const runtimeEpoch = Number(url.searchParams.get("epoch"));
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)
    || !Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) {
    return json(response, 400, { error: "invalid reply target" });
  }
  const transcription = await transcribeWatchRequest(request);
  if (transcription.status !== 200) return json(response, transcription.status, { error: transcription.error });
  try {
    const runtime = await currentRuntime();
    const delivered = await sendTerminalInput(WebSocket, runtime.terminalUrl, runtime.terminalToken, {
      sessionId,
      runtimeEpoch,
      text: transcription.text,
    });
    // The transcript rides along so the watch can show what was (or was not)
    // delivered without a second transcription pass.
    return json(response, delivered ? 200 : 503, { delivered, transcript: transcription.text });
  } catch {
    return json(response, 503, { delivered: false });
  }
}

/// Transcribe-only: the watch shows the recognized text before anything is
/// sent, so the user reads exactly what a later launch or reply will deliver.
/// One content-free outcome line per request: transcription failures are
/// otherwise invisible from the wrist, and this is the only evidence of them.
async function watchTranscribe(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  const startedAt = Date.now();
  const transcription = await transcribeWatchRequest(request);
  process.stdout.write(`${new Date().toISOString()} watch transcribe status=${transcription.status} ms=${Date.now() - startedAt}\n`);
  if (transcription.status !== 200) return json(response, transcription.status, { error: transcription.error });
  return json(response, 200, { transcript: transcription.text });
}

async function transcribeWatchRequest(request) {
  let audio;
  try {
    audio = await readBinaryBody(request, voiceUploadLimitBytes);
  } catch {
    return { status: 413, error: "recording too large" };
  }
  if (!validVoiceUpload(request.headers["content-type"], audio.length)) {
    return { status: 400, error: "invalid recording" };
  }
  const runtimeDir = path.dirname(configFile);
  const audioFile = path.join(runtimeDir, `watch-voice-${randomUUID()}.m4a`);
  try {
    await writeFile(audioFile, audio, { mode: 0o600 });
    const { text } = await transcribeAudioFile(runtimeDir, audioFile);
    if (text.length === 0) {
      return { status: 422, error: "no speech recognized" };
    }
    return { status: 200, text };
  } catch {
    return { status: 503, error: "transcription unavailable" };
  } finally {
    await rm(audioFile, { force: true });
  }
}

/// Watch task launches follow the same inspected-manifest path as every other
/// TermLoop-controlled launch: preview resolves the invocation-owned manifest
/// and ticket, launch consumes that exact ticket.
async function watchTaskAgent(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const body = JSON.parse(await readBody(request, 4096));
    const taskId = typeof body?.taskId === "string" ? body.taskId : "";
    const agentId = body?.agentId === "codex" ? "codex" : "claude";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(taskId)) return json(response, 400, { error: "invalid task" });
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) return json(response, 503, { error: "TermLoop is unavailable" });
    const full = controlCaller(runtime, runtime.fullToken);
    const preview = await full("task.previewAgent", { taskId, agentId });
    const session = await full("task.launchAgent", { taskId, agentId, launchTicket: preview.launch_ticket });
    return json(response, 200, { sessionId: session.id, name: session.name });
  } catch {
    return json(response, 503, { error: "launch failed" });
  }
}

/// Project launches use the Project's current canonical folder from Core rather
/// than accepting a filesystem path from the watch. The resolved identity and
/// folder then travel through the same inspected preview ticket as every other
/// TermLoop-controlled launch.
async function watchProjectAgent(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  try {
    const body = JSON.parse(await readBody(request, 64 * 1024));
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const agentId = body?.agentId === "codex" ? "codex" : "claude";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) {
      return json(response, 400, { error: "invalid project" });
    }
    // Optional confirmed prompt text: the watch transcribes first so the user
    // sees the exact words, then this launch delivers those exact words.
    const prompt = body?.prompt;
    if (prompt !== undefined
      && (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > WATCH_REPLY_MAX_CHARS)) {
      return json(response, 400, { error: "invalid prompt" });
    }
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) {
      return json(response, 503, { error: "TermLoop is unavailable" });
    }
    const readOnly = controlCaller(runtime, runtime.readOnlyToken);
    const projects = await readOnly("project.list", {});
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined || typeof project.folder_path !== "string" || project.folder_path.length === 0) {
      return json(response, 404, { error: "project not found" });
    }
    const full = controlCaller(runtime, runtime.fullToken);
    const launchTarget = { projectId, cwd: project.folder_path, agentId };
    const session = prompt === undefined
      ? await launchProjectAgent(full, launchTarget)
      : await launchPromptedProjectAgent(full, launchTarget, prompt);
    const result = {
      sessionId: session.id,
      name: session.name,
      runtimeEpoch: session.runtime_epoch,
    };
    if (prompt !== undefined) {
      // Backward-compatible Watch response: launch acceptance now means Core
      // owns the immutable prompt and its observable delivery lifecycle. The
      // gateway must not race provider readiness with raw terminal frames.
      result.promptDelivered = true;
    }
    return json(response, 200, result);
  } catch {
    return json(response, 503, { error: "launch failed" });
  }
}

async function watchProjectAgentVoice(request, response) {
  if (!watchAuthorized(request)) return json(response, 401, {});
  const url = new URL(request.url, "http://127.0.0.1");
  const projectId = url.searchParams.get("project") ?? "";
  const agentId = url.searchParams.get("agent") === "codex" ? "codex" : "claude";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) {
    return json(response, 400, { error: "invalid project" });
  }
  const transcription = await transcribeWatchRequest(request);
  if (transcription.status !== 200) return json(response, transcription.status, { error: transcription.error });
  try {
    const runtime = await currentRuntime();
    if (runtime.fullToken === undefined) {
      return json(response, 503, { error: "TermLoop is unavailable" });
    }
    const readOnly = controlCaller(runtime, runtime.readOnlyToken);
    const projects = await readOnly("project.list", {});
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined || typeof project.folder_path !== "string" || project.folder_path.length === 0) {
      return json(response, 404, { error: "project not found" });
    }
    const full = controlCaller(runtime, runtime.fullToken);
    const launchTarget = { projectId, cwd: project.folder_path, agentId };
    const session = await launchPromptedProjectAgent(full, launchTarget, transcription.text);
    // The transcript shows the user the exact invocation-owned words. Core now
    // owns readiness, paste settlement, and submit confirmation for this launch.
    return json(response, 200, {
      sessionId: session.id,
      name: session.name,
      runtimeEpoch: session.runtime_epoch,
      promptDelivered: true,
      transcript: transcription.text,
    });
  } catch {
    return json(response, 503, { error: "launch failed" });
  }
}

async function launchProjectAgent(full, launchTarget) {
  const preview = await full("session.previewAgent", launchTarget);
  return full("session.launchAgent", {
    ...launchTarget,
    launchTicket: preview.launch_ticket,
  });
}

async function launchPromptedProjectAgent(full, launchTarget, prompt) {
  const params = {
    ...launchTarget,
    model: "default",
    permission: "default",
    reasoning: "default",
    templateRef: "builtin.quick-action.free-prompt",
    bindings: { prompt },
    attachments: [],
  };
  const preview = await full("quickAction.preview", params);
  return full("quickAction.launch", { ...params, launchTicket: preview.launch_ticket });
}

function startAttentionMonitor() {
  let polling = false;
  let initialized = false;
  let previous = new Map();
  let pending = new Map();
  let stewardSequences = new Map();
  // Per-device APNs acceptance is retained only while its exact decision is
  // pending. A Watch registering after the proposal was created still receives
  // it, without repeatedly alerting devices that already accepted the push.
  let deliveredStewardDecisions = new Map();
  let lastStewardPollAt = 0;

  const pollSteward = async (runtime) => {
    if (Date.now() - lastStewardPollAt < 5_000 || runtime.fullToken === undefined) return;
    const projects = await callCurrentControl(runtime, "project.list", {});
    const full = controlCaller(runtime, runtime.fullToken);
    const messagesByProject = new Map();
    await Promise.all(projects.map(async (project) => {
      try {
        const transcript = await full("companion.transcriptList", { projectId: project.id, limit: 100 });
        messagesByProject.set(project.id, transcript.messages);
      } catch {
        // One unavailable Project must not suppress Steward decisions from
        // every other Project. Its cursor stays unchanged and retries.
      }
    }));
    const stewardChanges = stewardTranscriptNotifications(stewardSequences, projects, messagesByProject);
    stewardSequences = stewardChanges.nextSequences;
    const pendingDecisions = pendingStewardDecisionNotifications(projects, messagesByProject);
    const pendingDecisionIds = new Set(pendingDecisions.map(({ stewardMessageId }) => stewardMessageId));
    deliveredStewardDecisions = new Map(
      [...deliveredStewardDecisions].filter(([messageId]) => pendingDecisionIds.has(messageId)),
    );
    // Steward is the user's wrist control plane. Unlike terminal attention,
    // these notifications are never suppressed while the Mac is active.
    const notifications = new Map();
    for (const notification of stewardChanges.notifications) {
      notifications.set(notification.stewardMessageId ?? `${notification.sessionId}:${notification.kind}`, notification);
    }
    for (const notification of pendingDecisions) {
      notifications.set(notification.stewardMessageId, notification);
    }
    for (const notification of notifications.values()) {
      if (pendingDecisionIds.has(notification.stewardMessageId)) {
        const deliveredDevices = deliveredStewardDecisions.get(notification.stewardMessageId) ?? new Set();
        const acceptedDevices = await deliverPush(notification, deliveredDevices);
        deliveredStewardDecisions.set(
          notification.stewardMessageId,
          new Set([...deliveredDevices, ...acceptedDevices]),
        );
      } else {
        await deliverPush(notification);
      }
    }
    lastStewardPollAt = Date.now();
  };

  const pollAgentAttention = async (runtime) => {
    const [sessions, statuses] = await Promise.all([
      callCurrentControl(runtime, "session.list", {}),
      callCurrentControl(runtime, "agent.statusList", {}),
    ]);
    if (!Array.isArray(sessions) || !Array.isArray(statuses)) {
      throw new Error("mobile attention projections are unavailable");
    }
    if (initialized) {
      for (const notification of attentionTransitions(previous, statuses, sessions)) {
        pending.set(notification.sessionId, notification);
      }
      pending = retainCurrentAttention(pending, statuses);
      if (!(await desktopRecentlyActive())) {
        for (const notification of pending.values()) {
          const preview = await readTerminalNotificationPreview(runtime, notification);
          await deliverPush(withNotificationPreview(notification, preview));
        }
        pending.clear();
      }
    }
    previous = nextStatusMap(statuses);
    initialized = true;
  };

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const runtime = await currentRuntime();
      // Keep the two channels fail-independent. A broken terminal projection,
      // preview, or desktop-presence check cannot delay a Steward decision.
      try { await pollSteward(runtime); } catch { /* Retry on the next bounded poll. */ }
      try { await pollAgentAttention(runtime); } catch { /* Retry on the next bounded poll. */ }
    } catch {
      // The daemon or network may be restarting. The next bounded poll retries.
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = setInterval(poll, 2_000);
  timer.unref();
}

function desktopRecentlyActive() {
  if (config.hostPlatform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/ioreg",
      ["-r", "-c", "IOHIDSystem", "-d", "1"],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error === null && macDesktopRecentlyActive(stdout)),
    );
  });
}

async function deliverPush(notification, skipDeviceTokens = new Set()) {
  let provider;
  try { provider = await loadApnsProvider(config.push.apnsConfigFile); } catch { return new Set(); }
  const current = await readPushDevices();
  const devices = current.devices ?? [];
  const retained = [];
  const accepted = new Set();
  for (const device of devices) {
    if (skipDeviceTokens.has(device.deviceToken)) {
      retained.push(device);
      continue;
    }
    const result = await sendApns(provider, device, apnsPayload(notification, config.push.connectionId));
    if (result.ok) accepted.add(device.deviceToken);
    if (!["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason)) {
      retained.push(device);
    }
  }
  if (retained.length !== devices.length) {
    await writeFile(config.push.devicesFile, `${JSON.stringify({ version: 1, devices: retained }, null, 2)}\n`, { mode: 0o600 });
    await chmod(config.push.devicesFile, 0o600);
  }
  return accepted;
}

async function readPushDevices() {
  try {
    const value = JSON.parse(await readFile(config.push.devicesFile, "utf8"));
    return value?.version === 1 && Array.isArray(value.devices) ? value : { version: 1, devices: [] };
  } catch {
    return { version: 1, devices: [] };
  }
}

async function acceptControl(client, connectionId) {
  const first = await firstMessage(client, connectionId, "control");
  if (first === undefined || first.isBinary) {
    diagnostics.report("control", "authentication_refused", {
      connectionId,
      reason: first === undefined ? "missingFirstMessage" : "binaryFirstMessage",
    });
    return refuse(client, "invalid control request");
  }
  let request;
  try {
    request = JSON.parse(first.data.toString("utf8"));
  } catch {
    diagnostics.report("control", "authentication_refused", {
      connectionId,
      reason: "invalidJson",
    });
    return refuse(client, "invalid control request");
  }
  if (!constantTimeEqual(request?.token, config.controlToken)) {
    diagnostics.report("control", "authentication_refused", {
      connectionId,
      reason: "invalidCredential",
    });
    return refuse(client, "invalid credential");
  }

  if (Object.hasOwn(request, "mobileApiVersion")) {
    const correlation = mobileDiagnosticContext(request);
    diagnostics.report("control", "mobile_authenticated", {
      connectionId,
      ...correlation,
    });
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        diagnostics.report("control", "request_refused", {
          connectionId,
          reason: "binaryMessage",
          ...correlation,
        });
        return mobileControlResponse(client, "invalid", false, undefined, {
          code: "invalidMessage",
          message: "Mobile control requests must be JSON text.",
        });
      }
      let next;
      try { next = JSON.parse(data.toString("utf8")); } catch {
        diagnostics.report("control", "request_refused", {
          connectionId,
          reason: "invalidJson",
          ...correlation,
        });
        return mobileControlResponse(client, "invalid", false, undefined, {
          code: "invalidMessage",
          message: "Mobile control request is invalid.",
        });
      }
      if (!constantTimeEqual(next?.token, config.controlToken)) {
        diagnostics.report("control", "request_refused", {
          connectionId,
          reason: "invalidCredential",
          ...mobileDiagnosticContext(next),
        });
        return mobileControlResponse(client, typeof next?.id === "string" ? next.id : "invalid", false, undefined, {
          code: "unauthenticated",
          message: "Mobile control credential is invalid.",
        });
      }
      void acceptMobileControl(client, next, connectionId);
    });
    void acceptMobileControl(client, request, connectionId);
    return;
  }

  diagnostics.report("control", "legacy_authenticated", { connectionId });

  let runtime;
  try {
    runtime = await currentRuntime();
  } catch {
    diagnostics.report("control", "runtime_unavailable", { connectionId, clientKind: "legacy" });
    return unavailable(client);
  }
  const clientProtocolVersion = request.protocolVersion;
  request.token = runtime.readOnlyToken;
  request.protocolVersion = runtime.protocolVersion;
  const upstream = new WebSocket(runtime.controlUrl, { maxPayload: 4 * 1024 * 1024 });
  bridge(
    client,
    upstream,
    () => upstream.send(JSON.stringify(request)),
    (data, isBinary) => legacyControlResponse(data, isBinary, request.method, clientProtocolVersion),
    { connectionId, channel: "control", clientKind: "legacy" },
  );
}

async function acceptMobileControl(client, request, connectionId) {
  const startedAtEpochMs = Date.now();
  const correlation = mobileDiagnosticContext(request);
  const id = typeof request.id === "string" && request.id.length > 0 && request.id.length <= 128
    ? request.id
    : undefined;
  const readOnlyMethod = MOBILE_CONTROL_METHODS.has(request.method);
  const fullMethod = MOBILE_FULL_CONTROL_METHODS.has(request.method);
  if (id === undefined || request.mobileApiVersion !== MOBILE_API_VERSION
    || !(readOnlyMethod || fullMethod)
    || !isRecord(request.params)) {
    diagnostics.report("control", "request_refused", {
      connectionId,
      requestId: id,
      reason: request.mobileApiVersion === MOBILE_API_VERSION ? "invalidMethodOrParams" : "unsupportedMobileApi",
      ...correlation,
    });
    return mobileControlResponse(client, id ?? "invalid", false, undefined, {
      code: request.mobileApiVersion === MOBILE_API_VERSION ? "methodNotFound" : "unsupportedMobileApi",
      message: request.mobileApiVersion === MOBILE_API_VERSION
        ? "This method is not available to TermLoop Mobile."
        : "This TermLoop Mobile API version is not supported.",
    });
  }
  diagnostics.report("control", "request_started", {
    connectionId,
    requestId: id,
    method: request.method,
    authority: fullMethod ? "full" : "readOnly",
    ...correlation,
  });
  try {
    const runtime = await currentRuntime();
    // A discovery file without the full credential keeps every read working and
    // refuses only the named full-token methods, the same way the Watch reads do.
    if (fullMethod && runtime.fullToken === undefined) {
      diagnostics.report("control", "request_completed", {
        connectionId,
        requestId: id,
        method: request.method,
        ok: false,
        errorCode: "unauthenticated",
        durationMs: Date.now() - startedAtEpochMs,
        delivered: client.readyState === WebSocket.OPEN,
        ...correlation,
      });
      return mobileControlResponse(client, id, false, undefined, {
        code: "unauthenticated",
        message: "This Mac did not publish a credential for this action.",
      });
    }
    const result = await callCurrentControl(
      runtime,
      request.method,
      request.params,
      fullMethod ? runtime.fullToken : runtime.readOnlyToken,
      {
        downstreamConnectionId: connectionId,
        downstreamRequestId: id,
        ...correlation,
      },
    );
    diagnostics.report("control", "request_completed", {
      connectionId,
      requestId: id,
      method: request.method,
      ok: true,
      durationMs: Date.now() - startedAtEpochMs,
      delivered: client.readyState === WebSocket.OPEN,
      ...correlation,
    });
    return mobileControlResponse(client, id, true, result);
  } catch (cause) {
    const error = cause instanceof UpstreamControlError
      ? cause.controlError
      : { code: "operationFailed", message: "TermLoop is restarting. Try again shortly." };
    diagnostics.report("control", "request_completed", {
      connectionId,
      requestId: id,
      method: request.method,
      ok: false,
      errorCode: error.code,
      reason: typeof error.details?.reason === "string" ? error.details.reason : undefined,
      causeType: cause instanceof Error ? cause.name : typeof cause,
      durationMs: Date.now() - startedAtEpochMs,
      delivered: client.readyState === WebSocket.OPEN,
      ...correlation,
    });
    return mobileControlResponse(client, id, false, undefined, error);
  }
}

async function acceptTerminal(client, connectionId) {
  const first = await firstMessage(client, connectionId, "terminal");
  if (first === undefined || !first.isBinary) {
    diagnostics.report("terminal", "authentication_refused", {
      connectionId,
      reason: first === undefined ? "missingFirstMessage" : "textFirstMessage",
    });
    return refuse(client, "invalid terminal authentication");
  }
  const expected = Buffer.concat([Buffer.from("TL01"), Buffer.from(config.terminalToken)]);
  if (!constantTimeBufferEqual(first.data, expected)) {
    diagnostics.report("terminal", "authentication_refused", {
      connectionId,
      reason: "invalidCredential",
      authenticationBytes: first.data.byteLength,
    });
    return refuse(client, "invalid credential");
  }
  diagnostics.report("terminal", "mobile_authenticated", { connectionId });

  let runtime;
  try {
    runtime = await currentRuntime();
  } catch {
    diagnostics.report("terminal", "runtime_unavailable", { connectionId });
    return unavailable(client);
  }
  const upstream = new WebSocket(runtime.terminalUrl, { maxPayload: 4 * 1024 * 1024 });
  bridge(client, upstream, () => {
    upstream.send(Buffer.concat([Buffer.from("TL01"), Buffer.from(runtime.terminalToken)]));
  }, undefined, { connectionId, channel: "terminal", clientKind: "mobile" });
}

/// Unified phone transport. Authentication proves both authorities before the
/// socket becomes usable: the read/control credential alone can never become a
/// terminal-input credential. Control remains JSON text and every PTY byte stays
/// in the existing TL01 binary data plane, so multiplexing does not smuggle
/// terminal content through JSON or duplicate the daemon protocol.
async function acceptMobile(client, connectionId) {
  const first = await firstMessage(client, connectionId, "mobile");
  if (first === undefined || first.isBinary) {
    diagnostics.report("mobile", "authentication_refused", {
      connectionId,
      reason: first === undefined ? "missingFirstMessage" : "binaryFirstMessage",
    });
    return refuse(client, "invalid mobile authentication");
  }
  let authentication;
  try { authentication = JSON.parse(first.data.toString("utf8")); } catch {
    diagnostics.report("mobile", "authentication_refused", { connectionId, reason: "invalidJson" });
    return refuse(client, "invalid mobile authentication");
  }
  if (authentication?.type !== "mobile.authenticate"
    || authentication.mobileTransportVersion !== MOBILE_TRANSPORT_VERSION) {
    diagnostics.report("mobile", "authentication_refused", {
      connectionId,
      reason: "unsupportedTransport",
      ...mobileDiagnosticContext(authentication),
    });
    const version = Number(authentication?.mobileTransportVersion);
    const reason = Number.isFinite(version) && version < MOBILE_TRANSPORT_VERSION
      ? "mobile transport too old"
      : "mobile transport too new";
    return incompatible(client, reason);
  }
  if (!constantTimeEqual(authentication.controlToken, config.controlToken)
    || !constantTimeEqual(authentication.terminalToken, config.terminalToken)) {
    diagnostics.report("mobile", "authentication_refused", {
      connectionId,
      reason: "invalidCredential",
      ...mobileDiagnosticContext(authentication),
    });
    return refuse(client, "invalid credential");
  }
  if (authentication.mobileHeartbeatVersion === 1) {
    configureWebSocketHeartbeat(client, {
      enforceTimeout: true,
      probe: () => {
        if (client.readyState !== WebSocket.OPEN) throw new Error("mobile socket is not open");
        client.send(JSON.stringify({ event: "mobile.ping" }));
      },
    });
  }

  let runtime;
  try { runtime = await currentRuntime(); } catch {
    diagnostics.report("mobile", "runtime_unavailable", { connectionId });
    return unavailable(client);
  }
  const daemonInputAck = authentication.terminalInputAckVersion === 1
    && runtime.terminalInputAckVersion === 1;
  const gatewayInputReceipt = !daemonInputAck
    && authentication.mobileInputReceiptVersion === 1;
  const startedAtEpochMs = Date.now();
  const upstream = new WebSocket(runtime.terminalUrl, { maxPayload: 4 * 1024 * 1024 });
  let terminalReady = false;
  let subscription;
  const timeout = setTimeout(() => {
    if (terminalReady) return;
    diagnostics.report("mobile", "authentication_timeout", {
      connectionId,
      durationMs: Date.now() - startedAtEpochMs,
    });
    upstream.terminate();
    unavailable(client);
  }, 5_000);
  timeout.unref();

  upstream.once("open", () => {
    upstream.send(Buffer.concat([Buffer.from("TL01"), Buffer.from(runtime.terminalToken)]));
  });
  upstream.on("message", (data, isBinary) => {
    if (!terminalReady) {
      if (data.toString("utf8") !== "TLOK") {
        clearTimeout(timeout);
        diagnostics.report("mobile", "upstream_authentication_refused", { connectionId });
        upstream.terminate();
        return refuse(client, "upstream credential refused");
      }
      terminalReady = true;
      clearTimeout(timeout);
      diagnostics.report("mobile", "authenticated", {
        connectionId,
        durationMs: Date.now() - startedAtEpochMs,
        ...mobileDiagnosticContext(authentication),
      });
      if (daemonInputAck) upstream.send(enableTerminalInputAckFrame(), { binary: true });
      client.send(JSON.stringify({
        event: "mobile.ready",
        mobileTransportVersion: MOBILE_TRANSPORT_VERSION,
        ...(daemonInputAck ? { terminalInputAckVersion: 1 } : {}),
        ...(gatewayInputReceipt
          ? { mobileInputReceiptVersion: 1 } : {}),
      }));
      subscription = subscribeMobileInvalidations(runtime, client, connectionId);
      client.on("message", (nextData, nextIsBinary) => {
        if (nextIsBinary) {
          const frameBytes = rawBuffer(nextData);
          const metadata = terminalFrameMetadata(frameBytes);
          if (upstream.readyState !== WebSocket.OPEN) {
            diagnostics.report("mobile", "terminal_frame_refused", {
              connectionId,
              reason: "upstreamUnavailable",
              ...terminalDiagnosticContext(metadata),
            });
            unavailable(client);
            return;
          }
          const receipt = daemonInputAck || gatewayInputReceipt
            ? terminalInputReceipt(frameBytes) : undefined;
          try {
            upstream.send(nextData, { binary: true }, (error) => {
              if (error != null) {
                diagnostics.report("mobile", "terminal_frame_refused", {
                  connectionId,
                  reason: "upstreamSendFailed",
                  ...terminalDiagnosticContext(metadata),
                });
                upstream.terminate();
                unavailable(client);
                return;
              }
              if (client.readyState !== WebSocket.OPEN) return;
              if (gatewayInputReceipt) {
                client.send(JSON.stringify({
                  event: "mobile.inputAccepted",
                  mobileInputReceiptVersion: 1,
                  sessionId: receipt.sessionId,
                  runtimeEpoch: receipt.runtimeEpoch,
                  frameSequence: receipt.frameSequence,
                }));
              }
              if (metadata !== undefined) diagnostics.report("mobile", receipt !== undefined
                ? daemonInputAck ? "terminal_input_forwarded" : "terminal_input_accepted"
                : "terminal_frame_forwarded", {
                connectionId,
                ...terminalDiagnosticContext(metadata),
              });
            });
          } catch {
            diagnostics.report("mobile", "terminal_frame_refused", {
              connectionId,
              reason: "upstreamSendThrew",
              ...terminalDiagnosticContext(metadata),
            });
            upstream.terminate();
            unavailable(client);
          }
          return;
        }
        let request;
        try { request = JSON.parse(nextData.toString("utf8")); } catch {
          diagnostics.report("mobile", "request_refused", { connectionId, reason: "invalidJson" });
          return mobileControlResponse(client, "invalid", false, undefined, {
            code: "invalidMessage",
            message: "Mobile control request is invalid.",
          });
        }
        if (request?.type === "mobile.pong") return;
        if (!constantTimeEqual(request?.token, config.controlToken)) {
          diagnostics.report("mobile", "request_refused", {
            connectionId,
            reason: "invalidCredential",
            ...mobileDiagnosticContext(request),
          });
          return mobileControlResponse(
            client,
            typeof request?.id === "string" ? request.id : "invalid",
            false,
            undefined,
            { code: "unauthenticated", message: "Mobile control credential is invalid." },
          );
        }
        void acceptMobileControl(client, request, connectionId);
      });
      return;
    }
    if (isBinary) {
      const metadata = terminalFrameMetadata(rawBuffer(data));
      if (metadata !== undefined && [4, 5, 11, 12, 14, 16].includes(metadata.frameKind)) {
        diagnostics.report("mobile", "terminal_frame_received", {
          connectionId,
          ...terminalDiagnosticContext(metadata),
        });
      }
    }
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.once("error", (error) => {
    clearTimeout(timeout);
    diagnostics.report("mobile", "upstream_error", {
      connectionId,
      terminalReady,
      errorType: error?.name,
    });
    upstream.terminate();
    unavailable(client);
  });
  upstream.once("close", (code, reason) => {
    clearTimeout(timeout);
    subscription?.close();
    diagnostics.report("mobile", "upstream_closed", {
      connectionId,
      terminalReady,
      closeCode: code,
      closeReasonBytes: reason?.byteLength,
      lifetimeMs: Date.now() - startedAtEpochMs,
    });
    if (client.readyState === WebSocket.OPEN) client.close(safeCloseCode(code), "upstream closed");
  });
  client.once("close", () => {
    subscription?.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
  });
}

function subscribeMobileInvalidations(runtime, client, connectionId) {
  let socket;
  let stopped = false;
  let retry;
  let delayMs = 500;
  let generation = 0;
  const connect = () => {
    if (stopped || client.readyState !== WebSocket.OPEN) return;
    const currentGeneration = ++generation;
    socket = new WebSocket(runtime.controlUrl, { maxPayload: 1024 * 1024 });
    const requestId = `mobile-subscription-${connectionId}-${currentGeneration}`;
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: requestId,
        protocolVersion: runtime.protocolVersion,
        token: runtime.readOnlyToken,
        method: "control.subscribe",
        params: {
          topics: ["project", "task", "session", "agentStatus", "companion", "steward", "worker", "routine", "keepAwake"],
        },
      }));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || stopped || currentGeneration !== generation) return;
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { return socket.close(1002, "invalid control event"); }
      if (message?.id === requestId && message.ok === true) {
        delayMs = 500;
        diagnostics.report("mobile", "invalidation_subscription_ready", { connectionId });
        return;
      }
      if (message?.event !== "projection.invalidated" || !isRecord(message.payload)) return;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ event: "projection.invalidated", payload: message.payload }));
      }
    });
    socket.once("error", () => socket.terminate());
    socket.once("close", () => {
      if (stopped || currentGeneration !== generation || client.readyState !== WebSocket.OPEN) return;
      const waitMs = delayMs;
      delayMs = Math.min(30_000, delayMs * 2);
      diagnostics.report("mobile", "invalidation_subscription_retry", { connectionId, delayMs: waitMs });
      retry = setTimeout(connect, waitMs);
      retry.unref();
    });
  };
  connect();
  return {
    close() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      if (retry !== undefined) clearTimeout(retry);
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    },
  };
}

function bridge(client, upstream, onOpen, transformDownstream, context) {
  let opened = false;
  const startedAtEpochMs = Date.now();
  let downstreamMessages = 0;
  let downstreamBytes = 0;
  let upstreamMessages = 0;
  let upstreamBytes = 0;
  diagnostics.report("upstream", "connection_started", context);
  upstream.once("open", () => {
    opened = true;
    diagnostics.report("upstream", "connection_opened", {
      ...context,
      durationMs: Date.now() - startedAtEpochMs,
    });
    onOpen();
    client.on("message", (data, isBinary) => {
      downstreamMessages += 1;
      downstreamBytes += rawBuffer(data).byteLength;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
  });
  upstream.on("message", (data, isBinary) => {
    upstreamMessages += 1;
    upstreamBytes += rawBuffer(data).byteLength;
    if (client.readyState !== WebSocket.OPEN) return;
    const next = transformDownstream?.(data, isBinary) ?? { data, isBinary };
    client.send(next.data, { binary: next.isBinary });
  });
  upstream.once("error", (error) => {
    diagnostics.report("upstream", "socket_error", {
      ...context,
      opened,
      errorType: error?.name,
      durationMs: Date.now() - startedAtEpochMs,
    });
    upstream.terminate();
    unavailable(client);
  });
  upstream.once("close", (code, reason) => {
    diagnostics.report("upstream", "connection_closed", {
      ...context,
      opened,
      closeCode: code,
      closeReasonBytes: reason?.byteLength,
      lifetimeMs: Date.now() - startedAtEpochMs,
      downstreamMessages,
      downstreamBytes,
      upstreamMessages,
      upstreamBytes,
    });
    if (client.readyState === WebSocket.OPEN) client.close(safeCloseCode(code), "upstream closed");
  });
  client.once("close", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      // This legacy raw bridge owns a dedicated upstream connection. Once the
      // downstream closes no response has a consumer, so release it immediately.
      diagnostics.report("upstream", "terminated_after_downstream_close", {
        ...context,
        opened,
        lifetimeMs: Date.now() - startedAtEpochMs,
      });
      upstream.terminate();
    }
  });
  setTimeout(() => {
    if (!opened && upstream.readyState === WebSocket.CONNECTING) {
      diagnostics.report("upstream", "connection_timeout", {
        ...context,
        durationMs: Date.now() - startedAtEpochMs,
      });
      upstream.terminate();
      unavailable(client);
    }
  }, 5_000).unref();
}

function callCurrentControl(runtime, method, params, token = runtime.readOnlyToken, trace = {}) {
  const role = constantTimeEqual(token, runtime.readOnlyToken) ? "readOnly" : "full";
  let connection = upstreamControlConnections.get(role);
  if (connection === undefined || !connection.matches(runtime, token)) {
    connection?.close();
    connection = new CurrentControlConnection(runtime, token, role);
    upstreamControlConnections.set(role, connection);
  }
  return connection.call(method, params, trace);
}

class CurrentControlConnection {
  #socket;
  #connecting;
  #generation = 0;
  #pending = new Map();

  constructor(runtime, token, role) {
    this.runtime = runtime;
    this.token = token;
    this.role = role;
  }

  matches(runtime, token) {
    return this.runtime.controlUrl === runtime.controlUrl
      && this.runtime.protocolVersion === runtime.protocolVersion
      && constantTimeEqual(this.token, token);
  }

  call(method, params, trace) {
    if (this.#pending.size >= MAX_UPSTREAM_CONTROL_IN_FLIGHT) {
      diagnostics.report("upstreamControl", "request_refused", {
        role: this.role,
        method,
        reason: "inFlightLimit",
        pendingRequests: this.#pending.size,
        ...trace,
      });
      return Promise.reject(new UpstreamControlError({
        code: "serviceBusy",
        message: "Too many gateway control requests are in flight.",
      }));
    }
    const id = `mobile-gateway-${++controlRequestSequence}`;
    const startedAtEpochMs = Date.now();
    const downstreamRequest = trace?.downstreamConnectionId !== undefined;
    if (downstreamRequest) {
      diagnostics.report("upstreamControl", "request_started", {
        role: this.role,
        requestId: id,
        method,
        pendingRequests: this.#pending.size + 1,
        generation: this.#generation,
        ...trace,
      });
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        diagnostics.report("upstreamControl", "request_timeout", {
          role: this.role,
          requestId: id,
          method,
          durationMs: Date.now() - startedAtEpochMs,
          pendingRequests: this.#pending.size,
          generation: this.#generation,
          ...trace,
        });
        this.#cancel(id);
        const stalled = this.#socket === undefined ? this.#connecting?.socket : undefined;
        if (stalled !== undefined) {
          this.#disconnect(this.#generation, new Error("control connection timed out"));
          stalled.terminate();
        }
        reject(new Error("control request timed out"));
      }, 5_000);
      timeout.unref();
      this.#pending.set(id, { resolve, reject, timeout, method, startedAtEpochMs, trace });
      Promise.resolve().then(() => this.#connected()).then((socket) => {
        if (!this.#pending.has(id)) return;
        try {
          socket.send(JSON.stringify({
            id,
            protocolVersion: this.runtime.protocolVersion,
            token: this.token,
            method,
            params,
          }));
          if (downstreamRequest) {
            diagnostics.report("upstreamControl", "request_sent", {
              role: this.role,
              requestId: id,
              method,
              generation: this.#generation,
              ...trace,
            });
          }
        } catch (cause) {
          diagnostics.report("upstreamControl", "request_send_failed", {
            role: this.role,
            requestId: id,
            method,
            generation: this.#generation,
            causeType: cause instanceof Error ? cause.name : typeof cause,
            ...trace,
          });
          socket.terminate();
          this.#disconnect(this.#generation, new Error("control connection failed"));
        }
      }).catch((cause) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        diagnostics.report("upstreamControl", "request_connection_failed", {
          role: this.role,
          requestId: id,
          method,
          durationMs: Date.now() - startedAtEpochMs,
          causeType: cause instanceof Error ? cause.name : typeof cause,
          ...trace,
        });
        pending.reject(new Error("control connection failed"));
      });
    });
  }

  close() {
    const socket = this.#socket ?? this.#connecting?.socket;
    diagnostics.report("upstreamControl", "client_closed", {
      role: this.role,
      generation: this.#generation,
      pendingRequests: this.#pending.size,
      transportState: this.#socket !== undefined ? "connected"
        : this.#connecting !== undefined ? "connecting" : "disconnected",
    });
    this.#generation += 1;
    this.#socket = undefined;
    this.#connecting = undefined;
    this.#rejectPending(new Error("control connection closed"));
    socket?.terminate();
  }

  #connected() {
    if (this.#socket !== undefined) return Promise.resolve(this.#socket);
    if (this.#connecting !== undefined) return this.#connecting.promise;
    const generation = ++this.#generation;
    const startedAtEpochMs = Date.now();
    diagnostics.report("upstreamControl", "connection_started", {
      role: this.role,
      generation,
      pendingRequests: this.#pending.size,
    });
    const socket = new WebSocket(this.runtime.controlUrl, { maxPayload: 4 * 1024 * 1024 });
    const promise = new Promise((resolve, reject) => {
      let opened = false;
      socket.once("open", () => {
        if (generation !== this.#generation) {
          diagnostics.report("upstreamControl", "connection_superseded", {
            role: this.role,
            generation,
            currentGeneration: this.#generation,
            durationMs: Date.now() - startedAtEpochMs,
          });
          socket.terminate();
          reject(new Error("control connection superseded"));
          return;
        }
        opened = true;
        this.#socket = socket;
        this.#connecting = undefined;
        diagnostics.report("upstreamControl", "connection_opened", {
          role: this.role,
          generation,
          durationMs: Date.now() - startedAtEpochMs,
          pendingRequests: this.#pending.size,
        });
        resolve(socket);
      });
      socket.on("message", (data, isBinary) => this.#receive(generation, data, isBinary));
      socket.once("error", (error) => {
        diagnostics.report("upstreamControl", "connection_error", {
          role: this.role,
          generation,
          opened,
          stale: generation !== this.#generation,
          durationMs: Date.now() - startedAtEpochMs,
          errorType: error?.name,
        });
        if (!opened) reject(new Error("control connection failed"));
        this.#disconnect(generation, new Error("control connection failed"));
        socket.terminate();
      });
      socket.once("close", (code, reason) => {
        diagnostics.report("upstreamControl", "connection_closed", {
          role: this.role,
          generation,
          opened,
          stale: generation !== this.#generation,
          durationMs: Date.now() - startedAtEpochMs,
          closeCode: code,
          closeReasonBytes: reason?.byteLength,
        });
        if (!opened) reject(new Error("control connection closed"));
        this.#disconnect(generation, new Error("control connection closed"));
      });
    });
    this.#connecting = { promise, socket };
    return promise;
  }

  #receive(generation, data, isBinary) {
    if (generation !== this.#generation) {
      diagnostics.report("upstreamControl", "stale_response_ignored", {
        role: this.role,
        generation,
        currentGeneration: this.#generation,
      });
      return;
    }
    if (isBinary) {
      diagnostics.report("upstreamControl", "invalid_response", {
        role: this.role,
        generation,
        reason: "binaryMessage",
      });
      const socket = this.#socket;
      this.#disconnect(generation, new Error("binary control response"));
      socket?.terminate();
      return;
    }
    let response;
    try { response = JSON.parse(data.toString("utf8")); } catch {
      diagnostics.report("upstreamControl", "invalid_response", {
        role: this.role,
        generation,
        reason: "invalidJson",
      });
      const socket = this.#socket;
      this.#disconnect(generation, new Error("invalid control response"));
      socket?.terminate();
      return;
    }
    if (!isRecord(response)) {
      diagnostics.report("upstreamControl", "invalid_response", {
        role: this.role,
        generation,
        reason: "notObject",
      });
      const socket = this.#socket;
      this.#disconnect(generation, new Error("invalid control response"));
      socket?.terminate();
      return;
    }
    if (typeof response.id !== "string") {
      diagnostics.report("upstreamControl", "invalid_response", {
        role: this.role,
        generation,
        reason: "missingRequestId",
      });
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      diagnostics.report("upstreamControl", "orphan_response_ignored", {
        role: this.role,
        generation,
        requestId: response.id,
      });
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.ok === true) {
      if (pending.trace?.downstreamConnectionId !== undefined) {
        diagnostics.report("upstreamControl", "request_completed", {
          role: this.role,
          requestId: response.id,
          method: pending.method,
          ok: true,
          durationMs: Date.now() - pending.startedAtEpochMs,
          pendingRequests: this.#pending.size,
          ...pending.trace,
        });
      }
      pending.resolve(response.result);
      return;
    }
    const error = isRecord(response.error)
      ? {
        code: typeof response.error.code === "string" ? response.error.code : "operationFailed",
        message: typeof response.error.message === "string"
          ? response.error.message
          : "TermLoop could not complete the request.",
        ...(isRecord(response.error.details) ? { details: response.error.details } : {}),
      }
      : { code: "operationFailed", message: "TermLoop could not complete the request." };
    diagnostics.report("upstreamControl", "request_completed", {
      role: this.role,
      requestId: response.id,
      method: pending.method,
      ok: false,
      errorCode: error.code,
      reason: typeof error.details?.reason === "string" ? error.details.reason : undefined,
      durationMs: Date.now() - pending.startedAtEpochMs,
      pendingRequests: this.#pending.size,
      ...pending.trace,
    });
    pending.reject(new UpstreamControlError(error));
  }

  #cancel(requestId) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.#socket.send(JSON.stringify({
        id: `mobile-gateway-cancel-${++controlRequestSequence}`,
        protocolVersion: this.runtime.protocolVersion,
        token: this.token,
        method: "control.cancel",
        params: { requestId },
      }));
    } catch {
      const socket = this.#socket;
      this.#disconnect(this.#generation, new Error("control connection failed"));
      socket?.terminate();
    }
  }

  #disconnect(generation, error) {
    if (generation !== this.#generation) return;
    diagnostics.report("upstreamControl", "transport_disconnected", {
      role: this.role,
      generation,
      reason: error.message,
      pendingRequests: this.#pending.size,
    });
    this.#generation += 1;
    this.#socket = undefined;
    this.#connecting = undefined;
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      diagnostics.report("upstreamControl", "request_interrupted", {
        role: this.role,
        method: request.method,
        reason: error.message,
        durationMs: Date.now() - request.startedAtEpochMs,
        ...request.trace,
      });
      request.reject(error);
    }
  }
}

class UpstreamControlError extends Error {
  constructor(controlError) {
    super(controlError.message);
    this.controlError = controlError;
  }
}

function mobileControlResponse(client, id, ok, result, error) {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify(ok ? { id, ok: true, result } : { id, ok: false, error }));
}

function legacyControlResponse(data, isBinary, method, clientProtocolVersion) {
  if (isBinary || method !== "system.version" || typeof clientProtocolVersion !== "string") {
    return { data, isBinary };
  }
  try {
    const response = JSON.parse(data.toString("utf8"));
    if (response?.ok === true && isRecord(response.result)) {
      response.result.protocolVersion = clientProtocolVersion;
      return { data: Buffer.from(JSON.stringify(response)), isBinary: false };
    }
  } catch { /* Forward the daemon response unchanged. */ }
  return { data, isBinary };
}

async function currentRuntime() {
  const value = JSON.parse(await readFile(config.runtimeFile, "utf8"));
  const control = endpoint(value.controlUrl, "/control");
  const terminal = endpoint(value.terminalUrl, "/terminal");
  if (control.port !== terminal.port) throw new Error("runtime endpoints differ");
  return {
    controlUrl: control.href,
    terminalUrl: terminal.href,
    protocolVersion: requiredString(value.protocolVersion),
    readOnlyToken: requiredString(value.readOnlyToken),
    terminalToken: requiredString(value.terminalToken),
    terminalInputAckVersion: value.terminalInputAckVersion === 1 ? 1 : undefined,
    // Present in real discovery files; optional so credential-free fixtures
    // and older daemons keep the proxy paths working. Watch worktree reads
    // need it and answer 503 without it.
    fullToken: typeof value.token === "string" && value.token.length > 0 ? value.token : undefined,
  };
}

function firstMessage(socket, connectionId, channel) {
  return new Promise((resolve) => {
    const startedAtEpochMs = Date.now();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      diagnostics.report(channel, "first_message_timeout", {
        connectionId,
        durationMs: Date.now() - startedAtEpochMs,
      });
      resolve(undefined);
    }, 5_000);
    socket.once("message", (data, isBinary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const bytes = rawBuffer(data);
      diagnostics.report(channel, "first_message_received", {
        connectionId,
        binary: isBinary,
        bytes: bytes.byteLength,
        durationMs: Date.now() - startedAtEpochMs,
      });
      resolve({ data: bytes, isBinary });
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      diagnostics.report(channel, "closed_before_first_message", {
        connectionId,
        durationMs: Date.now() - startedAtEpochMs,
      });
      resolve(undefined);
    });
  });
}

function validateConfig(value) {
  if ((value?.version !== 1 && value?.version !== 2)
    || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new Error("mobile access gateway config is invalid");
  }
  const result = {
    port: value.port,
    hostPlatform: value.hostPlatform === "linux" ? "linux" : "darwin",
    runtimeFile: requiredString(value.runtimeFile),
    controlToken: boundedToken(value.controlToken),
    terminalToken: boundedToken(value.terminalToken),
  };
  if (value.version === 2) {
    result.push = {
      connectionId: requiredString(value.connectionId),
      devicesFile: requiredString(value.pushDevicesFile),
      apnsConfigFile: requiredString(value.apnsConfigFile),
    };
  }
  if (value.watchToken !== undefined) result.watchToken = boundedToken(value.watchToken);
  // Absent on Linux, where the service manager owns retention.
  if (typeof value.logFile === "string" && value.logFile.length > 0) result.logFile = value.logFile;
  return result;
}

function readBody(request, maxBytes) {
  return readBinaryBody(request, maxBytes).then((buffer) => buffer.toString("utf8"));
}

function readBinaryBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("request too large")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function readBytes(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error("request too large")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function endpoint(value, pathname) {
  const url = new URL(requiredString(value));
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== pathname
    || !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("runtime endpoint is not the expected loopback WebSocket");
  }
  return url;
}

function boundedToken(value) {
  const token = requiredString(value);
  if (token.length < 32 || token.length > 256) throw new Error("gateway token is invalid");
  return token;
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("required string is missing");
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function constantTimeEqual(value, expected) {
  return typeof value === "string" && constantTimeBufferEqual(Buffer.from(value), Buffer.from(expected));
}

function constantTimeBufferEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function rawBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}

function terminalDiagnosticContext(metadata) {
  return metadata === undefined ? {} : {
    sessionId: metadata.sessionId,
    runtimeEpoch: metadata.runtimeEpoch,
    frameSequence: metadata.frameSequence,
    frameKind: metadata.frameKind,
    frameKindName: metadata.frameKindName,
    payloadBytes: metadata.payloadBytes,
  };
}

function safePathname(value) {
  try { return new URL(value ?? "/", "http://127.0.0.1").pathname; } catch { return ""; }
}

function refuse(socket, reason) {
  diagnostics.report("gateway", "socket_refused", {
    closeCode: 1008,
    reason,
  });
  if (socket.readyState === WebSocket.OPEN) socket.close(1008, reason);
}

function incompatible(socket, reason) {
  diagnostics.report("gateway", "socket_incompatible", {
    closeCode: 4406,
    reason,
  });
  if (socket.readyState === WebSocket.OPEN) socket.close(4406, reason);
}

function unsupportedUpgrade(socket) {
  const body = Buffer.from(JSON.stringify({
    error: "unsupportedWebSocketPath",
    buildId: GATEWAY_IDENTITY.buildId,
    compatibility: GATEWAY_IDENTITY.compatibility,
  }));
  const headers = [
    "HTTP/1.1 426 Upgrade Required",
    "Connection: close",
    "Cache-Control: no-store",
    "Content-Type: application/json",
    `Content-Length: ${body.byteLength}`,
    `X-TermLoop-Gateway-Build: ${GATEWAY_IDENTITY.buildId}`,
    `X-TermLoop-Mobile-Transport-Min: ${GATEWAY_IDENTITY.compatibility.mobileTransport.min}`,
    `X-TermLoop-Mobile-Transport-Max: ${GATEWAY_IDENTITY.compatibility.mobileTransport.max}`,
    "",
    "",
  ].join("\r\n");
  socket.end(Buffer.concat([Buffer.from(headers), body]));
}

function unavailable(socket) {
  diagnostics.report("gateway", "socket_unavailable", { closeCode: 1013 });
  if (socket.readyState === WebSocket.OPEN) socket.close(1013, "TermLoop is starting");
}

function safeCloseCode(code) {
  return code >= 1000 && code !== 1005 && code !== 1006 && code < 5000 ? code : 1012;
}

function shutdown() {
  clearInterval(heartbeatTimer);
  diagnostics.report("gateway", "shutdown_started", { openSockets: sockets.size });
  for (const socket of sockets) socket.close(1001, "gateway restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
