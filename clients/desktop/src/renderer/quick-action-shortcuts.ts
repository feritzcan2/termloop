import type { AgentCapabilityDto } from "@termloop/contract/current";
import {
  QUICK_ACTION_AGENT_PERMISSIONS,
  QUICK_ACTION_AGENT_REASONING,
  permissionLabel,
  type QuickActionAgentPreset,
} from "./quick-action-memory.js";

export const QUICK_ACTION_SHORTCUT_ICONS = [
  { id: "agent", label: "Robot" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "terminal", label: "Terminal" },
  { id: "sparkles", label: "Sparkles" },
  { id: "star", label: "Star" },
  { id: "search", label: "Research" },
  { id: "branch", label: "Branch" },
  { id: "task", label: "Review" },
  { id: "fileText", label: "Writing" },
  { id: "focus", label: "Focus" },
  { id: "settings", label: "Settings" },
] as const;

export type QuickActionShortcutIcon = typeof QUICK_ACTION_SHORTCUT_ICONS[number]["id"];
export type QuickActionShortcutSelection = QuickActionAgentPreset & { agentId: string };
export type QuickActionShortcutDraft = QuickActionShortcutSelection & { name: string; icon: QuickActionShortcutIcon };
export type QuickActionShortcut = QuickActionShortcutDraft & { id: string };

const STORAGE_KEY = "termloop.quickAction.shortcuts.v1";
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
    && QUICK_ACTION_AGENT_REASONING.includes(item.reasoning!)
    && QUICK_ACTION_SHORTCUT_ICONS.some((icon) => icon.id === item.icon);
}

export function readQuickActionShortcuts(storage?: Pick<Storage, "getItem">): QuickActionShortcut[] {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const raw = source?.getItem(STORAGE_KEY);
    if (!raw || raw.length > 32_768) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((item): item is QuickActionShortcut => {
      if (!validShortcut(item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, MAX_QUICK_ACTION_SHORTCUTS);
  } catch {
    return [];
  }
}

export function saveQuickActionShortcut(
  draft: QuickActionShortcutDraft,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): QuickActionShortcut[] {
  const shortcuts = readQuickActionShortcuts(storage);
  if (shortcuts.length >= MAX_QUICK_ACTION_SHORTCUTS) throw new Error("Remove a shortcut before adding another (maximum 12).");
  const shortcut: QuickActionShortcut = {
    id: crypto.randomUUID(), name: draft.name.trim(), icon: draft.icon,
    agentId: draft.agentId, model: draft.model, permission: draft.permission, reasoning: draft.reasoning,
  };
  if (!validShortcut(shortcut)) throw new Error("Choose a name, icon, and valid model settings.");
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
  if (!capability?.available || !capability.quick_action_supported) return "Provider unavailable on this connection";
  if (!capability.models.includes(selection.model)) return "Model unavailable on this connection";
  if (!capability.permissions.includes(selection.permission)) return "Permission unavailable on this connection";
  if (!capability.reasoning.includes(selection.reasoning)) return "Reasoning unavailable on this connection";
  return undefined;
}

export function quickActionShortcutSummary(selection: QuickActionShortcutSelection): string {
  return `${selection.agentId} · ${selection.model} · ${permissionLabel(selection.agentId, selection.permission)} · ${selection.reasoning}`;
}
