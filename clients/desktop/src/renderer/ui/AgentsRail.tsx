import { useState } from "react";
import type { AgentLibraryController } from "../agent-library.js";
import { agentGroups } from "../agent-library.js";
import { Icon } from "./Icon.js";
import { RailGroup, RailRow } from "./RailGroup.js";

export function AgentsRail({ library, selectedId, open, create }: {
  library: AgentLibraryController;
  selectedId: string | undefined;
  open(id: string): void;
  create(): void;
}) {
  const [query, setQuery] = useState("");
  const groups = agentGroups(library.value?.profiles ?? [], query);
  return <nav className="settings-rail agents-rail" aria-label="Agent library">
    <div className="settings-rail-toolbar">
      <label className="rail-search"><Icon name="search" /><input aria-label="Search agents" placeholder="Search agents" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="icon-button quiet" type="button" aria-label="Reload agents" disabled={library.loading} onClick={library.reload}><Icon name="restart" /></button>
      <button className="icon-button quiet" type="button" aria-label="New agent" disabled={!library.value} onClick={create}><Icon name="add" /></button>
    </div>
    <p className="settings-rail-note"><Icon name="sparkles" /><span>Reusable agents for every project on this connection.</span></p>
    {library.error ? <p role="alert" className="settings-rail-error">Could not load agents: {library.error}</p> : null}
    {groups.map((group) => <RailGroup key={group.name} label={group.name} count={group.profiles.length}>
      {group.profiles.map((profile) => <RailRow key={profile.id} label={profile.name} detail={profile.description} selected={profile.id === selectedId} open={() => open(profile.id)} />)}
      {!group.profiles.length && !query && group.name === "My agents" ? <button type="button" className="agent-library-empty-action" disabled={!library.value} onClick={create}>Create your first agent</button> : null}
    </RailGroup>)}
    {library.loading && !library.value ? <span className="settings-rail-empty">Loading agents…</span> : null}
    {query && groups.every((group) => !group.profiles.length) ? <span className="settings-rail-empty">No agents match this search.</span> : null}
  </nav>;
}
