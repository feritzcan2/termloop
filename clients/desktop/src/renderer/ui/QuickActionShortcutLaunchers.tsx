import { useState } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import { quickActionShortcutSummary, quickActionShortcutUnavailable, type QuickActionShortcut } from "../quick-action-shortcuts.js";
import { Icon } from "./Icon.js";
import "./quick-action-shortcuts.css";

export function QuickActionShortcutLaunchers({ shortcuts, capabilities, disabled, launch, remove }: {
  shortcuts: readonly QuickActionShortcut[];
  capabilities: readonly AgentCapabilityDto[];
  disabled: boolean;
  launch(shortcut: QuickActionShortcut): Promise<unknown>;
  remove(id: string): void;
}) {
  const [error, setError] = useState<string>();
  return <>{shortcuts.map((shortcut) => {
    const unavailable = quickActionShortcutUnavailable(shortcut, capabilities);
    return <span className="quick-action-shortcut-launcher" key={shortcut.id}>
      <button type="button" className={`saved-agent-shortcut ${shortcut.agentId}`} aria-label={`New session: ${shortcut.name}`} title={`${shortcut.name}\n${quickActionShortcutSummary(shortcut)}${unavailable ? `\n${unavailable}` : ""}`} disabled={disabled || Boolean(unavailable)} onClick={() => {
        setError(undefined);
        void launch(shortcut).catch(() => setError("Could not launch shortcut."));
      }}><Icon name={shortcut.icon} /></button>
      <button type="button" className="remove-agent-shortcut" aria-label={`Remove shortcut: ${shortcut.name}`} title={`Remove ${shortcut.name}`} onClick={() => {
        try { remove(shortcut.id); setError(undefined); }
        catch { setError("Could not remove shortcut."); }
      }}><Icon name="close" /></button>
    </span>;
  })}{error ? <span className="shortcut-launch-error" role="alert">{error}</span> : null}</>;
}
