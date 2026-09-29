import type { SessionConversationReadResult } from "@termloop/contract/current";
import type { ConversationPort, ConversationState } from "../terminal-presentation.js";

type Target = { id: string; project_id: string; runtime_epoch: number; process: { agent_id: string | null } };
type Entry = { state: ConversationState; positions: (number | undefined)[]; request?: object };

export function createConversationReader(
  session: (id: string) => Target | undefined,
  read: (projectId: string, id: string, before?: number) => Promise<SessionConversationReadResult>,
  cover: (id: string, covered: boolean) => void,
): ConversationPort {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const supported = (id: string) => ["claude", "codex"].includes(session(id)?.process.agent_id ?? "");
  const load = async (id: string, entry: Entry) => {
    const target = session(id);
    if (!target) return;
    const request = {};
    entry.request = request;
    entry.state = { ...entry.state, loading: true, error: undefined, hasNewer: entry.positions.length > 1 };
    notify();
    try {
      const page = await read(target.project_id, id, entry.positions.at(-1));
      if (entries.get(id) !== entry || entry.request !== request) return;
      const current = session(id);
      if (current?.project_id !== target.project_id || current.runtime_epoch !== target.runtime_epoch
        || current.process.agent_id !== target.process.agent_id) throw new Error("Session changed. Close saved messages and open them again.");
      entry.state = { loading: false, page, hasNewer: entry.positions.length > 1 };
    } catch (error) {
      if (entries.get(id) !== entry || entry.request !== request) return;
      entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : "Saved messages could not be loaded." };
    }
    notify();
  };
  return {
    supported,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: (id) => entries.get(id)?.state,
    open(id) {
      if (!supported(id) || entries.has(id) || entries.size >= 8) return;
      const entry: Entry = { state: { loading: true, hasNewer: false }, positions: [undefined] };
      entries.set(id, entry);
      cover(id, true);
      void load(id, entry);
    },
    close(id) {
      if (!entries.delete(id)) return;
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
