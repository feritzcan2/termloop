import { useState, type KeyboardEvent } from "react";
import type { PmSkill } from "@termloop/pm-contract/pm";
import { triggerText } from "./SkillsPanel.js";

export type SkillEdit = { name?: string; description?: string; instructions?: string };

/** The fields a save sends: only those the PM changed. */
function changes(skill: PmSkill, name: string, description: string, instructions: string): SkillEdit {
  const { manifest } = skill;
  return {
    ...(name !== manifest.name ? { name } : {}),
    ...(description !== manifest.description ? { description } : {}),
    ...(instructions !== manifest.instructions ? { instructions } : {}),
  };
}

/**
 * A skill as its SKILL.md, open in the stage: the frontmatter, then the
 * instructions its agent follows. The PM edits the name, description, and
 * instructions, and Save makes them live as the next version. What it
 * runs on, reads, and may call changes only through a reviewed revision;
 * a built-in skill is read-only.
 */
export function SkillFile(props: { skill: PmSkill; onSave(edit: SkillEdit): Promise<boolean> }) {
  const { skill } = props;
  const { manifest } = skill;
  const readOnly = skill.builtin !== null;
  const [name, setName] = useState(manifest.name);
  const [description, setDescription] = useState(manifest.description);
  const [instructions, setInstructions] = useState(manifest.instructions);
  const [saving, setSaving] = useState(false);
  const edit = changes(skill, name, description, instructions);
  const dirty = Object.keys(edit).length > 0;
  const blank = [name, description, instructions].some((text) => text.trim() === "");
  const save = async () => {
    if (!dirty || blank || saving) return;
    setSaving(true);
    await props.onSave(edit);
    setSaving(false);
  };
  const revert = () => {
    setName(manifest.name);
    setDescription(manifest.description);
    setInstructions(manifest.instructions);
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void save();
  };
  const fixed: [string, string][] = [
    ["runs", triggerText(manifest)],
    ["reads", manifest.sources.join(", ")],
    ["prefilter", manifest.prefilter],
    ...(manifest.approvedTools.length > 0 ? [["tools", manifest.approvedTools.join(", ")] as [string, string]] : []),
    ...(manifest.agentTools.length > 0 ? [["agent tools", manifest.agentTools.join(", ")] as [string, string]] : []),
    ...(manifest.channels.length > 0 ? [["channels", manifest.channels.map((channel) => `#${channel.name}`).join(", ")] as [string, string]] : []),
    ["version", String(skill.version)],
  ];
  return (
    <section className="pane skill-file" aria-label="SKILL.md" onKeyDown={keys}>
      <div className="pane-head">
        <b>SKILL.md</b>
        <span className="meta">{manifest.name} · v{skill.version}</span>
        {readOnly && <span className="chip">Built in · read-only</span>}
        <span className="sp" />
        {dirty && <span className="meta">Unsaved</span>}
        {!readOnly && (
          <>
            <button type="button" className="btn sm ghost" disabled={!dirty || saving} onClick={revert}>Revert</button>
            <button type="button" className="btn sm pri" disabled={!dirty || blank || saving} onClick={() => void save()}>
              {saving ? "Saving…" : `Save as v${skill.version + 1}`}
            </button>
          </>
        )}
      </div>
      <div className="body skill-file-body">
        <div className="skill-frontmatter">
          <span className="fm-rule">---</span>
          <label className="fm-row">
            <span className="fm-key">name:</span>
            <input aria-label="Name" value={name} maxLength={80} readOnly={readOnly} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="fm-row">
            <span className="fm-key">description:</span>
            <textarea aria-label="Description" rows={4} value={description} maxLength={500} readOnly={readOnly} onChange={(event) => setDescription(event.target.value)} />
          </label>
          {fixed.map(([key, value]) => (
            <div key={key} className="fm-row fixed">
              <span className="fm-key">{key}:</span>
              <span>{value}</span>
            </div>
          ))}
          <span className="fm-rule">---</span>
        </div>
        <textarea
          className="skill-instructions"
          aria-label="Instructions"
          spellCheck={false}
          value={instructions}
          maxLength={8000}
          readOnly={readOnly}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <p className="hint">
          {readOnly
            ? "A built-in skill ships with the app and cannot be edited."
            : "Saving makes the change live at once. What it runs on, reads, and may call changes through Revise, which you review with a dry run."}
        </p>
      </div>
    </section>
  );
}
