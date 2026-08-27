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
    const key = skill.name.trim().toLocaleLowerCase("en-US");
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

export function SkillsRail({ load, setDeployment, openEditor, improveSkill, disabled }: {
  load(): Promise<SkillCatalogResult>;
  setDeployment(skillId: string, agent: SkillAgent, deployed: boolean): Promise<SkillCatalogResult>;
  openEditor(skillId: string): void;
  /// Absent while no Project is open: the improver runs in a checkout.
  improveSkill?: ((skillId: string, name: string) => void) | undefined;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<SkillCatalogResult>();
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyChip, setBusyChip] = useState<string>();
  const folders = useRailGroups();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void load().then((result) => {
      if (active) setCatalog(result);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [load, reloadToken]);

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

  const changeDeployment = async (skill: SkillCatalogItemDto, agent: SkillAgent, deployed: boolean) => {
    setBusyChip(`${skill.id}:${agent}`);
    setActionError(undefined);
    try {
      setCatalog(await setDeployment(skill.id, agent, deployed));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyChip(undefined);
    }
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
    <div className="skill-chips">{skill.agentStates.map((state) => renderChip(skill, state))}</div>
  </div>;

  const renderGroupedRow = (group: SkillDisplayGroup, section: SkillSection) => {
    const groupKey = `skill:${section}:${group.key}`;
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
        <div className="skill-chips">{aggregateChips}</div>
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
            <div className="skill-chips">{skill.agentStates.map((state) => renderChip(skill, state))}</div>
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
      {catalog && !catalog.managerAvailable ? <p className="skills-rail-note">Read only — managed actions require the bundled Skills Manager CLI.</p> : null}
      {error ? <p className="skills-error" role="alert">Could not load skills: {error}</p> : null}
      {actionError ? <p className="skills-error" role="alert">Could not update skill deployment: {actionError}</p> : null}
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
