import type { ShellCommand } from "../command-surface.js";
import { sessionLabel, type Session } from "../model.js";

export function selectedAgentForkCommand(
  session: Session | undefined,
  unavailable: boolean,
  forkSession: (sessionId: string) => Promise<boolean>,
  repairProviderHistory: (sessionId: string) => void,
): ShellCommand {
  const disabled = unavailable || session?.kind !== "Agent" || !session.forkable;
  return {
    id: "session.fork",
    title: "Fork Selected Agent",
    detail: session ? sessionLabel(session) : "Select an Agent first.",
    group: "Session",
    keywords: ["fork", "conversation", "agent"],
    shortcutId: "forkSession",
    disabled,
    async perform() {
      if (disabled || !session) return;
      if (await forkSession(session.id)) repairProviderHistory(session.id);
    },
  };
}
