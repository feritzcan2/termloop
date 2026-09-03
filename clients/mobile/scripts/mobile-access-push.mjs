import { createPrivateKey, createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";

const MAX_DEVICES = 8;
const TOKEN_MAX = 256;
const DEFAULT_DESKTOP_ACTIVE_MS = 2 * 60 * 1000;
const DEFAULT_DEVICE_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: true,
  agentNeedsInput: true,
  agentReadyForReview: true,
  stewardMessages: true,
  playSound: true,
});

export const defaultPushNotificationPreferences = Object.freeze({
  version: 1,
  mobile: DEFAULT_DEVICE_NOTIFICATION_PREFERENCES,
  watch: DEFAULT_DEVICE_NOTIFICATION_PREFERENCES,
});

export function pushNotificationPreferencesOf(value) {
  if (value?.version !== 1) return undefined;
  const mobile = deviceNotificationPreferencesOf(value.mobile);
  const watch = deviceNotificationPreferencesOf(value.watch);
  return mobile === undefined || watch === undefined
    ? undefined
    : { version: 1, mobile, watch };
}

export function pushDeliveryOptions(preferences, bundleId, notificationKind) {
  const target = typeof bundleId === "string" && bundleId.endsWith(".watch")
    ? preferences.watch
    : preferences.mobile;
  const kindEnabled = notificationKind === "needsInput"
    ? target.agentNeedsInput
    : notificationKind === "needsReview"
      ? target.agentReadyForReview
      : target.stewardMessages;
  return {
    enabled: target.enabled && kindEnabled,
    playSound: target.playSound,
  };
}

export function attentionTransitions(previous, statuses, sessions) {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const notifications = [];
  for (const status of statuses) {
    const before = previous.get(status.sessionId);
    const session = sessionsById.get(status.sessionId);
    if (!session || session.kind !== "Agent" || session.lifecycle_state !== "running") continue;
    if (isStewardOrWorkerSession(session)) continue;
    if (status.status === "awaitingInput" && before !== "awaitingInput") {
      notifications.push(notificationOf(session, "needsInput"));
    } else if (status.status === "idle" && before === "working"
      && (status.source === "hook" || status.source === "appServer")) {
      notifications.push(notificationOf(session, "needsReview"));
    }
  }
  return notifications;
}

export function isStewardOrWorkerSession(session) {
  const template = session.process?.template_ref;
  if (template === "builtin.assistant.activation"
    || template?.startsWith("builtin.steward.")
    || template?.startsWith("builtin.worker.")) return true;

  // Pre-v1 assistant records can lack their original activation template. Keep
  // those migrated persistent Sessions silent without treating a user-renamed
  // ordinary Agent as infrastructure.
  if (template !== null && template !== undefined) return false;
  const name = typeof session.name === "string" ? session.name.trim() : "";
  return name === "Project Steward" || /^Worker \d+$/u.test(name);
}

export function nextStatusMap(statuses) {
  return new Map(statuses.map((status) => [status.sessionId, status.status]));
}

/// Keeps a deferred notification only while the attention state that created it is
/// still current. A user answering from the Mac must cancel the pending phone alert,
/// not merely delay it until the desktop becomes idle.
export function retainCurrentAttention(pending, statuses) {
  const current = nextStatusMap(statuses);
  return new Map([...pending].filter(([sessionId, notification]) => {
    const status = current.get(sessionId);
    return notification.kind === "needsInput" ? status === "awaitingInput" : status === "idle";
  }));
}

/// IOHIDSystem reports nanoseconds since the last keyboard, pointer, or trackpad
/// event. Missing or malformed evidence returns false so notification delivery fails
/// open rather than becoming permanently silent on an unsupported host.
export function macDesktopRecentlyActive(ioregOutput, activeWindowMs = DEFAULT_DESKTOP_ACTIVE_MS) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/u.exec(ioregOutput);
  if (match?.[1] === undefined) return false;
  return BigInt(match[1]) < BigInt(Math.max(0, activeWindowMs)) * 1_000_000n;
}

export function upsertPushDevice(current, candidate, now = Date.now()) {
  const device = validateDevice({ ...candidate, lastSeenAtEpochMs: now });
  const devices = (Array.isArray(current?.devices) ? current.devices : [])
    .filter((entry) => validStoredDevice(entry) && entry.deviceToken !== device.deviceToken)
    .sort((left, right) => right.lastSeenAtEpochMs - left.lastSeenAtEpochMs);
  return { version: 1, devices: [device, ...devices].slice(0, MAX_DEVICES) };
}

export function apnsPayload(notification, connectionId, options = {}) {
  const isStewardDecision = notification.kind === "stewardProposal"
    || notification.kind === "stewardSuggestion";
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      ...((options.playSound ?? true) ? { sound: "default" } : {}),
      badge: 1,
      category: notificationCategory(notification.kind),
      // Decisions stay visually separate from ordinary Stew chat so a later
      // progress update cannot bury the approval card on the Watch.
      "thread-id": isStewardDecision
        ? `steward-decision-${notification.projectId}`
        : notification.sessionId,
      ...(isStewardDecision ? {
        "interruption-level": "active",
        "relevance-score": 1,
      } : {}),
    },
    connectionId,
    projectId: notification.projectId,
    sessionId: notification.sessionId,
    attentionKind: notification.kind,
    // Watch clients deep-link to worktree changes by matching this against
    // the worktree paths in the /watch/worktrees facade response.
    cwd: notification.cwd ?? null,
    // The watch's inline dictation reply posts terminal input, which is
    // epoch-addressed; a Stew chat push instead deep-links to the chat page.
    runtimeEpoch: notification.runtimeEpoch ?? null,
    chatProjectId: notification.chatProjectId ?? null,
    stewardMessageId: notification.stewardMessageId ?? null,
    stewardMessageKind: notification.stewardMessageKind ?? null,
  };
}

function deviceNotificationPreferencesOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.enabled !== "boolean"
    || typeof value.agentNeedsInput !== "boolean"
    || typeof value.agentReadyForReview !== "boolean"
    || typeof value.stewardMessages !== "boolean"
    || typeof value.playSound !== "boolean") return undefined;
  return {
    enabled: value.enabled,
    agentNeedsInput: value.agentNeedsInput,
    agentReadyForReview: value.agentReadyForReview,
    stewardMessages: value.stewardMessages,
    playSound: value.playSound,
  };
}

export function stewardMessageNotificationOf(project, message) {
  const preview = message.content.length > 160
    ? `${message.content.slice(0, 157)}…`
    : message.content;
  const kind = message.kind === "proposal"
    ? "stewardProposal"
    : message.kind === "suggestion" ? "stewardSuggestion" : "stewardReply";
  return {
    kind,
    sessionId: `steward-chat-${project.id}`,
    projectId: project.id,
    chatProjectId: project.id,
    stewardMessageId: message.id,
    stewardMessageKind: message.kind,
    cwd: null,
    title: kind === "stewardProposal"
      ? (project.name ? `Onayın gerekiyor · ${project.name}` : "Onayın gerekiyor")
      : kind === "stewardSuggestion"
        ? (project.name ? `Öneri hazır · ${project.name}` : "Öneri hazır")
        : project.name ? `Stew · ${project.name}` : "Stew",
    body: preview,
  };
}

/// Returns the current actionable Steward decision for each Project. A later
/// Steward-authored progress/update message does not answer a proposal; only a
/// newer user-authored message does. This deliberately mirrors Core's pending
/// interaction rule so the wrist projection cannot silently lose authority.
export function pendingStewardDecisionNotifications(projects, messagesByProject) {
  const notifications = [];
  for (const project of projects) {
    const messages = messagesByProject.get(project.id);
    if (!Array.isArray(messages)) continue;
    const newestUserSequence = messages.reduce(
      (latest, message) => message?.author === "user" && Number.isInteger(message.sequence)
        ? Math.max(latest, message.sequence)
        : latest,
      0,
    );
    const pending = messages.reduce((latest, message) => {
      if (message?.author !== "steward"
        || !["proposal", "suggestion"].includes(message.kind)
        || !Number.isInteger(message.sequence)
        || message.sequence <= newestUserSequence) return latest;
      return latest === undefined || message.sequence > latest.sequence ? message : latest;
    }, undefined);
    if (pending !== undefined) notifications.push(stewardMessageNotificationOf(project, pending));
  }
  return notifications;
}

/// Projects are baselined on the first successful read so installing or
/// restarting Mobile Access never floods the Watch with transcript history.
/// The sole exception is the newest still-pending proposal or suggestion: a
/// gateway restart must not make an unanswered wrist decision disappear.
/// Afterwards every unseen Steward message is delivered in sequence order,
/// regardless of whether the conversation began on the Watch, phone, or Mac.
export function stewardTranscriptNotifications(previousSequences, projects, messagesByProject) {
  const nextSequences = new Map(previousSequences);
  const notifications = [];
  for (const project of projects) {
    const messages = messagesByProject.get(project.id);
    if (!Array.isArray(messages)) continue;
    const latestSequence = messages.reduce(
      (latest, message) => Number.isInteger(message?.sequence) ? Math.max(latest, message.sequence) : latest,
      0,
    );
    const previousSequence = previousSequences.get(project.id);
    if (previousSequence === undefined) {
      const pending = pendingStewardDecisionNotifications([project], messagesByProject)[0];
      if (pending !== undefined) notifications.push(pending);
    } else {
      const unseen = messages
        .filter((message) => message?.author === "steward"
          && Number.isInteger(message.sequence)
          && message.sequence > previousSequence)
        .sort((left, right) => left.sequence - right.sequence);
      for (const message of unseen) {
        notifications.push(stewardMessageNotificationOf(project, message));
      }
    }
    nextSequences.set(project.id, Math.max(previousSequence ?? 0, latestSequence));
  }
  return { notifications, nextSequences };
}

function notificationCategory(kind) {
  if (kind === "stewardProposal") return "TERMLOOP_STEW_PROPOSAL";
  if (kind === "stewardSuggestion") return "TERMLOOP_STEW_SUGGESTION";
  if (kind === "stewardReply") return "TERMLOOP_STEW_REPLY";
  return "TERMLOOP_AGENT_ATTENTION";
}

export async function loadApnsProvider(configFile) {
  const raw = JSON.parse(await readFile(configFile, "utf8"));
  const teamId = boundedIdentifier(raw.team_id);
  const keyId = boundedIdentifier(raw.key_id);
  const keyFile = boundedFile(raw.key_file);
  const privateKey = createPrivateKey(await readFile(path.join(path.dirname(configFile), keyFile), "utf8"));
  return { teamId, keyId, privateKey };
}

export function createApnsJwt(provider, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: provider.keyId }));
  const claims = base64url(JSON.stringify({ iss: provider.teamId, iat: nowEpochSeconds }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign({ key: provider.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

export function createApnsRequestId() {
  return randomUUID();
}

export async function sendApns(provider, device, payload) {
  const hosts = device.environment === "production"
    ? ["api.push.apple.com", "api.sandbox.push.apple.com"]
    : ["api.sandbox.push.apple.com", "api.push.apple.com"];
  let result;
  for (const host of hosts) {
    result = await sendOne(provider, device, payload, host);
    if (
      result.ok ||
      !["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason)
    ) return result;
  }
  return result;
}

function notificationOf(session, kind) {
  const agent = session.process?.agent_id === "claude"
    ? "Claude"
    : session.process?.agent_id === "codex" ? "Codex" : "Agent";
  const label = typeof session.name === "string" && session.name.trim() ? session.name.trim() : agent;
  return {
    kind,
    sessionId: session.id,
    runtimeEpoch: session.runtime_epoch,
    projectId: session.project_id,
    cwd: typeof session.process?.cwd === "string" ? session.process.cwd : null,
    title: kind === "needsInput" ? `${agent} needs your input` : `${agent} is ready for review`,
    body: label === agent
      ? (kind === "needsInput" ? "Waiting for your input." : "Turn completed.")
      : label,
  };
}

export function withNotificationPreview(notification, preview) {
  return typeof preview === "string" && preview.trim().length > 0
    ? { ...notification, body: preview.trim() }
    : notification;
}

function validateDevice(value) {
  if (!/^[A-Fa-f0-9]{32,256}$/.test(value.deviceToken ?? "")) throw new Error("invalid APNs device token");
  if (value.environment !== "development" && value.environment !== "production") throw new Error("invalid APNs environment");
  if (!/^ai\.termloop\.[A-Za-z0-9.-]{1,96}$/.test(value.bundleId ?? "")) throw new Error("invalid app bundle id");
  return {
    deviceToken: value.deviceToken.toLowerCase(),
    environment: value.environment,
    bundleId: value.bundleId,
    lastSeenAtEpochMs: value.lastSeenAtEpochMs,
  };
}

function validStoredDevice(value) {
  try { validateDevice(value); return Number.isFinite(value.lastSeenAtEpochMs); } catch { return false; }
}

function boundedIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{4,32}$/.test(value)) throw new Error("invalid APNs identifier");
  return value;
}

function boundedFile(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error("invalid APNs key filename");
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sendOne(provider, device, payload, host) {
  return new Promise((resolve) => {
    const client = http2.connect(`https://${host}`);
    const timer = setTimeout(() => {
      client.destroy();
      resolve({ ok: false, reason: "timeout" });
    }, 15_000);
    client.once("error", () => {
      clearTimeout(timer);
      client.destroy();
      resolve({ ok: false, reason: "transport" });
    });
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${device.deviceToken}`,
      authorization: `bearer ${createApnsJwt(provider)}`,
      "apns-topic": device.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-id": createApnsRequestId(),
      "content-type": "application/json",
    });
    let status = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => { status = Number(headers[":status"] ?? 0); });
    request.on("data", (chunk) => { if (body.length < 1024) body += chunk; });
    request.on("end", () => {
      clearTimeout(timer);
      client.close();
      let reason = "";
      try { reason = JSON.parse(body).reason ?? ""; } catch { /* Empty success response. */ }
      resolve({ ok: status === 200, status, reason });
    });
    request.once("error", () => {
      clearTimeout(timer);
      client.destroy();
      resolve({ ok: false, reason: "transport" });
    });
    request.end(JSON.stringify(payload));
  });
}
