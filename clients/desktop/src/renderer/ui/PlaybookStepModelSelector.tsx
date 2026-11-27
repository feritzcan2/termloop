import { useEffect, useState } from "react";
import type { PlaybookEvaluatorSettingsDto, PlaybookStepEvaluatorModelsDto } from "@termloop/contract/current";

import { QUICK_ACTION_AGENT_MODELS } from "../quick-action-memory.js";
import { playbookStepModelChoice, playbookStepModelIssue } from "./playbook-policy.js";
import "./playbook-check.css";

type Provider = "codex" | "claude";
const FIELDS = { codex: "codexModel", claude: "claudeModel" } as const;
const LABELS = { codex: "Codex model", claude: "Claude model" } as const;
const FOLLOW = "project";
const CUSTOM = "custom";

/** Which models this one Playbook step's evaluator launches with. The
    evaluator keeps the provider of the Agent it forks, so the step chooses a
    model per provider; a provider left on the Project setting follows the
    Project's Playbook evaluator settings. */
export function PlaybookStepModelSelector({
  models,
  projectSettings,
  busy,
  save,
}: {
  models: PlaybookStepEvaluatorModelsDto | null;
  projectSettings?: PlaybookEvaluatorSettingsDto | undefined;
  busy: boolean;
  save(models: PlaybookStepEvaluatorModelsDto | null): Promise<void>;
}) {
  const codexModel = models?.codexModel ?? null;
  const claudeModel = models?.claudeModel ?? null;
  const [draft, setDraft] = useState({ codexModel, claudeModel });
  // A model outside the catalog is edited as typed text.
  const [custom, setCustom] = useState<Record<Provider, boolean>>({
    codex: isCustom("codex", codexModel),
    claude: isCustom("claude", claudeModel),
  });
  useEffect(() => {
    setDraft({ codexModel, claudeModel });
    setCustom({ codex: isCustom("codex", codexModel), claude: isCustom("claude", claudeModel) });
  }, [codexModel, claudeModel]);
  const next = {
    codexModel: playbookStepModelChoice(draft.codexModel),
    claudeModel: playbookStepModelChoice(draft.claudeModel),
  };
  const issue = playbookStepModelIssue(next.codexModel) ?? playbookStepModelIssue(next.claudeModel);
  const changed = next.codexModel !== codexModel || next.claudeModel !== claudeModel;
  return <div className="ap-section ap-step-check">
    <span className="ap-label">Evaluator model for this step</span>
    <div className="ap-step-check-fields">
      {(["codex", "claude"] as const).map((provider) => {
        const field = FIELDS[provider];
        const value = draft[field];
        const selected = custom[provider] ? CUSTOM : value ?? FOLLOW;
        return <label key={provider}>{LABELS[provider]}
          <select aria-label={`Step evaluator ${LABELS[provider]}`} value={selected} disabled={busy}
            onChange={(event) => {
              const choice = event.target.value;
              setCustom({ ...custom, [provider]: choice === CUSTOM });
              setDraft({ ...draft, [field]: choice === FOLLOW ? null : choice === CUSTOM ? value ?? "" : choice });
            }}>
            <option value={FOLLOW}>{projectLabel(provider, projectSettings)}</option>
            {(QUICK_ACTION_AGENT_MODELS[provider] ?? []).map((model) => <option key={model} value={model}>
              {model === "default" ? "Conversation default" : model}
            </option>)}
            <option value={CUSTOM}>Custom…</option>
          </select>
          {custom[provider] ? <input type="text" aria-label={`Step evaluator custom ${LABELS[provider]}`}
            value={value ?? ""} disabled={busy} placeholder="Model name"
            onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} /> : null}
        </label>;
      })}
      <button type="button" className="ap-btn primary" disabled={busy || !changed || issue !== undefined}
        onClick={() => void save(next.codexModel === null && next.claudeModel === null ? null : next)}>Save</button>
    </div>
    <p className="ap-hint">{issue ?? "The evaluator keeps the provider of the Task Agent it forks; this step's model replaces the Project setting for that provider. Changes apply to the next check."}</p>
  </div>;
}

function isCustom(provider: Provider, model: string | null): boolean {
  return model !== null && !(QUICK_ACTION_AGENT_MODELS[provider] ?? []).includes(model);
}

function projectLabel(provider: Provider, settings: PlaybookEvaluatorSettingsDto | undefined): string {
  if (settings === undefined) return "Project setting";
  const model = settings[FIELDS[provider]];
  return `Project setting (${model === null ? "inherit source" : model === "default" ? "conversation default" : model})`;
}
