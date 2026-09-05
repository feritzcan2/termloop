import type {
  MobileDiagnosticEvent,
  MobileDiagnosticValue,
} from "./mobile-diagnostics";

export type MobileSentryLogLevel = "debug" | "info" | "warn" | "error";

export interface MobileSentryDiagnostic {
  readonly message: string;
  readonly level: MobileSentryLogLevel;
  readonly attributes: Readonly<Record<string, MobileDiagnosticValue>>;
  readonly createsIssue: boolean;
}

const identifierKeys = new Map([
  ["attachmentId", "attachmentRef"],
  ["connectionId", "connectionRef"],
  ["mobileRunId", "mobileRunRef"],
  ["projectId", "projectRef"],
  ["requestId", "requestRef"],
  ["runId", "mobileRunRef"],
  ["sessionId", "sessionRef"],
  ["taskId", "taskRef"],
]);

const allowedStringKeys = new Set([
  "area",
  "causeType",
  "errorCode",
  "event",
  "eventType",
  "lastDisconnectReason",
  "lateSettlement",
  "method",
  "mobileAppState",
  "nativeState",
  "preflightFailureReason",
  "requestCauseType",
  "reason",
  "receiptSource",
  "routeKind",
  "transportPhase",
]);

const suppressedControlEvents = new Set(["request_started", "request_sent"]);
const suppressedTerminalEvents = new Set([
  "input_delivered",
  "input_receipt_received",
]);

export function mobileSentryDiagnostic(
  diagnostic: MobileDiagnosticEvent,
): MobileSentryDiagnostic | undefined {
  if (diagnostic.area === "control" && suppressedControlEvents.has(diagnostic.event)) return undefined;
  if (diagnostic.area === "control"
    && diagnostic.event === "request_completed"
    && diagnostic.details.ok === true) return undefined;
  if (diagnostic.area === "terminal" && suppressedTerminalEvents.has(diagnostic.event)) return undefined;

  const attributes: Record<string, MobileDiagnosticValue> = {};
  const source: Readonly<Record<string, MobileDiagnosticValue>> = {
    atEpochMs: diagnostic.atEpochMs,
    elapsedMs: diagnostic.elapsedMs,
    sequence: diagnostic.sequence,
    runId: diagnostic.runId,
    area: diagnostic.area,
    event: diagnostic.event,
    ...diagnostic.details,
  };
  for (const [key, value] of Object.entries(source)) {
    const safe = safeAttribute(key, value);
    if (safe !== undefined) attributes[safe.key] = safe.value;
  }

  return {
    message: `mobile.${diagnostic.area}.${diagnostic.event}`,
    level: logLevel(diagnostic.event, diagnostic.details),
    attributes,
    createsIssue: diagnostic.event === "reconnect_stalled"
      || diagnostic.event === "preflight_stalled",
  };
}

function safeAttribute(
  key: string,
  value: MobileDiagnosticValue,
): { readonly key: string; readonly value: MobileDiagnosticValue } | undefined {
  if (/token|auth|credential|secret|payload|content|text|endpoint|url/i.test(key)) return undefined;
  const identifierKey = identifierKeys.get(key);
  if (identifierKey !== undefined) {
    return typeof value === "string"
      ? { key: identifierKey, value: reference(value) }
      : undefined;
  }
  if (typeof value !== "string") return { key, value };
  if (!allowedStringKeys.has(key)) return undefined;
  return { key, value: sanitizeString(value) };
}

function sanitizeString(value: string): string {
  return value
    .replace(/\b(?:wss?|https?):\/\/\S+/gi, "[endpoint]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|auth|secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 120);
}

function reference(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `ref-${(hash >>> 0).toString(36)}`;
}

function logLevel(
  event: string,
  details: Readonly<Record<string, MobileDiagnosticValue>>,
): MobileSentryLogLevel {
  if (event.endsWith("_stalled")
    || event.includes("timeout")
    || event.includes("failed")
    || event.includes("error")
    || details.ok === false) return "error";
  if (event.includes("closed")
    || event.includes("disconnected")
    || event.includes("reconnect")
    || event.includes("invalid")
    || event.includes("refused")) return "warn";
  if (event.includes("started") || event.includes("sent")) return "debug";
  return "info";
}
