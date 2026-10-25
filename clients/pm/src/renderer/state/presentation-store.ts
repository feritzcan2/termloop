// The PM renderer's one Zustand store: daemon reads, selection, agents, and
// settings. It holds only what the generated contract returns; every write
// goes back through `window.pm` and is followed by a reread.
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  PmAgentCatalog,
  PmAgentSession,
  PmBoard,
  PmDigestReadResult,
  PmJiraPullResult,
  PmProject,
  PmProposal,
  PmSettings,
  PmSkillsReadResult,
  PmSources,
  PmTicketNote,
  PmTicketVersion,
} from "@termloop/pm-contract/pm";
import type { PmConnectionState } from "../../pm-api.js";

export type { PmView } from "../ui/types.js";
import type { JiraDialogView, PmView } from "../ui/types.js";

export type JiraDialogState = JiraDialogView;

export type PmState = {
  connection: PmConnectionState;
  projects: PmProject[];
  projectId: string | undefined;
  board: PmBoard | undefined;
  view: PmView;
  selectedSprintId: string | undefined;
  selectedTicketId: string | undefined;
  digest: PmDigestReadResult | undefined;
  proposals: Record<string, PmProposal[]>;
  versions: Record<string, PmTicketVersion[]>;
  /** Notes read so far, by ticket. */
  notes: Record<string, PmTicketNote[]>;
  agents: PmAgentSession[];
  activeAgentSessionId: string | undefined;
  settings: PmSettings | undefined;
  catalog: PmAgentCatalog | undefined;
  sources: PmSources | undefined;
  /** The project's skills and drafts waiting for review. */
  skills: PmSkillsReadResult | undefined;
  lastPull: PmJiraPullResult | undefined;
  pulling: boolean;
  jiraDialog: JiraDialogState | undefined;
  notice: { tone: "error" | "info"; text: string } | undefined;
};

export const initialPmState: PmState = {
  connection: { state: "starting" },
  projects: [],
  projectId: undefined,
  board: undefined,
  view: "overview",
  selectedSprintId: undefined,
  selectedTicketId: undefined,
  digest: undefined,
  proposals: {},
  versions: {},
  notes: {},
  agents: [],
  activeAgentSessionId: undefined,
  settings: undefined,
  catalog: undefined,
  sources: undefined,
  skills: undefined,
  lastPull: undefined,
  pulling: false,
  jiraDialog: undefined,
  notice: undefined,
};

export type PmStore = StoreApi<PmState>;

export function createPmStore(initial: Partial<PmState> = {}): PmStore {
  return createStore<PmState>(() => ({ ...initialPmState, ...initial }));
}

/** React binding; composition is the only caller. */
export function usePmState<T>(store: PmStore, selector: (state: PmState) => T): T {
  return useStore(store, selector);
}
