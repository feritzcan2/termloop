import { useCallback, useEffect, useState } from "react";

import type { SkillDefinitionDto } from "@termloop/contract/current";
import { ConfigurationVersions, useConfigurationVersions, type ConfigurationVersionActions } from "./PromptImprovement.js";
import { Icon } from "./Icon.js";

/**
 * Stage page that shows one skill's SKILL.md in an editable markdown surface.
 * Saves go through the daemon's stale-guarded definition command; a conflict
 * surfaces as an error and Reload fetches the current on-disk content.
 */
export function SkillEditorPanel({ skillId, load, save, versions, close }: {
  skillId: string;
  load(skillId: string): Promise<SkillDefinitionDto>;
  save(skillId: string, expectedContentSha256: string, content: string): Promise<SkillDefinitionDto>;
  versions?: ConfigurationVersionActions | undefined;
  close(): void;
}) {
  const [definition, setDefinition] = useState<SkillDefinitionDto>();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const versionController = useConfigurationVersions(
    versions,
    { kind: "settingsSkill", targetId: skillId },
    { watch: true, refreshKey: String(reloadToken) },
  );
  const reload = useCallback(() => setReloadToken((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void load(skillId).then((result) => {
      if (!active) return;
      setDefinition(result);
      setDraft(result.content);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, skillId, reloadToken]);

  const dirty = definition !== undefined && draft !== definition.content;

  const saveDraft = useCallback(async () => {
    if (!definition || saving || draft === definition.content) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await save(definition.skillId, definition.contentSha256, draft);
      setDefinition(result);
      setDraft(result.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [definition, draft, save, saving]);

  return (
    <section className="stage-editor" aria-label={definition ? `${definition.name} SKILL.md` : "Skill definition"}>
      <header className="stage-editor-head">
        <div className="stage-editor-title">
          <span>SKILL.md</span>
          <h2>{definition?.name ?? "Skill"}</h2>
          {definition ? <code title={definition.path}>{definition.path}</code> : null}
        </div>
        <div className="stage-editor-actions">
          {definition && !definition.editable ? <em className="stage-editor-readonly">Read only</em> : null}
          {dirty ? <button className="secondary-button" type="button" disabled={saving} onClick={reload}>Discard</button> : null}
          <button
            className="primary-button"
            type="button"
            disabled={!dirty || saving || !definition?.editable}
            onClick={() => void saveDraft()}
          >{saving ? "Saving…" : "Save"}</button>
          <button className="icon-button quiet" type="button" aria-label="Close skill editor" onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      {error ? <p className="settings-rail-error" role="alert">
        {error}
        <button className="secondary-button" type="button" onClick={reload}>Reload</button>
      </p> : null}
      {loading && !definition ? <p className="settings-rail-empty">Loading SKILL.md…</p> : null}
      {definition ? <textarea
        className="stage-editor-source"
        value={draft}
        spellCheck={false}
        readOnly={!definition.editable || saving}
        aria-label={`${definition.name} SKILL.md content`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void saveDraft();
          }
        }}
      /> : null}
      <ConfigurationVersions controller={versionController} reload={reload} />
    </section>
  );
}
