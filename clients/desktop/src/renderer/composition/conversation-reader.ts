import type { SessionConversationReadResult } from "@termloop/contract/current";
import type { ConversationPort, ConversationState, ConversationSubagent } from "../terminal-presentation.js";

type Target = { id: string; project_id: string; runtime_epoch: number; process: { agent_id: string | null } };
type Entry = {
  state: ConversationState;
  positions: (number | undefined)[];
  request?: object;
  refresh?: ReturnType<typeof setTimeout> | undefined;
};

class SessionChanged extends Error {
  constructor() { super("Session changed. Close saved messages and open them again."); }
}

/// How often an open subagent view rereads the newest page of its transcript.
export const SUBAGENT_REFRESH_MS = 2000;

export function createConversationReader(
  session: (id: string) => Target | undefined,
  read: (projectId: string, id: string, before?: number, subagentKey?: string) => Promise<SessionConversationReadResult>,
  cover: (id: string, covered: boolean) => void,
): ConversationPort {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const supported = (id: string) => ["claude", "codex"].includes(session(id)?.process.agent_id ?? "");
  const stopRefresh = (entry: Entry) => {
    if (entry.refresh !== undefined) clearTimeout(entry.refresh);
    entry.refresh = undefined;
  };
  /// A subagent keeps writing while it is viewed, so the newest page is reread
  /// quietly. Older pages are fixed history and stay as they are.
  const scheduleRefresh = (id: string, entry: Entry) => {
    stopRefresh(entry);
    if (!entry.state.subagent || entry.positions.length > 1 || entry.state.error) return;
    entry.refresh = setTimeout(() => {
      entry.refresh = undefined;
      if (entries.get(id) === entry && !entry.state.loading) void load(id, entry, true);
    }, SUBAGENT_REFRESH_MS);
  };
  const load = async (id: string, entry: Entry, quiet = false) => {
    const target = session(id);
    if (!target) return;
    const request = {};
    entry.request = request;
    stopRefresh(entry);
    if (!quiet) {
      entry.state = { ...entry.state, loading: true, error: undefined, hasNewer: entry.positions.length > 1 };
      notify();
    }
    try {
      const subagentKey = entry.state.subagent?.key;
      const page = subagentKey === undefined
        ? await read(target.project_id, id, entry.positions.at(-1))
        : await read(target.project_id, id, entry.positions.at(-1), subagentKey);
      if (entries.get(id) !== entry || entry.request !== request) return;
      const current = session(id);
      if (current?.project_id !== target.project_id || current.runtime_epoch !== target.runtime_epoch
        || current.process.agent_id !== target.process.agent_id) throw new SessionChanged();
      entry.state = { loading: false, page, hasNewer: entry.positions.length > 1, subagent: entry.state.subagent };
    } catch (error) {
      if (entries.get(id) !== entry || entry.request !== request) return;
      // A failed background reread keeps the page already on screen and tries
      // again on the next tick instead of replacing the transcript with an
      // error. A changed Session cannot recover that way.
      if (!quiet || error instanceof SessionChanged) entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : "Saved messages could not be loaded." };
    }
    scheduleRefresh(id, entry);
    notify();
  };
  return {
    supported,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: (id) => entries.get(id)?.state,
    open(id, subagent?: ConversationSubagent) {
      if (!supported(id)) return;
      const current = entries.get(id);
      if (current && current.state.subagent?.key === subagent?.key) return;
      if (!current && entries.size >= 8) return;
      if (current) stopRefresh(current);
      // Switching between the Session and one of its subagents replaces the
      // view in place; the terminal stays covered.
      const entry: Entry = { state: { loading: true, hasNewer: false, subagent }, positions: [undefined] };
      entries.set(id, entry);
      if (!current) cover(id, true);
      void load(id, entry);
    },
    close(id) {
      const entry = entries.get(id);
      if (!entry) return;
      stopRefresh(entry);
      entries.delete(id);
      cover(id, false);
      notify();
    },
    older(id) {
      const entry = entries.get(id);
      const before = entry?.state.page?.next_before;
      if (!entry || entry.state.loading || entry.state.error || before == null) return;
      const current = entry.positions.at(-1);
      if (current !== undefined && before >= current) return;
      entry.positions.push(before);
      void load(id, entry);
    },
    newer(id) {
      const entry = entries.get(id);
      if (!entry || entry.state.loading || entry.positions.length < 2) return;
      entry.positions.pop();
      void load(id, entry);
    },
    retry(id) {
      const entry = entries.get(id);
      if (entry && !entry.state.loading) void load(id, entry);
    },
  };
}
