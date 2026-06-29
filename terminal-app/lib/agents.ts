import { type TerminalAgentSummary } from "./termloop-client";

export function pickDefaultAgent(
  agents: TerminalAgentSummary[]
): TerminalAgentSummary | null {
  return agents.find(agentMatchesCodex) ?? agents[0] ?? null;
}

function agentMatchesCodex(agent: TerminalAgentSummary): boolean {
  const values = [agent.id, agent.display_name, agent.executable_name];
  return values.some((value) => value?.toLowerCase().includes("codex"));
}

