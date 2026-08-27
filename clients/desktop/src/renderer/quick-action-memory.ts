import type { QuickActionImageHandle } from "../quick-action-image.js";
import { connectionAttachmentIdentity } from "../connection-scope.js";

export type QuickActionAgentId = string;
export type QuickActionPermission = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type QuickActionReasoning = "default" | "low" | "medium" | "high" | "xhigh" | "max";

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
  draftAttachment?: QuickActionImageHandle;
  presets: Partial<Record<QuickActionAgentId, QuickActionAgentPreset>>;
};

const QUICK_ACTION_MEMORY_KEY = "termloop.quickAction.lastRun.v2";
const QUICK_ACTION_PROMPT_LIMIT = 32_768;
const QUICK_ACTION_PREVIEW_LIMIT = 2 * 1024 * 1024;
const QUICK_ACTION_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const QUICK_ACTION_IMAGE_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const AGENT_ID = /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u;
const MAX_REMEMBERED_AGENT_PRESETS = 32;
export const QUICK_ACTION_AGENT_MODELS: Readonly<Record<QuickActionAgentId, readonly string[]>> = {
  claude: ["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"],
  codex: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro"],
  gemini: ["default", "auto", "pro", "flash", "flash-lite"],
};
export const QUICK_ACTION_AGENT_PERMISSIONS: readonly QuickActionPermission[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const QUICK_ACTION_AGENT_REASONING: readonly QuickActionReasoning[] = ["default", "low", "medium", "high", "xhigh", "max"];

export function readQuickActionMemory(storage?: Pick<Storage, "getItem">): QuickActionMemory {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!source) return { presets: {} };
    const parsed = JSON.parse(source.getItem(QUICK_ACTION_MEMORY_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return { presets: {} };
    const candidate = parsed as { projectId?: unknown; lastAgentId?: unknown; draft?: unknown; draftAttachment?: unknown; presets?: unknown };
    const memory: QuickActionMemory = { presets: {} };
    if (typeof candidate.projectId === "string") memory.projectId = candidate.projectId;
    if (typeof candidate.lastAgentId === "string" && validAgentId(candidate.lastAgentId)) memory.lastAgentId = candidate.lastAgentId;
    if (typeof candidate.draft === "string" && candidate.draft.length <= QUICK_ACTION_PROMPT_LIMIT) memory.draft = candidate.draft;
    if (validDraftAttachment(candidate.draftAttachment)) memory.draftAttachment = candidate.draftAttachment;
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
          || !QUICK_ACTION_AGENT_REASONING.includes(values.reasoning as QuickActionReasoning)) continue;
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

export function rememberQuickActionAttachment(
  draftAttachment: QuickActionImageHandle | undefined,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): void {
  try {
    const memory = readQuickActionMemory(storage);
    const { draftAttachment: _priorAttachment, ...rest } = memory;
    storage.setItem(QUICK_ACTION_MEMORY_KEY, JSON.stringify({
      ...rest,
      ...(draftAttachment ? { draftAttachment } : {}),
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

function validDraftAttachment(value: unknown): value is QuickActionImageHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<QuickActionImageHandle>;
  const identity = typeof handle.id === "string" ? connectionAttachmentIdentity(handle.id) : undefined;
  return Boolean((identity && QUICK_ACTION_IMAGE_ID.test(identity.entityId))
      || (typeof handle.id === "string" && QUICK_ACTION_IMAGE_ID.test(handle.id)))
    && handle.mediaType === "image/png"
    && typeof handle.byteLength === "number" && Number.isInteger(handle.byteLength) && handle.byteLength > 0 && handle.byteLength <= 10 * 1024 * 1024
    && typeof handle.sha256 === "string" && QUICK_ACTION_IMAGE_SHA256.test(handle.sha256)
    && typeof handle.width === "number" && Number.isInteger(handle.width) && handle.width > 0 && handle.width <= 16_384
    && typeof handle.height === "number" && Number.isInteger(handle.height) && handle.height > 0 && handle.height <= 16_384
    && typeof handle.previewDataUrl === "string"
    && handle.previewDataUrl.startsWith("data:image/png;base64,")
    && handle.previewDataUrl.length <= QUICK_ACTION_PREVIEW_LIMIT;
}

function validAgentId(value: string): boolean {
  return value.length <= 64 && AGENT_ID.test(value);
}

function defaultAgentPreset(agentId: QuickActionAgentId): QuickActionAgentPreset {
  return { model: "default", permission: defaultAgentPermission(agentId), reasoning: "default" };
}
