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

export type QuickActionDraft = {
  text?: string;
  /** Ids only: each restore reloads its preview, which can be megabytes. */
  attachmentIds?: string[];
};

type QuickActionMemory = {
  projectId?: string;
  lastAgentId?: QuickActionAgentId;
  /** Unsent drafts by Project id. The `""` entry is a draft an older composer
      saved for no particular Project; the first Project that opens claims it. */
  drafts?: Record<string, QuickActionDraft>;
  presets: Partial<Record<QuickActionAgentId, QuickActionAgentPreset>>;
};

const QUICK_ACTION_MEMORY_KEY = "termloop.quickAction.lastRun.v2";
const QUICK_ACTION_PROMPT_LIMIT = 32_768;
export { QUICK_ACTION_IMAGE_LIMIT };
const QUICK_ACTION_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AGENT_ID = /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u;
const MAX_REMEMBERED_AGENT_PRESETS = 32;
const MAX_REMEMBERED_DRAFTS = 32;
const PROJECT_ID_LIMIT = 512;
const UNCLAIMED_DRAFT = "";
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
    const candidate = parsed as { projectId?: unknown; lastAgentId?: unknown; drafts?: unknown; draft?: unknown; draftAttachmentIds?: unknown; draftAttachment?: unknown; presets?: unknown };
    const memory: QuickActionMemory = { presets: {} };
    if (typeof candidate.projectId === "string") memory.projectId = candidate.projectId;
    if (typeof candidate.lastAgentId === "string" && validAgentId(candidate.lastAgentId)) memory.lastAgentId = candidate.lastAgentId;
    const drafts: Record<string, QuickActionDraft> = {};
    if (candidate.drafts && typeof candidate.drafts === "object" && !Array.isArray(candidate.drafts)) {
      for (const [projectId, value] of Object.entries(candidate.drafts).slice(-MAX_REMEMBERED_DRAFTS)) {
        if (projectId.length > PROJECT_ID_LIMIT || !value || typeof value !== "object") continue;
        const entry = value as { text?: unknown; attachmentIds?: unknown };
        const draft = savedDraft(entry.text, entry.attachmentIds, undefined);
        if (draft) drafts[projectId] = draft;
      }
    }
    // An older composer kept one draft for every Project: it belongs to the
    // Project that last ran, or to whichever Project opens first.
    const legacy = savedDraft(candidate.draft, candidate.draftAttachmentIds, candidate.draftAttachment);
    const legacyOwner = memory.projectId ?? UNCLAIMED_DRAFT;
    if (legacy && !drafts[legacyOwner]) drafts[legacyOwner] = legacy;
    if (Object.keys(drafts).length) memory.drafts = drafts;
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

/** The unsent draft of one Project, or the unclaimed draft an older composer saved. */
export function readQuickActionDraft(
  projectId: string,
  storage?: Pick<Storage, "getItem">,
): QuickActionDraft {
  const drafts = readQuickActionMemory(storage).drafts ?? {};
  return drafts[projectId] ?? drafts[UNCLAIMED_DRAFT] ?? {};
}

export function rememberQuickActionDraft(
  projectId: string,
  text: string,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  try {
    updateProjectDraft(projectId, storage, (draft) => ({ ...draft, text }));
  } catch {
    // Draft persistence must never interrupt typing when storage is unavailable.
  }
}

export function rememberQuickActionAttachments(
  projectId: string,
  attachmentIds: readonly string[],
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  try {
    updateProjectDraft(projectId, storage, (draft) => ({ ...draft, attachmentIds: [...attachmentIds] }));
  } catch {
    // Attachment persistence must never interrupt the composer.
  }
}

/** A run consumes only its own Project's draft; other Projects keep theirs. */
export function rememberQuickActionRun(
  projectId: string,
  agentId: QuickActionAgentId,
  preset: QuickActionAgentPreset,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  const memory = readQuickActionMemory(storage);
  const drafts = otherDrafts(memory.drafts, projectId);
  storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
    projectId,
    lastAgentId: agentId,
    ...(Object.keys(drafts).length ? { drafts } : {}),
    presets: { ...memory.presets, [agentId]: preset },
  } satisfies QuickActionMemory));
}

function updateProjectDraft(
  projectId: string,
  storage: Pick<Storage, "getItem" | "setItem">,
  change: (draft: QuickActionDraft) => QuickActionDraft,
): void {
  if (!projectId || projectId.length > PROJECT_ID_LIMIT) return;
  const memory = readQuickActionMemory(storage);
  const { drafts: _priorDrafts, ...rest } = memory;
  const current = memory.drafts?.[projectId] ?? memory.drafts?.[UNCLAIMED_DRAFT] ?? {};
  const next = change(current);
  const draft = savedDraft(next.text, next.attachmentIds, undefined);
  // The changed Project moves last, so the bound drops the longest-untouched draft.
  const drafts = { ...otherDrafts(memory.drafts, projectId), ...(draft ? { [projectId]: draft } : {}) };
  const bounded = Object.fromEntries(Object.entries(drafts).slice(-MAX_REMEMBERED_DRAFTS));
  storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
    ...rest,
    ...(Object.keys(bounded).length ? { drafts: bounded } : {}),
  } satisfies QuickActionMemory));
}

/** Every draft but this Project's; the unclaimed draft is this Project's once it opens. */
function otherDrafts(drafts: QuickActionMemory["drafts"], projectId: string): Record<string, QuickActionDraft> {
  return Object.fromEntries(Object.entries(drafts ?? {})
    .filter(([id]) => id !== projectId && id !== UNCLAIMED_DRAFT));
}

function savedDraft(text: unknown, ids: unknown, legacyAttachment: unknown): QuickActionDraft | undefined {
  const draft: QuickActionDraft = {};
  if (typeof text === "string" && text && text.length <= QUICK_ACTION_PROMPT_LIMIT) draft.text = text;
  const attachmentIds = savedDraftAttachmentIds(ids, legacyAttachment);
  if (attachmentIds.length) draft.attachmentIds = attachmentIds;
  return draft.text || draft.attachmentIds ? draft : undefined;
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
