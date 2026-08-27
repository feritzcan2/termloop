import { appendFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let payload = {};
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  payload = { hook_event_name: "invalid-json" };
}

const event = {
  recordedAtEpochMs: Date.now(),
  agent: process.env.TERMLOOP_SPIKE_AGENT ?? "unknown",
  scenario: process.env.TERMLOOP_SPIKE_SCENARIO ?? "unknown",
  hookEventName:
    payload.hook_event_name ?? payload.hookEventName ?? "unknown",
  hasNativeSessionId:
    typeof payload.session_id === "string" && payload.session_id.length > 0,
  hasTurnId: typeof payload.turn_id === "string" && payload.turn_id.length > 0,
  toolName: typeof payload.tool_name === "string" ? payload.tool_name : null,
  notificationType:
    typeof payload.notification_type === "string"
      ? payload.notification_type
      : null,
  permissionMode:
    typeof payload.permission_mode === "string" ? payload.permission_mode : null,
  correlationSessionMatches:
    process.env.TERMLOOP_SESSION_ID ===
    process.env.TERMLOOP_SPIKE_EXPECTED_SESSION,
  endpointIsLoopback:
    process.env.TERMLOOP_HOOK_ENDPOINT?.startsWith("http://127.0.0.1:") ?? false,
  tokenPresent: Boolean(process.env.TERMLOOP_HOOK_TOKEN),
};

appendFileSync(
  process.env.TERMLOOP_SPIKE_CAPTURE,
  `${JSON.stringify(event)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
