import type { QuickActionAgentSelection } from "./quick-action-memory.js";

/**
 * The launch selection last used with each saved agent profile. A profile's
 * library defaults stay the fallback; this per-viewer convenience only
 * remembers what the user actually ran it with, so reopening the profile
 * restores that provider, model, permission, and reasoning.
 */
const PROFILE_SELECTION_KEY = "termloop.quickAction.profileSelections.v1";
const MAX_REMEMBERED_PROFILES = 64;
const PROFILE_ID_LIMIT = 128;
const VALUE_LIMIT = 128;
const AGENT_IDS = new Set(["claude", "codex"]);
const PERMISSIONS = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
const REASONING = new Set(["default", "low", "medium", "high", "xhigh", "max", "none", "thinking"]);

type Storage = Pick<globalThis.Storage, "getItem">;
type WritableStorage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function readQuickActionProfileSelection(
  profileId: string,
  storage?: Storage,
): QuickActionAgentSelection | undefined {
  return readAll(storage)[profileId];
}

export function rememberQuickActionProfileSelection(
  profileId: string,
  selection: QuickActionAgentSelection,
  storage?: WritableStorage,
): void {
  try {
    const target = storage ?? window.localStorage;
    if (!validProfileId(profileId) || !validSelection(selection)) return;
    const { [profileId]: _prior, ...others } = readAll(target);
    const { agentId, model, permission, reasoning } = selection;
    // The changed profile moves last, so the bound drops the longest-unused one.
    const entries = [...Object.entries(others), [profileId, { agentId, model, permission, reasoning }] as const]
      .slice(-MAX_REMEMBERED_PROFILES);
    target.setItem(PROFILE_SELECTION_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Remembering a selection must never block a launch that already succeeded.
  }
}

function readAll(storage?: Storage): Record<string, QuickActionAgentSelection> {
  try {
    const source = storage ?? window.localStorage;
    const parsed = JSON.parse(source.getItem(PROFILE_SELECTION_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const selections: Record<string, QuickActionAgentSelection> = {};
    for (const [profileId, value] of Object.entries(parsed).slice(-MAX_REMEMBERED_PROFILES)) {
      if (validProfileId(profileId) && validSelection(value)) {
        const { agentId, model, permission, reasoning } = value;
        selections[profileId] = { agentId, model, permission, reasoning };
      }
    }
    return selections;
  } catch {
    return {};
  }
}

function validProfileId(profileId: string): boolean {
  return profileId.length > 0 && profileId.length <= PROFILE_ID_LIMIT;
}

function validSelection(value: unknown): value is QuickActionAgentSelection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof QuickActionAgentSelection, unknown>>;
  return typeof candidate.agentId === "string" && AGENT_IDS.has(candidate.agentId)
    && typeof candidate.model === "string" && candidate.model.length > 0 && candidate.model.length <= VALUE_LIMIT
    && typeof candidate.permission === "string" && PERMISSIONS.has(candidate.permission)
    && typeof candidate.reasoning === "string" && REASONING.has(candidate.reasoning);
}
