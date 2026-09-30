import { useState } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import { quickActionShortcutSummary, quickActionShortcutUnavailable, type QuickActionShortcut } from "../quick-action-shortcuts.js";
import { Icon } from "./Icon.js";
import { AgentLaunchButton } from "./AgentLaunchButton.js";
import { QuickActionShortcutIcon, shortcutColorStyle } from "./QuickActionShortcutIcon.js";
import "./quick-action-shortcuts.css";

export function QuickActionShortcutLaunchers({ shortcuts, capabilities, disabled, launch, remove, configure }: {
  shortcuts: readonly QuickActionShortcut[];
  capabilities: readonly AgentCapabilityDto[];
  disabled: boolean;
  launch(shortcut: QuickActionShortcut): Promise<unknown>;
  remove(id: string): void;
  configure?: ((shortcut: QuickActionShortcut) => void) | undefined;
}) {
  const [error, setError] = useState<string>();
  return <>{shortcuts.map((shortcut) => {
    const unavailable = quickActionShortcutUnavailable(shortcut, capabilities);
    return <span className="quick-action-shortcut-launcher" key={shortcut.id}>
      <AgentLaunchButton type="button" className="saved-agent-shortcut" style={shortcutColorStyle(shortcut.icon)} configure={configure ? () => configure(shortcut) : undefined} aria-label={`New session: ${shortcut.name}`} title={`${shortcut.name}\n${quickActionShortcutSummary(shortcut)}${unavailable ? `\n${unavailable}` : ""}${configure ? "\nHold or right-click to configure" : ""}`} disabled={disabled} aria-disabled={Boolean(unavailable) || disabled} onClick={() => {
        if (unavailable) return;
        setError(undefined);
        void launch(shortcut).catch(() => setError("Could not launch shortcut."));
      }}><QuickActionShortcutIcon agentId={shortcut.agentId} icon={shortcut.icon} /></AgentLaunchButton>
      <button type="button" className="remove-agent-shortcut" aria-label={`Remove shortcut: ${shortcut.name}`} title={`Remove ${shortcut.name}`} onClick={() => {
        try { remove(shortcut.id); setError(undefined); }
        catch { setError("Could not remove shortcut."); }
      }}><Icon name="close" /></button>
    </span>;
  })}{error ? <span className="shortcut-launch-error" role="alert">{error}</span> : null}</>;
}
