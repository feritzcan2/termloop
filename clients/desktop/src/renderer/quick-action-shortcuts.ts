import { agentReasoningOptions } from "./agent-reasoning.js";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import {
  QUICK_ACTION_AGENT_PERMISSIONS,
  ALL_AGENT_REASONING,
  permissionLabel,
  type QuickActionAgentPreset,
} from "./quick-action-memory.js";

// Keep the stored IDs stable while presenting each choice as a provider logo color.
export const QUICK_ACTION_SHORTCUT_ICONS = [
  { id: "agent", label: "Cyan", color: "#59cde6" },
  { id: "claude", label: "Orange", color: "#e6a16c" },
  { id: "codex", label: "Blue", color: "#70aaff" },
  { id: "terminal", label: "Mint", color: "#6dd6a7" },
  { id: "sparkles", label: "Violet", color: "#a69afa" },
  { id: "star", label: "Gold", color: "#e9c36a" },
  { id: "search", label: "Coral", color: "#f28a96" },
  { id: "branch", label: "Teal", color: "#5ccbc4" },
  { id: "task", label: "Lilac", color: "#c797ef" },
  { id: "fileText", label: "Pink", color: "#e79bc6" },
  { id: "focus", label: "Silver", color: "#b6c8dc" },
  { id: "settings", label: "Lime", color: "#b6d774" },
] as const;

export type QuickActionShortcutIcon = typeof QUICK_ACTION_SHORTCUT_ICONS[number]["id"];
export type QuickActionShortcutSelection = QuickActionAgentPreset & { agentId: string };
export type QuickActionShortcutDraft = QuickActionShortcutSelection & { name: string; icon: QuickActionShortcutIcon };
export type QuickActionShortcut = QuickActionShortcutDraft & { id: string };

const STORAGE_KEY = "termloop.quickAction.shortcuts.v1";
const PROVIDER_STORAGE_KEY = "termloop.quickAction.providerShortcuts.v1";
export const MAX_QUICK_ACTION_SHORTCUTS = 12;
const boundedText = (value: unknown, limit: number): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);

function validShortcut(value: unknown): value is QuickActionShortcut {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QuickActionShortcut>;
  return boundedText(item.id, 80) && boundedText(item.name, 60)
    && boundedText(item.agentId, 64) && /^[a-z](?:[a-z0-9]|-[a-z0-9])*$/u.test(item.agentId)
    && boundedText(item.model, 80)
    && QUICK_ACTION_AGENT_PERMISSIONS.includes(item.permission!)
    && ALL_AGENT_REASONING.includes(item.reasoning!)
    && QUICK_ACTION_SHORTCUT_ICONS.some((icon) => icon.id === item.icon);
}

function readShortcuts(storage: Pick<Storage, "getItem"> | undefined, key: string, limit: number): QuickActionShortcut[] {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const raw = source?.getItem(key);
    if (!raw || raw.length > 32_768) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((item): item is QuickActionShortcut => {
      if (!validShortcut(item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, limit);
  } catch {
    return [];
  }
}

export function readQuickActionShortcuts(storage?: Pick<Storage, "getItem">): QuickActionShortcut[] {
  return readShortcuts(storage, STORAGE_KEY, MAX_QUICK_ACTION_SHORTCUTS);
}

export function readProviderShortcuts(storage?: Pick<Storage, "getItem">): QuickActionShortcut[] {
  return readShortcuts(storage, PROVIDER_STORAGE_KEY, 32).filter((item) => item.id === item.agentId);
}

export function saveProviderShortcut(draft: QuickActionShortcutDraft, storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage): QuickActionShortcut[] {
  const shortcut = shortcutFromDraft(draft.agentId, draft);
  const next = [...readProviderShortcuts(storage).filter((item) => item.agentId !== draft.agentId), shortcut];
  storage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function updateQuickActionShortcut(id: string, draft: QuickActionShortcutDraft, storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage): QuickActionShortcut[] {
  const shortcuts = readQuickActionShortcuts(storage);
  if (!shortcuts.some((item) => item.id === id)) throw new Error("This shortcut no longer exists.");
  const shortcut = shortcutFromDraft(id, draft);
  const next = shortcuts.map((item) => item.id === id ? shortcut : item);
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function shortcutFromDraft(id: string, draft: QuickActionShortcutDraft): QuickActionShortcut {
  const shortcut = { id, name: draft.name.trim(), icon: draft.icon, agentId: draft.agentId, model: draft.model, permission: draft.permission, reasoning: draft.reasoning };
  if (!validShortcut(shortcut)) throw new Error("Choose a name, color, and valid model settings.");
  return shortcut;
}

export function saveQuickActionShortcut(
  draft: QuickActionShortcutDraft,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): QuickActionShortcut[] {
  const shortcuts = readQuickActionShortcuts(storage);
  if (shortcuts.length >= MAX_QUICK_ACTION_SHORTCUTS) throw new Error("Remove a shortcut before adding another (maximum 12).");
  const shortcut = shortcutFromDraft(crypto.randomUUID(), draft);
  const next = [...shortcuts, shortcut];
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function removeQuickActionShortcut(
  id: string,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): QuickActionShortcut[] {
  const next = readQuickActionShortcuts(storage).filter((shortcut) => shortcut.id !== id);
  storage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function quickActionShortcutUnavailable(
  selection: QuickActionShortcutSelection,
  capabilities: readonly AgentCapabilityDto[],
): string | undefined {
  const capability = capabilities.find((candidate) => candidate.agent_id === selection.agentId);
  if (!capability?.available) return "Provider unavailable on this connection";
  if (!capability.models.includes(selection.model)) return "Model unavailable on this connection";
  if (!capability.permissions.includes(selection.permission)) return "Permission unavailable on this connection";
  if (!agentReasoningOptions(capability, selection.model).includes(selection.reasoning)) return "Reasoning unavailable on this connection";
  return undefined;
}

export function quickActionShortcutSummary(selection: QuickActionShortcutSelection): string {
  return `${selection.agentId} · ${selection.model} · ${permissionLabel(selection.agentId, selection.permission)} · ${selection.reasoning}`;
}
