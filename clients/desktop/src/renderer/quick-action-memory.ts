import { QUICK_ACTION_IMAGE_LIMIT } from "../quick-action-image.js";
import { connectionAttachmentIdentity } from "../connection-scope.js";

export type QuickActionAgentId = string;
export type QuickActionPermission = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type QuickActionReasoning = "default" | "low" | "medium" | "high" | "xhigh" | "max" | "none" | "thinking";

export type QuickActionAgentPreset = {
  model: string;
  permission: QuickActionPermission;
  reasoning: QuickActionReasoning;
};

export type QuickActionAgentSelection = QuickActionAgentPreset & {
  agentId: "claude" | "codex";
};

type QuickActionMemory = {
  projectId?: string;
  lastAgentId?: QuickActionAgentId;
  draft?: string;
  /** Ids only: each restore reloads its preview, which can be megabytes. */
  draftAttachmentIds?: string[];
  presets: Partial<Record<QuickActionAgentId, QuickActionAgentPreset>>;
};

const QUICK_ACTION_MEMORY_KEY = "termloop.quickAction.lastRun.v2";
const QUICK_ACTION_PROMPT_LIMIT = 32_768;
export { QUICK_ACTION_IMAGE_LIMIT };
const QUICK_ACTION_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_ID = /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u;
const MAX_REMEMBERED_AGENT_PRESETS = 32;
export const QUICK_ACTION_AGENT_MODELS: Readonly<Record<QuickActionAgentId, readonly string[]>> = {
  claude: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
  codex: ["default", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro"],
  gemini: ["default", "auto", "pro", "flash", "flash-lite"],
};
export const QUICK_ACTION_AGENT_PERMISSIONS: readonly QuickActionPermission[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const QUICK_ACTION_AGENT_REASONING: readonly QuickActionReasoning[] = ["default", "low", "medium", "high", "xhigh", "max"];

export const ALL_AGENT_REASONING: readonly QuickActionReasoning[] = [...QUICK_ACTION_AGENT_REASONING, "none", "thinking"];

export function readQuickActionMemory(storage?: Pick<Storage, "getItem">): QuickActionMemory {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return { presets: {} };
    const parsed = JSON.parse(source.getItem(QUICK_ACTION_MEMORY_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return { presets: {} };
    const candidate = parsed as { projectId?: unknown; lastAgentId?: unknown; draft?: unknown; draftAttachmentIds?: unknown; draftAttachment?: unknown; presets?: unknown };
    const memory: QuickActionMemory = { presets: {} };
    if (typeof candidate.projectId === "string") memory.projectId = candidate.projectId;
    if (typeof candidate.lastAgentId === "string" && validAgentId(candidate.lastAgentId)) memory.lastAgentId = candidate.lastAgentId;
    if (typeof candidate.draft === "string" && candidate.draft.length <= QUICK_ACTION_PROMPT_LIMIT) memory.draft = candidate.draft;
    const draftAttachmentIds = savedDraftAttachmentIds(candidate.draftAttachmentIds, candidate.draftAttachment);
    if (draftAttachmentIds.length) memory.draftAttachmentIds = draftAttachmentIds;
    if (candidate.presets && typeof candidate.presets === "object") {
      for (const [agentId, preset] of Object.entries(candidate.presets).slice(0, MAX_REMEMBERED_AGENT_PRESETS)) {
        if (!validAgentId(agentId)) continue;
        if (!preset || typeof preset !== "object") continue;
        const values = preset as { model?: unknown; permission?: unknown; reasoning?: unknown };
        if (typeof values.model !== "string"
          || values.model.length < 1
          || values.model.length > 80
          || /[\u0000-\u001f\u007f]/u.test(values.model)
          || !QUICK_ACTION_AGENT_PERMISSIONS.includes(values.permission as QuickActionPermission)
          || !ALL_AGENT_REASONING.includes(values.reasoning as QuickActionReasoning)) continue;
        memory.presets[agentId] = {
          model: values.model,
          permission: values.permission as QuickActionPermission,
          reasoning: values.reasoning as QuickActionReasoning,
        };
      }
    }
    return memory;
  } catch {
    return { presets: {} };
  }
}

export function readQuickActionPreset(agentId: QuickActionAgentId): QuickActionAgentPreset | undefined {
  return readQuickActionMemory().presets[agentId];
}

export function readLastQuickActionAgentSelection(
  storage?: Pick<Storage, "getItem">,
): QuickActionAgentSelection {
  const memory = readQuickActionMemory(storage);
  const agentId = memory.lastAgentId === "codex" ? "codex" : "claude";
  return {
    agentId,
    ...(memory.presets[agentId] ?? defaultAgentPreset(agentId)),
  };
}

/// Claude's own `default` mode asks before every edit, and TermLoop passes the
/// selection on every launch and resume, so an unconfigured Claude kept
/// reopening in manual permission mode. Claude defaults to auto instead; Codex
/// keeps its provider default.
export function defaultAgentPermission(agentId: QuickActionAgentId): QuickActionPermission {
  return agentId === "claude" ? "acceptEdits" : "default";
}

export function permissionLabel(agentId: QuickActionAgentId, permission: QuickActionPermission): string {
  if (permission === "acceptEdits") return "auto";
  if (permission === "bypassPermissions") return "bypass";
  if (permission === "default" && agentId === "claude") return "manual";
  return permission;
}

/// Task worktree launches do not have a prompt-composer step. On first use,
/// launch with the provider defaults instead of redirecting through the
/// Project-scoped Quick Action surface and losing the Task target.
export function readTaskAgentPreset(
  agentId: QuickActionAgentId,
  storage?: Pick<Storage, "getItem">,
): QuickActionAgentPreset {
  return readQuickActionMemory(storage).presets[agentId] ?? defaultAgentPreset(agentId);
}

export function rememberQuickActionDraft(
  draft: string,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  try {
    const memory = readQuickActionMemory(storage);
    const { draft: _priorDraft, ...rest } = memory;
    storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
      ...rest,
      ...(draft ? { draft } : {}),
    } satisfies QuickActionMemory));
  } catch {
    // Draft persistence must never interrupt typing when storage is unavailable.
  }
}

export function rememberQuickActionAttachments(
  draftAttachmentIds: readonly string[],
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  try {
    const memory = readQuickActionMemory(storage);
    const { draftAttachmentIds: _priorAttachments, ...rest } = memory;
    const ids = draftAttachmentIds.filter(validDraftAttachmentId).slice(0, QUICK_ACTION_IMAGE_LIMIT);
    storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
      ...rest,
      ...(ids.length ? { draftAttachmentIds: ids } : {}),
    } satisfies QuickActionMemory));
  } catch {
    // Attachment persistence must never interrupt the composer.
  }
}

export function rememberQuickActionRun(
  projectId: string,
  agentId: QuickActionAgentId,
  preset: QuickActionAgentPreset,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  const memory = readQuickActionMemory(storage);
  storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
    projectId,
    lastAgentId: agentId,
    presets: { ...memory.presets, [agentId]: preset },
  } satisfies QuickActionMemory));
}

/** Agent Setup shares provider presets with Quick Action, but is not a Quick
    Action run: it must not consume an unfinished prompt or pasted image. */
export function rememberAgentSetupSelection(
  projectId: string,
  agentId: QuickActionAgentId,
  preset: QuickActionAgentPreset,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  const memory = readQuickActionMemory(storage);
  storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
    ...memory,
    projectId,
    lastAgentId: agentId,
    presets: { ...memory.presets, [agentId]: preset },
  } satisfies QuickActionMemory));
}

/** Reads the saved id list, or the single handle an older composer saved. */
function savedDraftAttachmentIds(ids: unknown, legacy: unknown): string[] {
  const candidates = Array.isArray(ids)
    ? ids
    : legacy && typeof legacy === "object" ? [(legacy as { id?: unknown }).id] : [];
  const valid = candidates.filter((id): id is string => typeof id === "string" && validDraftAttachmentId(id));
  return [...new Set(valid)].slice(0, QUICK_ACTION_IMAGE_LIMIT);
}

function validDraftAttachmentId(id: string): boolean {
  const identity = connectionAttachmentIdentity(id);
  return Boolean(identity && QUICK_ACTION_IMAGE_ID.test(identity.entityId)) || QUICK_ACTION_IMAGE_ID.test(id);
}

function validAgentId(value: string): boolean {
  return value.length <= 64 && AGENT_ID.test(value);
}

function defaultAgentPreset(agentId: QuickActionAgentId): QuickActionAgentPreset {
  return { model: "default", permission: defaultAgentPermission(agentId), reasoning: "default" };
}
