import type { AgentStatusDto, SessionDto } from "@termloop/contract/current";

import type { MobileRuntime, TerminalAttachment } from "../../application/ports";
import { reviewPasteBytes } from "../../presentation/change-review-notes";
import { submitTerminalTurn } from "../terminal/submit-terminal-turn";

/// Category and action identifiers shared with the gateway payload and the Watch.
export const AGENT_ATTENTION_CATEGORY = "TERMLOOP_AGENT_ATTENTION";
export const AGENT_PERMISSION_CATEGORY = "TERMLOOP_AGENT_PERMISSION";
export const AGENT_APPROVE_ACTION = "TERMLOOP_AGENT_APPROVE";
export const AGENT_DENY_ACTION = "TERMLOOP_AGENT_DENY";
export const AGENT_REPLY_ACTION = "TERMLOOP_REPLY";

const MAX_REPLY_CHARACTERS = 4096;

export type AgentNotificationAction =
  | { readonly kind: "approve" | "deny"; readonly sessionId: string; readonly runtimeEpoch: number }
  | { readonly kind: "reply"; readonly sessionId: string; readonly runtimeEpoch: number; readonly text: string };

/// APNs data and the typed reply are untrusted. Only an exact Agent target with
/// its runtime epoch can carry an action; anything else stays a plain tap.
export function agentNotificationActionOf(
  actionIdentifier: string,
  userText: string | undefined,
  contentData: unknown,
  trigger: unknown,
): AgentNotificationAction | undefined {
  const target = actionTarget(contentData) ?? (isRecord(trigger) ? actionTarget(trigger.payload) : undefined);
  if (target === undefined) return undefined;
  if (actionIdentifier === AGENT_APPROVE_ACTION) return { kind: "approve", ...target };
  if (actionIdentifier === AGENT_DENY_ACTION) return { kind: "deny", ...target };
  if (actionIdentifier !== AGENT_REPLY_ACTION) return undefined;
  const text = (userText ?? "").trim().slice(0, MAX_REPLY_CHARACTERS);
  return text.length === 0 ? undefined : { kind: "reply", ...target, text };
}

/// Approve and deny answer a provider permission prompt with one key, so they
/// require the exact Session epoch to still await input; a reply is a new turn
/// and only requires that Session epoch to still be running.
export function agentActionAllowed(
  action: AgentNotificationAction,
  sessions: readonly Pick<SessionDto, "id" | "runtime_epoch" | "lifecycle_state">[],
  statuses: readonly Pick<AgentStatusDto, "sessionId" | "status">[],
): boolean {
  const session = sessions.find(({ id }) => id === action.sessionId);
  if (session === undefined || session.lifecycle_state !== "running"
    || session.runtime_epoch !== action.runtimeEpoch) return false;
  if (action.kind === "reply") return true;
  return statuses.find(({ sessionId }) => sessionId === action.sessionId)?.status === "awaitingInput";
}

/// Delivers one notification action through the paired Mac's terminal plane.
/// Returns false when the Agent moved on or delivery could not be confirmed.
export async function performAgentNotificationAction(
  runtime: Pick<MobileRuntime, "control" | "terminal">,
  connectionId: string,
  action: AgentNotificationAction,
): Promise<boolean> {
  const stillAllowed = async () => {
    const overview = await runtime.control.loadOverview(connectionId);
    return agentActionAllowed(action, overview.sessions, overview.agentStatuses);
  };
  if (!await stillAllowed()) return false;
  let attachment: TerminalAttachment | undefined;
  let connected = true;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const timer = setTimeout(() => readyReject(new Error("terminal not ready")), 15_000);
  try {
    attachment = await runtime.terminal.attach(
      connectionId,
      { id: action.sessionId, runtime_epoch: action.runtimeEpoch },
      (event) => {
        if (event.type === "ready") readyResolve();
        if (event.type === "eof" || (event.type === "state" && event.state === "connectionLost")) {
          connected = false;
          readyReject(new Error("terminal disconnected"));
        }
      },
    );
    await ready;
    // The prompt may have been answered on the Mac while the terminal attached.
    if (!await stillAllowed()) return false;
    const deliver = async (open: TerminalAttachment, bytes: Uint8Array) => { await open.input(bytes); return true; };
    if (action.kind === "reply") {
      return await submitTerminalTurn(attachment, reviewPasteBytes(action.text), () => connected, deliver);
    }
    return connected && await deliver(attachment, new Uint8Array([action.kind === "approve" ? 13 : 27]));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    await attachment?.detach().catch(() => {});
  }
}

function actionTarget(value: unknown): { sessionId: string; runtimeEpoch: number } | undefined {
  if (!isRecord(value) || (value.chatProjectId !== undefined && value.chatProjectId !== null)) return undefined;
  const sessionId = typeof value.sessionId === "string" && value.sessionId.trim().length > 0
    ? value.sessionId
    : undefined;
  const runtimeEpoch = value.runtimeEpoch;
  if (sessionId === undefined || typeof runtimeEpoch !== "number"
    || !Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) return undefined;
  return { sessionId, runtimeEpoch };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
