import type { CSSProperties } from "react";
import { QUICK_ACTION_SHORTCUT_ICONS, type QuickActionShortcutIcon as ShortcutColor } from "../quick-action-shortcuts.js";
import { Icon, agentIconName } from "./Icon.js";

export function shortcutColorStyle(icon: ShortcutColor): CSSProperties {
  return { "--shortcut-icon-color": QUICK_ACTION_SHORTCUT_ICONS.find((choice) => choice.id === icon)!.color } as CSSProperties;
}

export function QuickActionShortcutIcon({ agentId, icon }: { agentId: string; icon: ShortcutColor }) {
  return <Icon name={agentIconName(agentId)} className="shortcut-provider-icon" style={shortcutColorStyle(icon)} />;
}
