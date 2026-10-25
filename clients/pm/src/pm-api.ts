// The typed surface the preload exposes as `window.pm`. It carries contract
// types only; the renderer never receives the control client, a socket,
// the bearer, or the runtime epoch.
import type { EventName, Method, MethodParams, MethodResults } from "@termloop/pm-contract/pm";

/**
 * The control methods the renderer may call. `pm_subscribe` and `pm_cancel`
 * stay with main: main owns the one event subscription and request timeouts.
 */
export const RENDERER_METHODS = [
  "pm_system_version",
  "pm_project_list",
  "pm_project_create",
  "pm_board_read",
  "pm_digest_read",
  "pm_sprint_create",
  "pm_sprint_update",
  "pm_sprint_activate",
  "pm_sprint_close",
  "pm_ticket_create",
  "pm_ticket_update",
  "pm_ticket_move",
  "pm_ticket_description_save",
  "pm_ticket_versions_read",
  "pm_ticket_blocker_add",
  "pm_ticket_blocker_remove",
  "pm_ticket_criterion_add",
  "pm_ticket_criterion_set_done",
  "pm_ticket_criterion_remove",
  "pm_ticket_proposals_read",
  "pm_ticket_proposal_accept",
  "pm_ticket_proposal_reject",
  "pm_environments_set",
  "pm_sources_read",
  "pm_sources_set",
  "pm_credential_store",
  "pm_credential_clear",
  "pm_probe_create",
  "pm_probe_approve",
  "pm_probe_reject",
  "pm_probe_delete",
  "pm_check_start",
  "pm_checks_read",
  "pm_jira_pull",
  "pm_jira_diff_read",
  "pm_jira_apply",
  "pm_agent_launch",
  "pm_agent_list",
  "pm_agent_stop",
  "pm_agent_catalog_read",
  "pm_settings_read",
  "pm_settings_update",
] as const satisfies readonly Method[];

export type RendererMethod = typeof RENDERER_METHODS[number];

export function isRendererMethod(value: unknown): value is RendererMethod {
  return typeof value === "string" && (RENDERER_METHODS as readonly string[]).includes(value);
}

/** A failed call as it crosses IPC: the schema error code, never a stack. */
export type PmCallError = { code: string; message: string; details?: unknown };
export type PmCallOutcome<M extends RendererMethod> =
  | { ok: true; result: MethodResults[M] }
  | { ok: false; error: PmCallError };

/** `pmResubscribed` is main's own notice that events may have been missed. */
export type PmEvent = { event: EventName | "pmResubscribed"; payload: unknown };

export type PmConnectionState =
  | { state: "starting" }
  | { state: "connected"; version: string }
  | { state: "failed"; message: string };

/** A terminal frame relayed from the terminal plane; bytes stay binary. */
export type PmTerminalMessage =
  | { sessionId: string; type: "attached"; ack: Uint8Array }
  | { sessionId: string; type: "output"; data: Uint8Array; replay: boolean }
  | { sessionId: string; type: "gap" }
  | { sessionId: string; type: "eof" }
  | { sessionId: string; type: "error"; message: string }
  | { sessionId: string; type: "state"; state: "connecting" | "connected" | "connectionLost" };

export type PmApi = {
  call<M extends RendererMethod>(method: M, params: MethodParams[M]): Promise<PmCallOutcome<M>>;
  connectionState(): Promise<PmConnectionState>;
  onConnectionState(listener: (state: PmConnectionState) => void): () => void;
  onEvent(listener: (event: PmEvent) => void): () => void;
  openExternal(url: string): Promise<void>;
  terminal: {
    /** Attaches with the surface's measured grid; it reaches the PTY before replay. */
    attach(sessionId: string, rows: number, cols: number): Promise<void>;
    detach(sessionId: string): void;
    input(sessionId: string, data: Uint8Array): void;
    resize(sessionId: string, rows: number, cols: number): void;
    /** Returns consumed output bytes so main can release queued frames. */
    credit(sessionId: string, bytes: number): void;
    onMessage(listener: (message: PmTerminalMessage) => void): () => void;
  };
};

export const IPC = {
  call: "pm:call",
  connectionState: "pm:connection-state",
  connectionStateChanged: "pm:connection-state-changed",
  event: "pm:event",
  openExternal: "pm:open-external",
  terminalAttach: "pm:terminal-attach",
  terminalDetach: "pm:terminal-detach",
  terminalInput: "pm:terminal-input",
  terminalResize: "pm:terminal-resize",
  terminalCredit: "pm:terminal-credit",
  terminalMessage: "pm:terminal-message",
} as const;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}
