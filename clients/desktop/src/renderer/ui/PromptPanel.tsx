import { useCallback, useEffect, useState } from "react";

import { promptBodyError, promptKind, PROMPT_MAX_CHARACTERS, type PromptAsset } from "../prompt-settings.js";
import { Icon } from "./Icon.js";
import { ConfigurationVersions, useConfigurationVersions, type ConfigurationVersionActions } from "./PromptImprovement.js";

/// Stage page for one catalog prompt. Built-in edits are stored in this app
/// profile; runtime projections returned by Core are shown read only, because
/// nothing here owns them.
export function PromptPanel({ prompt, update, reset, apply, versions, reload, close }: {
  prompt: PromptAsset;
  update(id: string, body: string): Promise<PromptAsset[]>;
  reset(id: string): Promise<PromptAsset[]>;
  apply(prompts: PromptAsset[]): void;
  versions?: ConfigurationVersionActions | undefined;
  reload?: (() => void) | undefined;
  close(): void;
}) {
  const [draft, setDraft] = useState(prompt.effectiveBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const versionController = useConfigurationVersions(
    prompt.overridePath ? versions : undefined,
    { kind: "settingsPrompt", targetId: prompt.overridePath ?? prompt.id },
    { watch: true, refreshKey: prompt.effectiveBody },
  );

  useEffect(() => {
    setDraft(prompt.effectiveBody);
    setError(undefined);
  }, [prompt.effectiveBody, prompt.id]);

  const readOnly = prompt.editable === false;
  const dirty = draft !== prompt.effectiveBody;
  const kind = promptKind(prompt);

  const run = useCallback(async (action: () => Promise<PromptAsset[]>) => {
    setBusy(true);
    setError(undefined);
    try {
      apply(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const save = useCallback(() => {
    if (busy || readOnly || !dirty) return;
    const validationError = promptBodyError(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    void run(() => update(prompt.id, draft));
  }, [busy, dirty, draft, prompt.id, readOnly, run, update]);

  return (
    <section className="stage-editor" aria-label={`${prompt.title} prompt`}>
      <header className="stage-editor-head">
        <div className="stage-editor-title">
          <span>{prompt.category}{prompt.version ? ` · v${prompt.version}` : ""}</span>
          <h2>{prompt.title}</h2>
          <code>{prompt.id}</code>
        </div>
        <div className="stage-editor-actions">
          {readOnly ? <em className="stage-editor-readonly">Read only</em> : null}
          {prompt.customized && prompt.resettable !== false
            ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(() => reset(prompt.id))}>Reset</button>
            : null}
          <button className="primary-button" type="button" disabled={busy || readOnly || !dirty} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          <button className="icon-button quiet" type="button" aria-label="Close prompt" onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      <div className="stage-editor-facts">
        <div className="stage-editor-chips"><span className={`stage-editor-chip prompt-kind ${kind.className}`}>{kind.label}</span></div>
        <span>{readOnly
          ? "Runtime projection returned by Core"
          : prompt.source === "builtIn"
            ? (prompt.customized ? "Customized built-in prompt — stored in this app profile" : "Canonical built-in prompt")
            : "Project configuration prompt"}</span>
      </div>
      {error ? <p className="settings-rail-error" role="alert">{error}</p> : null}
      <textarea
        className="stage-editor-source"
        value={draft}
        maxLength={PROMPT_MAX_CHARACTERS}
        spellCheck={false}
        readOnly={readOnly || busy}
        aria-label={`${prompt.title} content`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="stage-editor-meta">
        <span>Provider-managed system prompts are not observable by TermLoop.</span>
        <code>{[...draft].length.toLocaleString("en-US")} / {PROMPT_MAX_CHARACTERS.toLocaleString("en-US")}</code>
      </div>
      <ConfigurationVersions controller={versionController} reload={reload ?? (() => undefined)} />
    </section>
  );
}
