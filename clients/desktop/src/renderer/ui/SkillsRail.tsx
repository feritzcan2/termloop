import { useEffect, useMemo, useState } from "react";

import type {
  SkillAgent,
  SkillAgentStateDto,
  SkillCatalogItemDto,
  SkillCatalogResult,
} from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import { RailGroup } from "./RailGroup.js";
import { useRailGroups } from "./rail-groups.js";

type SkillSection = "project" | "library" | "provider";

export type RemoteSkillComputer = {
  profileId: string;
  name: string;
  writable: boolean;
};

type SkillDisplayGroup = {
  key: string;
  name: string;
  description: string;
  skills: SkillCatalogItemDto[];
};

const sections: { id: SkillSection; label: string }[] = [
  { id: "project", label: "Project skills" },
  { id: "library", label: "Personal library" },
  { id: "provider", label: "Plugins & built-ins" },
];

function normalizedSkillName(name: string): string {
  return name.trim().toLocaleLowerCase("en-US");
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function sectionFor(skill: SkillCatalogItemDto): SkillSection {
  if (skill.scopes.includes("project")) return "project";
  if (skill.origins.some((origin) => origin === "plugin" || origin === "builtIn")) return "provider";
  return "library";
}

function agentLabel(agent: SkillAgent): string {
  return agent === "claude" ? "Claude" : "Codex";
}

function folderOf(skill: SkillCatalogItemDto): { label: string; path: string } {
  const location = skill.locations[0];
  if (!location) return { label: "Unfiled", path: "" };
  const trimmed = location.path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return { label: location.source, path: cut > 0 ? trimmed.slice(0, cut) : trimmed };
}

function groupByName(skills: SkillCatalogItemDto[]): SkillDisplayGroup[] {
  const groups = new Map<string, SkillCatalogItemDto[]>();
  for (const skill of skills) {
    const key = normalizedSkillName(skill.name);
    const existing = groups.get(key);
    if (existing) existing.push(skill);
    else groups.set(key, [skill]);
  }
  return [...groups.entries()].map(([key, grouped]) => {
    grouped.sort((left, right) =>
      (left.locations[0]?.path ?? "").localeCompare(right.locations[0]?.path ?? "", "en-US")
    );
    const descriptions = new Set(grouped.map((skill) => skill.description));
    return {
      key,
      name: grouped[0]?.name ?? "Unnamed skill",
      description: descriptions.size === 1
        ? grouped[0]?.description ?? "No description in SKILL.md."
        : `${grouped.length} entries share this name; open locations to compare.`,
      skills: grouped,
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "en-US"));
}

function groupByFolder(skillGroups: SkillDisplayGroup[]): { label: string; path: string; skillGroups: SkillDisplayGroup[] }[] {
  const groups = new Map<string, { label: string; path: string; skillGroups: SkillDisplayGroup[] }>();
  for (const skillGroup of skillGroups) {
    const representative = skillGroup.skills[0];
    const folder = representative ? folderOf(representative) : { label: "Unfiled", path: "" };
    const key = `${folder.label}\n${folder.path}`;
    const existing = groups.get(key);
    if (existing) existing.skillGroups.push(skillGroup);
    else groups.set(key, { ...folder, skillGroups: [skillGroup] });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "en-US"));
}

export function SkillsRail({
  load,
  setDeployment,
  openEditor,
  improveSkill,
  listRemoteComputers,
  loadRemoteCatalog,
  createRemoteSkill,
  disabled,
}: {
  load(): Promise<SkillCatalogResult>;
  setDeployment(skillId: string, agent: SkillAgent, deployed: boolean): Promise<SkillCatalogResult>;
  openEditor(skillId: string): void;
  /// Absent while no Project is open: the improver runs in a checkout.
  improveSkill?: ((skillId: string, name: string) => void) | undefined;
  listRemoteComputers?: (() => Promise<RemoteSkillComputer[]>) | undefined;
  loadRemoteCatalog?: ((profileId: string) => Promise<SkillCatalogResult>) | undefined;
  createRemoteSkill?: ((profileId: string, sourceSkillId: string) => Promise<SkillCatalogResult>) | undefined;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<SkillCatalogResult>();
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyChip, setBusyChip] = useState<string>();
  const [remoteComputers, setRemoteComputers] = useState<RemoteSkillComputer[]>([]);
  const [showRemoteComputers, setShowRemoteComputers] = useState(false);
  const [remoteCatalogs, setRemoteCatalogs] = useState<Record<string, SkillCatalogResult>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const [remoteListError, setRemoteListError] = useState<string>();
  const [busyRemoteChip, setBusyRemoteChip] = useState<string>();
  const folders = useRailGroups();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void load().then((result) => {
      if (active) setCatalog(result);
    }).catch((reason) => {
      if (active) setError(errorMessage(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, reloadToken]);

  useEffect(() => {
    if (!listRemoteComputers) {
      setRemoteComputers([]);
      setShowRemoteComputers(false);
      return;
    }
    let active = true;
    setRemoteListError(undefined);
    void listRemoteComputers().then((computers) => {
      if (!active) return;
      setRemoteComputers(computers);
      if (computers.length === 0) setShowRemoteComputers(false);
    }).catch((reason) => {
      if (!active) return;
      setRemoteComputers([]);
      setShowRemoteComputers(false);
      setRemoteListError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [listRemoteComputers, reloadToken]);

  useEffect(() => {
    if (!showRemoteComputers || !loadRemoteCatalog || remoteComputers.length === 0) return;
    let active = true;
    setRemoteCatalogs({});
    setRemoteErrors({});
    for (const computer of remoteComputers) {
      void loadRemoteCatalog(computer.profileId).then((result) => {
        if (active) setRemoteCatalogs((current) => ({ ...current, [computer.profileId]: result }));
      }).catch((reason) => {
        if (!active) return;
        setRemoteErrors((current) => ({ ...current, [computer.profileId]: errorMessage(reason) }));
      });
    }
    return () => { active = false; };
  }, [loadRemoteCatalog, remoteComputers, reloadToken, showRemoteComputers]);

  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleSections = useMemo(() => sections.map((section) => ({
    ...section,
    skillGroups: groupByName((catalog?.skills ?? []).filter((skill) => sectionFor(skill) === section.id))
      .filter((group) => {
        if (!normalizedQuery) return true;
        const haystack = group.skills.flatMap((skill) => [
          skill.name,
          skill.description,
          ...skill.locations.flatMap((location) => [location.path, location.source]),
        ]).join("\n").toLocaleLowerCase("en-US");
        return haystack.includes(normalizedQuery);
      }),
  })).filter((section) => section.id === "project" || section.skillGroups.length > 0), [catalog?.skills, normalizedQuery]);
  const remoteSkillNames = useMemo(() => new Map(
    Object.entries(remoteCatalogs).map(([profileId, remoteCatalog]) => [
      profileId,
      new Set(remoteCatalog.skills.map((skill) => normalizedSkillName(skill.name))),
    ]),
  ), [remoteCatalogs]);

  const changeDeployment = async (skill: SkillCatalogItemDto, agent: SkillAgent, deployed: boolean) => {
    setBusyChip(`${skill.id}:${agent}`);
    setActionError(undefined);
    try {
      setCatalog(await setDeployment(skill.id, agent, deployed));
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setBusyChip(undefined);
    }
  };

  const copyToRemoteComputer = async (skill: SkillCatalogItemDto, computer: RemoteSkillComputer) => {
    if (!createRemoteSkill) return;
    const key = `${computer.profileId}:${skill.id}`;
    setBusyRemoteChip(key);
    setActionError(undefined);
    try {
      const result = await createRemoteSkill(computer.profileId, skill.id);
      setRemoteCatalogs((current) => ({ ...current, [computer.profileId]: result }));
      setRemoteErrors((current) => {
        if (!(computer.profileId in current)) return current;
        const next = { ...current };
        delete next[computer.profileId];
        return next;
      });
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setBusyRemoteChip(undefined);
    }
  };

  const renderRemoteChips = (skill: SkillCatalogItemDto) => {
    if (!showRemoteComputers) return null;
    const normalizedName = normalizedSkillName(skill.name);
    return <span className="skill-computer-chips">
      {remoteComputers.map((computer) => {
        const key = `${computer.profileId}:${skill.id}`;
        const busy = busyRemoteChip === key;
        const remoteCatalog = remoteCatalogs[computer.profileId];
        const loadError = remoteErrors[computer.profileId];
        const present = remoteSkillNames.get(computer.profileId)?.has(normalizedName);
        if (present) return <span
          key={computer.profileId}
          className="skill-computer-chip on"
          title={`${skill.name} is available on ${computer.name}`}
        ><span>{computer.name}</span><em>✓</em></span>;
        const canCreate = Boolean(remoteCatalog)
          && computer.writable
          && skill.manageable
          && Boolean(createRemoteSkill)
          && !disabled;
        const title = loadError
          ? `${computer.name}: ${loadError}`
          : !remoteCatalog
            ? `Loading skills from ${computer.name}…`
            : !computer.writable
              ? `${computer.name} is connected read-only`
              : !skill.manageable
                ? `${skill.name} is provider-owned and cannot be copied`
                : `Create ${skill.name} on ${computer.name}`;
        return <button
          key={computer.profileId}
          className={`skill-computer-chip off${loadError ? " error" : ""}`}
          type="button"
          aria-label={`Create ${skill.name} on ${computer.name}`}
          title={title}
          disabled={Boolean(busyRemoteChip) || !canCreate}
          onClick={() => void copyToRemoteComputer(skill, computer)}
        ><span>{computer.name}</span><em>{busy ? "…" : loadError ? "!" : "+"}</em></button>;
      })}
    </span>;
  };

  const agentPath = (skill: SkillCatalogItemDto, state: SkillAgentStateDto) =>
    state.targetPath
    ?? skill.locations.find((location) => location.agents.includes(state.agent))?.path;

  const renderChip = (skill: SkillCatalogItemDto, state: SkillAgentStateDto) => {
    const busy = busyChip === `${skill.id}:${state.agent}`;
    const managerReady = Boolean(catalog?.managerAvailable) && skill.manageable && !disabled;
    const at = agentPath(skill, state);
    if (state.present && !state.managed) {
      return <span
        key={state.agent}
        className={`skill-chip ${state.agent} source`}
        title={`Original copy in ${agentLabel(state.agent)} — TermLoop will not remove it${at ? `\n${at}` : ""}`}
      ><Icon name={state.agent} /></span>;
    }
    if (state.managed) {
      return <button
        key={state.agent}
        className={`skill-chip ${state.agent} on`}
        type="button"
        aria-pressed="true"
        aria-label={`Remove ${skill.name} from ${agentLabel(state.agent)}`}
        title={`Remove from ${agentLabel(state.agent)}${at ? `\n${at}` : ""}`}
        disabled={Boolean(busyChip) || !managerReady}
        onClick={() => void changeDeployment(skill, state.agent, false)}
      ><Icon name={state.agent} /><em>{busy ? "…" : "✓"}</em></button>;
    }
    return <button
      key={state.agent}
      className={`skill-chip ${state.agent} off`}
      type="button"
      aria-pressed="false"
      aria-label={`Install ${skill.name} to ${agentLabel(state.agent)}`}
      title={managerReady ? `Install to ${agentLabel(state.agent)}` : "Managed actions require the bundled Skills Manager CLI"}
      disabled={Boolean(busyChip) || !managerReady}
      onClick={() => void changeDeployment(skill, state.agent, true)}
    ><Icon name={state.agent} /><em>{busy ? "…" : "+"}</em></button>;
  };

  const renderRow = (skill: SkillCatalogItemDto) => <div className="skill-rail-row" key={skill.id}>
    <button
      className="skill-rail-open"
      type="button"
      disabled={disabled}
      title={skill.locations.map((location) => location.path).join("\n")}
      onClick={() => openEditor(skill.id)}
    >
      <strong>{skill.name}</strong>
      <small>{skill.description}</small>
    </button>
    {improveSkill && !disabled ? <button
      className="rail-row-improve"
      type="button"
      title="Improve with agent"
      aria-label={`Improve ${skill.name} with agent`}
      onClick={() => improveSkill(skill.id, skill.name)}
    ><Icon name="sparkles" /></button> : null}
    <div className="skill-chips">{skill.agentStates.map((state) => renderChip(skill, state))}{renderRemoteChips(skill)}</div>
  </div>;

  const renderGroupedRow = (group: SkillDisplayGroup, section: SkillSection) => {
    const groupKey = `skill:${section}:${group.key}`;
    const representative = group.skills[0];
    const collapsed = folders.collapsed(groupKey, true);
    const locations = group.skills.flatMap((skill) => skill.locations);
    const locationLabel = `${locations.length} ${locations.length === 1 ? "location" : "locations"}`;
    const paths = locations.map((location) => location.path).join("\n");
    const aggregateChips = (["claude", "codex"] as const).map((agent) => {
      const available = group.skills.some((skill) =>
        skill.agentStates.some((state) => state.agent === agent && state.present)
      );
      const agentLocations = group.skills.flatMap((skill) =>
        skill.locations.filter((location) => location.agents.includes(agent))
      );
      return <span
        key={agent}
        className={`skill-chip ${agent} ${available ? "source" : "off"} summary`}
        title={available
          ? `Available to ${agentLabel(agent)} from ${agentLocations.length} ${agentLocations.length === 1 ? "location" : "locations"}`
          : `Not available to ${agentLabel(agent)}`}
      ><Icon name={agent} /></span>;
    });

    return <div className="skill-row-cluster" key={group.key}>
      <div className="skill-rail-row skill-cluster-row">
        <button
          className="skill-rail-open skill-cluster-toggle"
          type="button"
          aria-expanded={!collapsed}
          disabled={disabled}
          title={paths}
          onClick={() => folders.toggle(groupKey)}
        >
          <span><i aria-hidden="true" /><strong>{group.name}</strong></span>
          <small>{group.description}</small>
        </button>
        <div className="skill-chips">{aggregateChips}{representative ? renderRemoteChips(representative) : null}</div>
        <button
          className="skill-location-count"
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Show" : "Hide"} ${locationLabel} for ${group.name}`}
          disabled={disabled}
          onClick={() => folders.toggle(groupKey)}
        >{locationLabel}</button>
      </div>
      {collapsed ? null : <div className="skill-cluster-locations">
        {group.skills.map((skill) => {
          const sources = [...new Set(skill.locations.map((location) => location.source))].join(" · ");
          const skillPaths = skill.locations.map((location) => location.path);
          return <div className="skill-rail-row skill-location-row" key={skill.id}>
            <button
              className="skill-rail-open"
              type="button"
              disabled={disabled}
              title={skillPaths.join("\n")}
              onClick={() => openEditor(skill.id)}
            >
              <strong>{sources}</strong>
              <small>{skillPaths.join(" · ")}</small>
            </button>
            {improveSkill && !disabled ? <button
              className="rail-row-improve"
              type="button"
              title={`Improve ${skill.name} from ${sources}`}
              aria-label={`Improve ${skill.name} from ${sources} with agent`}
              onClick={() => improveSkill(skill.id, skill.name)}
            ><Icon name="sparkles" /></button> : null}
            <div className="skill-chips">{skill.agentStates.map((state) => renderChip(skill, state))}{renderRemoteChips(skill)}</div>
          </div>;
        })}
      </div>}
    </div>;
  };

  const renderSkillGroup = (group: SkillDisplayGroup, section: SkillSection) =>
    group.skills.length === 1 ? renderRow(group.skills[0]!) : renderGroupedRow(group, section);

  const projectEmptyCopy = normalizedQuery
    ? "No project skills match this search."
    : catalog?.projectIncluded
      ? "No skills in this project yet. Add a skill folder to the project to see it here."
      : "Open a project to see the skills that travel with it.";

  return (
    <nav className="skills-rail" aria-label="Skills">
      <div className="skills-rail-toolbar">
        <label className="skills-search"><Icon name="search" /><input value={query} aria-label="Search skills" placeholder="Search skills" onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="icon-button quiet" type="button" title={loading ? "Scanning…" : "Refresh skills"} aria-label="Refresh skills" disabled={loading} onClick={() => setReloadToken((current) => current + 1)}><Icon name="restart" /></button>
      </div>
      {remoteComputers.length > 0 ? <div className="skills-remote-control">
        <span><strong>Show remote computers</strong><small>{remoteComputers.length} connected</small></span>
        <button
          className={`skills-remote-switch${showRemoteComputers ? " on" : ""}`}
          type="button"
          role="switch"
          aria-checked={showRemoteComputers}
          aria-label="Show remote computers"
          disabled={disabled}
          onClick={() => setShowRemoteComputers((current) => !current)}
        ><span /></button>
      </div> : null}
      {showRemoteComputers ? <div className="skills-remote-legend" aria-label="Remote computers">
        {remoteComputers.map((computer) => <span key={computer.profileId} title={computer.writable ? "Full access" : "Read-only access"}>
          <i className={computer.writable ? "writable" : "readonly"} />{computer.name}<em>{computer.writable ? "Enabled" : "Read only"}</em>
        </span>)}
      </div> : null}
      {remoteListError ? <p className="skills-warning" role="status"><Icon name="sparkles" />Could not list remote computers: {remoteListError}</p> : null}
      {catalog && !catalog.managerAvailable ? <p className="skills-rail-note">Read only — managed actions require the bundled Skills Manager CLI.</p> : null}
      {error ? <p className="skills-error" role="alert">Could not load skills: {error}</p> : null}
      {actionError ? <p className="skills-error" role="alert">Could not update skill: {actionError}</p> : null}
      {catalog?.warnings.map((warning) => <p key={warning} className="skills-warning" role="status"><Icon name="sparkles" />{warning}</p>)}

      {visibleSections.map((section) => <section key={section.id} className={`skill-section${section.id === "project" ? " project" : ""}`} aria-label={section.label}>
        <header className="skill-section-head">
          <span className="skill-section-title">
            {section.id === "project" ? <Icon name="folder" /> : null}
            {section.label}
            {section.id === "project" && catalog?.projectName ? <b>{catalog.projectName}</b> : null}
          </span>
          <strong>{section.skillGroups.length}</strong>
        </header>
        {section.skillGroups.length === 0
          ? <p className="skills-empty">{section.id === "project" ? projectEmptyCopy : "No skills match this view."}</p>
          : section.id === "project"
            ? section.skillGroups.map((group) => renderSkillGroup(group, section.id))
            : groupByFolder(section.skillGroups).map((folder) => {
              const key = `${folder.label}\n${folder.path}`;
              // Every plugin group starts collapsed so provider packs do not
              // bury the rest of the rail. A search always shows its matches.
              const provider = section.id === "provider";
              return <RailGroup
                key={key}
                className="skill-folder"
                label={folder.label}
                count={folder.skillGroups.length}
                title={folder.path}
                icon={provider ? undefined : <Icon name="folder" />}
                collapsed={provider && !normalizedQuery && folders.collapsed(key, true)}
                toggle={provider ? () => folders.toggle(key) : undefined}
              >{folder.skillGroups.map((group) => renderSkillGroup(group, section.id))}</RailGroup>;
            })}
      </section>)}
      {loading && !catalog ? <span className="skills-empty">Scanning skill folders…</span> : null}
    </nav>
  );
}
