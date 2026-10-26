// UI-local types. The UI imports contract types only; it never imports the
// bridge, a transport, or the terminal adapter.
import type {
  PmAgentProvider,
  PmAgentState,
  PmJiraApplyResult,
  PmJiraBoardsReadResult,
  PmJiraDiff,
  PmJiraSprintsReadResult,
  PmTicketPriority,
} from "@termloop/pm-contract/pm";

/**
 * The stage's content; `jira` (the Jira issue browser) and `settings` are
 * the ones the activity bar toggles, `agent` the selected agent's terminal at
 * full stage size.
 */
export type PmView = "overview" | "ticket" | "jira" | "agent" | "skill" | "settings";

/** What the right activity bar opens in the right sidebar. */
export type RightSidebarView = "sprints" | "playbook" | "suggestions" | "skills";

export type JiraDialogView = {
  ticketId: string;
  loading: boolean;
  diff: PmJiraDiff | undefined;
  /** Set when Apply found Jira changed; the shown diff is the fresh one. */
  staleNotice: boolean;
  result: Exclude<PmJiraApplyResult, { kind: "stale" }> | undefined;
  error: string | undefined;
};

/** The Sprints panel's view of the project's Jira board. */
export type JiraSprintsView = {
  loading: boolean;
  /** The board's open sprints; read when a board is chosen. */
  sprints: PmJiraSprintsReadResult | undefined;
  /** The boards to choose from; read when no board is chosen, or on request. */
  boards: PmJiraBoardsReadResult | undefined;
  error: string | undefined;
  /** The Jira sprint being imported. */
  importing: number | undefined;
};

/** Mounts a live terminal for a session into `host`; returns its disposer. */
export type MountTerminal = (host: HTMLElement, sessionId: string) => () => void;

/** One running agent session as the sidebar and the agent pane show it. */
export type AgentTab = {
  sessionId: string;
  label: string;
  state: PmAgentState;
  assistant: boolean;
  provider: PmAgentProvider;
  /** What the session is about, e.g. its focus ticket. */
  detail: string;
  /** The ticket the session works on; the sidebar nests the agent under it. */
  focusTicketId: string | null;
};

/** How a description save ended: saved as `headVersion`, refused because a newer version exists, or failed with a notice. */
export type DescriptionSaveOutcome = { kind: "saved"; headVersion: number } | { kind: "conflict" } | { kind: "failed" };

/** A quick-capture ticket: `sprintId` null files it in the backlog; an empty assignee leaves it unassigned. */
export type TicketCapture = {
  title: string;
  sprintId: string | null;
  priority: PmTicketPriority;
  assignee: string;
  askAssistant: boolean;
};

