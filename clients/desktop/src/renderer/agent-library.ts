import type { AgentLibraryEntry, AgentLibraryResult, AgentProfileCreateParams, AgentProfileUpdateParams } from "@termloop/contract/current";

export type AgentDraft = Omit<AgentProfileCreateParams, "expectedRevision">;

export interface AgentLibraryController {
  value: AgentLibraryResult | undefined;
  loading: boolean;
  error: string | undefined;
  reload(): void;
  create(draft: AgentDraft, expectedRevision: number): Promise<AgentLibraryEntry>;
  update(params: AgentProfileUpdateParams): Promise<void>;
  remove(id: string, expectedRevision: number): Promise<void>;
  favorite(id: string, favorite: boolean, expectedRevision: number): Promise<void>;
}

export function agentDraft(profile?: AgentLibraryEntry, duplicate = false): AgentDraft {
  return {
    name: profile ? (duplicate ? `${[...profile.name].slice(0, 75).join("")} copy` : profile.name) : "",
    description: profile?.description ?? "",
    category: profile?.category ?? "General",
    instructions: profile?.instructions ?? "",
    agentId: profile?.default_agent_id ?? "codex",
    model: profile?.default_model ?? "default",
    permission: profile?.permission ?? "plan",
    reasoning: profile?.default_reasoning ?? "default",
  };
}

export function agentGroups(profiles: readonly AgentLibraryEntry[], query: string) {
  const term = query.trim().toLocaleLowerCase("en-US");
  const visible = profiles.filter((profile) => [profile.name, profile.description, profile.category].join(" ").toLocaleLowerCase("en-US").includes(term));
  return [
    { name: "Favorites", profiles: visible.filter((profile) => profile.favorite) },
    { name: "Built-in", profiles: visible.filter((profile) => profile.source === "builtIn" && !profile.favorite) },
    { name: "My agents", profiles: visible.filter((profile) => profile.source === "personal" && !profile.favorite) },
  ];
}
