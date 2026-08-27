export type PromptAsset = {
  id: string;
  title: string;
  category: string;
  version: number | undefined;
  canonicalBody: string;
  effectiveBody: string;
  customized: boolean;
  source?: "builtIn" | "project" | "worker" | "routine" | "provider";
  editable?: boolean;
  resettable?: boolean;
  /// Set only for a prompt this app stores in a file of its own: the exact path
  /// an Improve-with-agent launch hands its agent.
  overridePath?: string;
};

export const PROMPT_MAX_CHARACTERS = 256_000;

export function assistantInstructionsEditableSuffix(
  instructions: string,
  protectedInstructions: string,
): string | undefined {
  const normalized = instructions.trim();
  const protectedNormalized = protectedInstructions.trim();
  if (normalized === protectedNormalized) return "";
  return normalized.startsWith(`${protectedNormalized}\n\n`)
    ? normalized.slice(protectedNormalized.length + 2).trim()
    : undefined;
}

export function promptBodyError(body: string): string | undefined {
  if (!body.trim()) return "Prompt cannot be empty.";
  if (![...body].length || [...body].length > PROMPT_MAX_CHARACTERS) return `Prompt must be ${PROMPT_MAX_CHARACTERS.toLocaleString("en-US")} characters or fewer.`;
  return undefined;
}

/// What a catalog entry actually is, said in the user's terms: a built-in
/// template, a runtime message, a Routine's own instruction, or a provider
/// prompt TermLoop cannot observe. The rail and the editor label it the same
/// way, so the delivery is read once here rather than in each surface.
export function promptKind(prompt: PromptAsset): { label: string; className: string } {
  if (prompt.source === "builtIn") {
    const delivery = prompt.effectiveBody.match(/^- delivery: `([^`]+)`$/m)?.[1];
    if (delivery === "codexDeveloperInstructions" || delivery === "claudeAppendedSystemPrompt") {
      return { label: "Built-in system prompt", className: "system" };
    }
    if (delivery === "terminalInput") return { label: "Built-in runtime message", className: "runtime" };
    return { label: "Built-in template", className: "builtin" };
  }
  if (prompt.source === "routine") return {
    label: prompt.id.endsWith(".context") ? "Routine context" : "Routine instruction",
    className: "routine",
  };
  if (prompt.source === "provider") return { label: "Unobservable provider prompt", className: "provider" };
  if (prompt.id.endsWith(".initial") || prompt.id.endsWith(".wake")) return { label: "Runtime message", className: "runtime" };
  return { label: "System prompt", className: "system" };
}

/// Which Improve-with-agent launch a catalog entry can offer, if any. A stored
/// built-in prompt is a file the settings improver edits; the Steward, Worker,
/// and Routine instruction surfaces already have their own improvers; the
/// remaining entries are runtime projections nothing may rewrite.
export type PromptImproveTarget =
  | { kind: "settings"; id: string; name: string; path: string; content: string }
  | { kind: "assistant"; surface: "stewardInstructions" | "workerInstructions" | "routineInstructions"; ownerId: string | null };

export function promptImproveTarget(prompt: PromptAsset): PromptImproveTarget | undefined {
  if (prompt.source === "builtIn") {
    return prompt.overridePath
      ? { kind: "settings", id: prompt.id, name: prompt.title, path: prompt.overridePath, content: prompt.effectiveBody }
      : undefined;
  }
  if (prompt.id === "runtime.steward.instructions") {
    return { kind: "assistant", surface: "stewardInstructions", ownerId: null };
  }
  const worker = prompt.id.match(/^runtime\.worker\.([^.]+)\.instructions$/);
  if (worker?.[1]) return { kind: "assistant", surface: "workerInstructions", ownerId: worker[1] };
  const routine = prompt.id.match(/^runtime\.routine\.([^.]+)\.instructions$/);
  if (routine?.[1]) return { kind: "assistant", surface: "routineInstructions", ownerId: routine[1] };
  return undefined;
}
