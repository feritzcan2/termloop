import { useEffect, useState } from "react";
import type { PlaybookEvaluatorSettingsDto } from "@termloop/contract/current";
import { QUICK_ACTION_AGENT_MODELS } from "../quick-action-memory.js";

export function PlaybookEvaluatorSettings(props: {
  settings: PlaybookEvaluatorSettingsDto;
  busy: boolean;
  save(settings: PlaybookEvaluatorSettingsDto): Promise<void>;
}) {
  const [draft, setDraft] = useState(props.settings);
  const { codexModel, claudeModel, permission } = props.settings;
  useEffect(() => { setDraft({ codexModel, claudeModel, permission }); }, [codexModel, claudeModel, permission]);
  const changed = draft.codexModel !== props.settings.codexModel
    || draft.claudeModel !== props.settings.claudeModel
    || draft.permission !== props.settings.permission;
  return <section className="ap-form ap-launch-settings" aria-label="Playbook evaluation forks">
    <div className="ap-editor">
      <div className="ap-editor-head"><label>Playbook evaluation forks</label></div>
      <p className="ap-hint">Choose the model and permissions for new evaluation forks. Each fork keeps its source agent’s provider and conversation. Changes apply to the next check.</p>
      <div className="ap-launch-fields">
        {(["codex", "claude"] as const).map((provider) => {
          const field = provider === "codex" ? "codexModel" : "claudeModel";
          const label = provider === "codex" ? "Codex model" : "Claude model";
          return <label key={provider}>{label}<select aria-label={`Playbook fork ${label}`} disabled={props.busy}
            value={draft[field] ?? "inherit"}
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value === "inherit" ? null : event.target.value })}>
            <option value="inherit">Inherit source model</option>
            {(QUICK_ACTION_AGENT_MODELS[provider] ?? ["default"]).map((model) => <option key={model} value={model}>{model === "default" ? "Conversation default" : model}</option>)}
          </select></label>;
        })}
        <label>Permission<select aria-label="Playbook fork permission" disabled={props.busy} value={draft.permission}
          onChange={(event) => setDraft({ ...draft, permission: event.target.value as PlaybookEvaluatorSettingsDto["permission"] })}>
          <option value="plan">Read only / plan</option>
          <option value="default">Ask</option>
          <option value="acceptEdits">Accept edits / auto</option>
          <option value="bypassPermissions">Bypass permissions</option>
        </select></label>
      </div>
      <div className="ap-actions"><button type="button" className="ap-btn primary" disabled={props.busy || !changed}
        onClick={() => void props.save(draft)}>Save fork settings</button></div>
    </div>
  </section>;
}
