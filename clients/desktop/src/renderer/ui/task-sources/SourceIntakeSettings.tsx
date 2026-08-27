import { useState } from "react";

import type { TaskSourceDto } from "@termloop/contract/current";

import { TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX } from "../../task-sources.js";

export function SourceIntakeSettings({ source, busy, save }: {
  source: TaskSourceDto;
  busy: boolean;
  save(importPolicy: TaskSourceDto["importPolicy"], activeTaskLimit: number): void;
}) {
  const [importPolicy, setImportPolicy] = useState(source.importPolicy);
  const [activeTaskLimit, setActiveTaskLimit] = useState(source.autoImportActiveTaskLimit);
  const changed = importPolicy !== source.importPolicy
    || activeTaskLimit !== source.autoImportActiveTaskLimit;
  const validLimit = Number.isInteger(activeTaskLimit)
    && activeTaskLimit >= 1
    && activeTaskLimit <= TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX;

  return <section className="task-source-intake-settings" aria-label="Automatic import settings">
    <div className="task-source-intake-settings-head">
      <span>Automatic import</span>
      <strong>{importPolicy === "autoAdd" ? `Up to ${activeTaskLimit} active Tasks` : "Off · review first"}</strong>
    </div>
    <div className="task-source-intake-settings-controls">
      <label htmlFor={`task-source-intake-policy-${source.id}`}>Matching Jira issues</label>
      <select
        id={`task-source-intake-policy-${source.id}`}
        value={importPolicy}
        disabled={busy}
        onChange={(event) => setImportPolicy(event.target.value as TaskSourceDto["importPolicy"])}
      >
        <option value="review">Wait for review</option>
        <option value="autoAdd">Import automatically</option>
      </select>
      {importPolicy === "autoAdd" ? <>
        <label htmlFor={`task-source-intake-limit-${source.id}`}>Keep up to</label>
        <span className="task-source-intake-limit-control">
          <input
            id={`task-source-intake-limit-${source.id}`}
            type="number"
            min={1}
            max={TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX}
            step={1}
            value={activeTaskLimit}
            disabled={busy}
            onChange={(event) => setActiveTaskLimit(Number(event.target.value))}
          />
          <strong>active Tasks</strong>
        </span>
      </> : null}
      <button
        type="button"
        className="primary-button"
        disabled={busy || !changed || !validLimit}
        onClick={() => save(importPolicy, activeTaskLimit)}
      >{busy ? "Saving…" : "Save automation"}</button>
    </div>
    <p>{importPolicy === "autoAdd"
      ? `When this source has fewer than ${activeTaskLimit} open, unarchived Tasks, the next refresh imports matching Jira issues until it reaches the limit. Closing or archiving one frees a slot.`
      : "Matching Jira issues stay in the review queue until you import them."}</p>
  </section>;
}
