import { useState, type FormEvent } from "react";
import type { AgentCapabilityDto, AgentLibraryEntry } from "@termloop/contract/current";
import { agentDraft, type AgentDraft, type AgentLibraryController } from "../agent-library.js";
import { permissionLabel, type QuickActionPermission } from "../quick-action-memory.js";
import { Icon } from "./Icon.js";

export function AgentProfilePanel({ profile, duplicate, library, capabilities, canRun, open, copy, run, close }: {
  profile: AgentLibraryEntry | undefined;
  duplicate: boolean;
  library: AgentLibraryController;
  capabilities: readonly AgentCapabilityDto[];
  canRun: boolean;
  open(id: string): void;
  copy(id: string): void;
  run(id: string): void;
  close(): void;
}) {
  const [draft, setDraft] = useState(() => agentDraft(profile, duplicate));
  const [savedVersion, setSavedVersion] = useState(profile?.version);
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const creating = !profile || duplicate;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const capability = capabilities.find((entry) => entry.agent_id === draft.agentId);
  const choices = capabilities.filter((entry) => ["claude", "codex"].includes(entry.agent_id));
  const revision = library.value?.revision;
  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || revision === undefined) return;
    void act(async () => {
      if (new TextEncoder().encode(draft.instructions).length > 32768) throw new Error("Instructions must fit within 32 KB. Shorten the instructions before saving.");
      if (creating) {
        const created = await library.create(draft, revision);
        open(created.id);
      } else {
        if (profile.version !== savedVersion) throw new Error("This agent changed elsewhere. Reload its current version before saving.");
        await library.update({ ...draft, id: profile.id, expectedRevision: revision });
        setSavedVersion(profile.version + 1); setBaseline(draft);
      }
    });
  };
  const reloadDraft = () => {
    const next = agentDraft(profile, duplicate);
    setDraft(next); setBaseline(next); setSavedVersion(profile?.version); setError(undefined);
  };
  return <form className="stage-editor agent-profile-editor" aria-label={creating ? "New agent" : `${profile.name} agent`} onSubmit={save} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); save(); }
  }}>
    <header className="stage-editor-head">
      <div className="stage-editor-title"><span>{creating ? "My agents" : profile.source === "builtIn" ? "Built-in agent" : "My agents"}</span><h2>{creating ? "Create agent" : profile.name}</h2><p>{creating ? "Save a role you can use across projects." : profile.description}</p></div>
      <div className="stage-editor-actions">
        {!creating ? <>
          <button className="secondary-button" type="button" aria-label={profile.favorite ? "Remove agent from favorites" : "Add agent to favorites"} aria-pressed={profile.favorite} disabled={busy || revision === undefined} onClick={() => void act(() => library.favorite(profile.id, !profile.favorite, revision!))}>{profile.favorite ? "★ Favorited" : "☆ Favorite"}</button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => copy(profile.id)}>Duplicate</button>
          <button className="primary-button" type="button" disabled={busy || dirty || !canRun} title={dirty ? "Save changes before running" : !canRun ? "Open a project with an available provider" : "Run in a new session"} onClick={() => run(profile.id)}>Run</button>
        </> : null}
        <button className="primary-button" type="submit" disabled={busy || revision === undefined || (!creating && !dirty)}>{busy ? "Saving…" : creating ? "Create agent" : "Save"}</button>
        <button className="icon-button quiet" type="button" aria-label="Close agent" onClick={close}><Icon name="close" /></button>
      </div>
    </header>
    {error ? <p role="alert" className="settings-rail-error">{error}</p> : null}
    {profile && !creating && profile.version !== savedVersion ? <p className="agent-profile-notice">A newer version of this agent is available. <button type="button" onClick={reloadDraft}>Load current version</button></p> : null}
    <div className="agent-profile-fields">
      <label>Name<input value={draft.name} maxLength={80} required disabled={busy} onChange={(event) => set("name", event.target.value)} placeholder="e.g. Release reviewer" /></label>
      <label>Category<input value={draft.category} maxLength={40} required disabled={busy} onChange={(event) => set("category", event.target.value)} /></label>
      <label className="agent-profile-wide">Description<input value={draft.description} maxLength={240} required disabled={busy} onChange={(event) => set("description", event.target.value)} placeholder="What does this agent help with?" /></label>
      <label>Provider<select value={draft.agentId} disabled={busy} onChange={(event) => {
        const agentId = event.target.value as AgentDraft["agentId"];
        const next = capabilities.find((entry) => entry.agent_id === agentId);
        setDraft((current) => ({ ...current, agentId, model: "default", reasoning: "default", permission: next?.permissions.includes(current.permission) ? current.permission : "default" }));
      }}>{(["codex", "claude"] as const).map((id) => <option key={id} value={id}>{choices.find((entry) => entry.agent_id === id)?.label ?? id}</option>)}</select></label>
      <label>Model<select value={draft.model} disabled={busy} onChange={(event) => set("model", event.target.value)}>{[...new Set([draft.model, ...(capability?.models ?? ["default"])])].map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
      <label>Working mode<select value={draft.permission} disabled={busy} onChange={(event) => set("permission", event.target.value as AgentDraft["permission"])}>{[...new Set([draft.permission, ...(capability?.permissions ?? ["plan", "default"])])].map((permission) => <option key={permission} value={permission}>{permission === "plan" ? "Review only" : permissionLabel(draft.agentId, permission as QuickActionPermission)}</option>)}</select></label>
      <label>Reasoning<select value={draft.reasoning} disabled={busy} onChange={(event) => set("reasoning", event.target.value as AgentDraft["reasoning"])}>{[...new Set([draft.reasoning, ...(capability?.reasoning ?? ["default"])])].map((reasoning) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}</select></label>
      <label className="agent-profile-wide">Instructions<textarea value={draft.instructions} maxLength={32768} required disabled={busy} onChange={(event) => set("instructions", event.target.value)} placeholder="Describe the agent’s role, how it should work, and the result it should produce." spellCheck={false} /></label>
    </div>
    <footer className="agent-profile-footer"><span>{[...draft.instructions].length.toLocaleString("en-US")} characters · 32 KB maximum · Changes apply to new sessions.</span>
      {!creating && profile.source === "personal" ? deleting ? <span>Delete this agent? <button type="button" disabled={busy || revision === undefined} onClick={() => void act(async () => { await library.remove(profile.id, revision!); close(); })}>Delete</button> <button type="button" onClick={() => setDeleting(false)}>Cancel</button></span> : <button type="button" onClick={() => setDeleting(true)}>Delete agent</button> : null}
    </footer>
  </form>;
}
