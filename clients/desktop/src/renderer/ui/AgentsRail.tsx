import { useState } from "react";
import type { AgentLibraryController } from "../agent-library.js";
import { agentGroups } from "../agent-library.js";
import { Icon } from "./Icon.js";
import { RailGroup, RailRow } from "./RailGroup.js";

export function AgentsRail({ library, selectedId, open, create, creator }: {
  library: AgentLibraryController;
  selectedId: string | undefined;
  open(id: string): void;
  create(): void;
  creator?: { available: boolean; start(): Promise<string | undefined>; setup(): void };
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatorError, setCreatorError] = useState<string>();
  const startCreator = async () => {
    if (!creator?.available || creating) return;
    setCreating(true); setCreatorError(undefined);
    try { setCreatorError(await creator.start()); }
    catch (cause) { setCreatorError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCreating(false); }
  };
  const groups = agentGroups(library.value?.profiles ?? [], query);
  return <nav className="settings-rail agents-rail" aria-label="Agent library">
    <div className="settings-rail-toolbar">
      <label className="rail-search"><Icon name="search" /><input aria-label="Search agents" placeholder="Search agents" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="icon-button quiet" type="button" aria-label="Reload agents" disabled={library.loading} onClick={library.reload}><Icon name="restart" /></button>
      <button className="icon-button quiet" type="button" aria-label="New agent" disabled={!library.value} onClick={create}><Icon name="add" /></button>
    </div>
    <p className="settings-rail-note"><Icon name="sparkles" /><span>Reusable agents for every project on this connection.</span></p>
    {creator ? <div className="agent-creator-card">
      <span className="agent-action-split">
        <button type="button" className="ap-btn ap-improve agent-action-main" disabled={!creator.available || creating || !library.value} onClick={() => void startCreator()} title={creator.available ? "Create an agent together, or continue your previous conversation" : "Open a Project to use Agent Creator"}><Icon name="sparkles" />{creating ? "Opening…" : "Agent Creator"}</button>
        <button type="button" className="ap-btn ap-improve-setup agent-action-setup" disabled={!creator.available || creating} onClick={creator.setup} title="Choose provider, model, working mode, and reasoning">Setup <span aria-hidden="true">▾</span></button>
      </span>
      <p>Describe a role and build it together.</p>
      {creatorError ? <p role="alert" className="settings-rail-error">{creatorError}</p> : null}
    </div> : null}
    {library.error ? <p role="alert" className="settings-rail-error">Could not load agents: {library.error}</p> : null}
    {groups.map((group) => <RailGroup key={group.name} label={group.name} count={group.profiles.length}>
      {group.profiles.map((profile) => <RailRow key={profile.id} label={profile.name} detail={profile.description} selected={profile.id === selectedId} open={() => open(profile.id)} />)}
      {!group.profiles.length && !query && group.name === "My agents" ? <button type="button" className="agent-library-empty-action" disabled={!library.value} onClick={create}>Create your first agent</button> : null}
    </RailGroup>)}
    {library.loading && !library.value ? <span className="settings-rail-empty">Loading agents…</span> : null}
    {query && groups.every((group) => !group.profiles.length) ? <span className="settings-rail-empty">No agents match this search.</span> : null}
  </nav>;
}
