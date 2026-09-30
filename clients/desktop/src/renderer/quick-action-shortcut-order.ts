import { QUICK_ACTION_AGENT_REASONING } from "./quick-action-memory.js";
import type { QuickActionShortcut } from "./quick-action-shortcuts.js";

const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const modelTiers: Readonly<Record<string, readonly RegExp[]>> = {
  codex: [/-nano\b|-luna\b/u, /-mini\b|-terra\b/u, /-sol\b|^gpt-[\d.]+$/u, /-pro\b/u, /-astra\b/u],
  claude: [/\bhaiku\b/u, /\bsonnet\b/u, /\bfable\b/u, /\bopus\b(?!\[1m\])/u, /\bopus\[1m\]/u],
  gemini: [/\bflash-lite\b/u, /\bflash\b/u, /\bpro\b/u],
};

function modelTier(agentId: string, model: string): number {
  if (model === "default" || model === "auto") return -1;
  const name = model.toLowerCase().split("/").at(-1)!;
  // OpenCode and other launchers can expose these families with a provider prefix.
  const family = name.startsWith("gpt-") ? "codex"
    : name.startsWith("claude-") ? "claude"
      : name.startsWith("gemini-") ? "gemini" : agentId;
  const tier = modelTiers[family]?.findIndex((pattern) => pattern.test(name)) ?? -1;
  // Unknown model families have no size metadata; use their natural name order.
  return tier < 0 ? 100 : tier;
}

function compareShortcuts(left: QuickActionShortcut, right: QuickActionShortcut): number {
  return modelTier(left.agentId, left.model) - modelTier(right.agentId, right.model)
    || naturalOrder.compare(left.model, right.model)
    || QUICK_ACTION_AGENT_REASONING.indexOf(left.reasoning) - QUICK_ACTION_AGENT_REASONING.indexOf(right.reasoning);
}

/** Keep the existing provider order, including saved providers missing on this connection. */
export function groupQuickActionShortcuts(
  shortcuts: readonly QuickActionShortcut[],
  providerIds: readonly string[] = [],
): { agentId: string; shortcuts: QuickActionShortcut[] }[] {
  const groups = new Map(providerIds.map((agentId) => [agentId, [] as QuickActionShortcut[]]));
  for (const shortcut of shortcuts) {
    const group = groups.get(shortcut.agentId) ?? [];
    group.push(shortcut);
    groups.set(shortcut.agentId, group);
  }
  return [...groups].map(([agentId, items]) => ({ agentId, shortcuts: items.sort(compareShortcuts) }));
}
