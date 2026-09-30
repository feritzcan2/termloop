import { useState } from "react";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import { defaultAgentPermission, permissionLabel } from "../quick-action-memory.js";
import { quickActionShortcutUnavailable, type QuickActionShortcutDraft, type QuickActionShortcutSelection } from "../quick-action-shortcuts.js";
import { QuickActionShortcutEditor } from "./QuickActionShortcutEditor.js";

export function AgentShortcutSettings({ shortcut, capabilities, fixedProvider, save, close }: {
  shortcut: QuickActionShortcutDraft;
  capabilities: readonly AgentCapabilityDto[];
  fixedProvider: boolean;
  save(draft: QuickActionShortcutDraft): void;
  close(): void;
}) {
  const [selection, setSelection] = useState<QuickActionShortcutSelection>(() => ({ agentId: shortcut.agentId, model: shortcut.model, permission: shortcut.permission, reasoning: shortcut.reasoning }));
  const capability = capabilities.find((item) => item.agent_id === selection.agentId);
  const unavailable = quickActionShortcutUnavailable(selection, capabilities);
  const chooseProvider = (agentId: string) => {
    const next = capabilities.find((item) => item.agent_id === agentId);
    if (!next) return;
    const permission = defaultAgentPermission(agentId);
    setSelection({ agentId, model: next.models[0] ?? "default", permission: next.permissions.includes(permission) ? permission : next.permissions[0] ?? "default", reasoning: next.reasoning[0] ?? "default" });
  };
  return <div className="quick-action-layer" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <button className="quick-action-backdrop" type="button" aria-label="Dismiss shortcut settings" onClick={close} />
    <section className="quick-action agent-shortcut-settings" role="dialog" aria-modal="true" aria-labelledby="agent-shortcut-settings-title">
      <header className="quick-action-header"><strong id="agent-shortcut-settings-title">{fixedProvider ? `Configure ${capability?.label ?? selection.agentId}` : "Configure shortcut"}</strong></header>
      <div className="quick-action-options">
        <label className="agent"><span>PROVIDER</span><em>{capability?.label ?? selection.agentId}</em><select aria-label="Provider" value={selection.agentId} disabled={fixedProvider} onChange={(event) => chooseProvider(event.target.value)}>
          {!capability ? <option value={selection.agentId}>{selection.agentId}</option> : null}
          {capabilities.map((item) => <option key={item.agent_id} value={item.agent_id}>{item.label}</option>)}
        </select></label>
        <label><span>MODEL</span><em>{selection.model}</em><select aria-label="Model" value={selection.model} onChange={(event) => setSelection({ ...selection, model: event.target.value })}>{[...new Set([selection.model, ...capability?.models ?? []])].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>PERM</span><em>{permissionLabel(selection.agentId, selection.permission)}</em><select aria-label="Permission" value={selection.permission} onChange={(event) => setSelection({ ...selection, permission: event.target.value as QuickActionShortcutSelection["permission"] })}>{[...new Set([selection.permission, ...capability?.permissions ?? []])].map((value) => <option key={value} value={value}>{permissionLabel(selection.agentId, value)}</option>)}</select></label>
        <label><span>REASON</span><em>{selection.reasoning}</em><select aria-label="Reasoning" value={selection.reasoning} onChange={(event) => setSelection({ ...selection, reasoning: event.target.value as QuickActionShortcutSelection["reasoning"] })}>{[...new Set([selection.reasoning, ...capability?.reasoning ?? []])].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <QuickActionShortcutEditor selection={selection} initialName={shortcut.name} initialIcon={shortcut.icon} disabled={Boolean(unavailable)} editing save={save} close={close} />
      {unavailable ? <p className="shortcut-settings-error" role="status">{unavailable}</p> : null}
    </section>
  </div>;
}
