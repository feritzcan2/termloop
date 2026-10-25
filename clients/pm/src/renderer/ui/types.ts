// UI-local types. The UI imports contract types only; it never imports the
// bridge, a transport, or the terminal adapter.
import type { PmJiraApplyResult, PmJiraDiff } from "@termloop/pm-contract/pm";

export type PmView = "overview" | "ticket" | "settings";

export type JiraDialogView = {
  ticketId: string;
  loading: boolean;
  diff: PmJiraDiff | undefined;
  /** Set when Apply found Jira changed; the shown diff is the fresh one. */
  staleNotice: boolean;
  result: Exclude<PmJiraApplyResult, { kind: "stale" }> | undefined;
  error: string | undefined;
};

/** Mounts a live terminal for a session into `host`; returns its disposer. */
export type MountTerminal = (host: HTMLElement, sessionId: string) => () => void;
