const INSTALLATION_ID = /^[a-f0-9]{32}$/u;
const DEVICE_TOKEN = /^[a-f0-9]{32,256}$/u;
const ALLOWED_BUNDLE_IDS = new Set([
  "ai.termloop.mobile",
  "ai.termloop.mobile.watch",
]);
const ALLOWED_ATTENTION_KINDS = new Set([
  "needsInput",
  "needsReview",
  "stewardProposal",
  "stewardReply",
  "stewardSuggestion",
]);
const ALLOWED_CATEGORIES = new Set([
  "TERMLOOP_AGENT_ATTENTION",
  "TERMLOOP_STEW_PROPOSAL",
  "TERMLOOP_STEW_REPLY",
  "TERMLOOP_STEW_SUGGESTION",
]);
const ALLOWED_STEWARD_KINDS = new Set([
  "reply",
  "update",
  "attention",
  "problem",
  "suggestion",
  "acceptance",
  "action",
  "proposal",
  "approval",
  "decline",
]);
const MAX_DEVICES = 8;

export type PushEnvironment = "development" | "production";

export type PushDevice = {
  deviceToken: string;
  environment: PushEnvironment;
  bundleId: "ai.termloop.mobile" | "ai.termloop.mobile.watch";
  payload: ApnsPayload;
};

export type ApnsNavigationData = {
  connectionId: string;
  projectId: string;
  sessionId: string;
  attentionKind: string;
  cwd: string | null;
  runtimeEpoch: number | null;
  chatProjectId: string | null;
  stewardMessageId: string | null;
  stewardMessageKind: string | null;
};

export type ApnsPayload = ApnsNavigationData & {
  aps: {
    alert: { title: string; body: string };
    sound?: "default";
    badge: 1;
    category: string;
    "thread-id": string;
    "interruption-level"?: "active";
    "relevance-score"?: 1;
  };
  body: ApnsNavigationData;
};

export type PushRequest = {
  version: 1;
  installationId: string;
  devices: PushDevice[];
};

export function pushRequestOf(value: unknown): PushRequest | undefined {
  if (!plainObject(value) || value.version !== 1
    || typeof value.installationId !== "string" || !INSTALLATION_ID.test(value.installationId)
    || !Array.isArray(value.devices) || value.devices.length === 0 || value.devices.length > MAX_DEVICES) {
    return undefined;
  }
  const devices = value.devices.map(pushDeviceOf);
  return devices.every((device): device is PushDevice => device !== undefined)
    ? { version: 1, installationId: value.installationId, devices }
    : undefined;
}

function pushDeviceOf(value: unknown): PushDevice | undefined {
  if (!plainObject(value) || typeof value.deviceToken !== "string"
    || !DEVICE_TOKEN.test(value.deviceToken)
    || (value.environment !== "development" && value.environment !== "production")
    || typeof value.bundleId !== "string" || !ALLOWED_BUNDLE_IDS.has(value.bundleId)) return undefined;
  const payload = apnsPayloadOf(value.payload);
  if (payload === undefined) return undefined;
  return {
    deviceToken: value.deviceToken,
    environment: value.environment,
    bundleId: value.bundleId as PushDevice["bundleId"],
    payload,
  };
}

function apnsPayloadOf(value: unknown): ApnsPayload | undefined {
  if (!plainObject(value) || !plainObject(value.aps)) return undefined;
  const aps = value.aps;
  const alert = aps.alert;
  if (!plainObject(alert)) return undefined;
  const runtimeEpoch = value.runtimeEpoch;
  if (!boundedString(alert.title, 180) || !boundedString(alert.body, 512)
    || (aps.sound !== undefined && aps.sound !== "default")
    || aps.badge !== 1
    || typeof aps.category !== "string" || !ALLOWED_CATEGORIES.has(aps.category)
    || !boundedString(aps["thread-id"], 256)
    || (aps["interruption-level"] !== undefined && aps["interruption-level"] !== "active")
    || (aps["relevance-score"] !== undefined && aps["relevance-score"] !== 1)
    || !boundedString(value.connectionId, 64) || !/^mac-[a-f0-9]{16}$/u.test(value.connectionId)
    || !boundedString(value.projectId, 256) || !boundedString(value.sessionId, 256)
    || typeof value.attentionKind !== "string" || !ALLOWED_ATTENTION_KINDS.has(value.attentionKind)
    || !nullableBoundedString(value.cwd, 2048)
    || !(runtimeEpoch === null || (typeof runtimeEpoch === "number"
      && Number.isInteger(runtimeEpoch) && runtimeEpoch >= 0))
    || !nullableBoundedString(value.chatProjectId, 256)
    || !nullableBoundedString(value.stewardMessageId, 256)
    || !(value.stewardMessageKind === null
      || (typeof value.stewardMessageKind === "string" && ALLOWED_STEWARD_KINDS.has(value.stewardMessageKind)))) {
    return undefined;
  }
  const navigation: ApnsNavigationData = {
    connectionId: value.connectionId,
    projectId: value.projectId,
    sessionId: value.sessionId,
    attentionKind: value.attentionKind,
    cwd: value.cwd,
    runtimeEpoch,
    chatProjectId: value.chatProjectId,
    stewardMessageId: value.stewardMessageId,
    stewardMessageKind: value.stewardMessageKind,
  };
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      ...(aps.sound === undefined ? {} : { sound: aps.sound }),
      badge: 1,
      category: aps.category,
      "thread-id": aps["thread-id"],
      ...(aps["interruption-level"] === undefined
        ? {} : { "interruption-level": aps["interruption-level"] }),
      ...(aps["relevance-score"] === undefined ? {} : { "relevance-score": aps["relevance-score"] }),
    },
    ...navigation,
    // Expo Notifications maps direct APNs remote data from `userInfo.body`.
    // Construct it from validated fields instead of forwarding client input.
    body: navigation,
  };
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function nullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || boundedString(value, maxLength);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
