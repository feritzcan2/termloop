import { useEffect, useState } from "react";
import type { ProjectMode, ProjectModeResult, ProjectModeSetParams } from "@termloop/contract/current";

import { Icon } from "./Icon.js";

export type ProjectModeActions = {
  load(projectId: string): Promise<ProjectModeResult>;
  save(params: ProjectModeSetParams): Promise<ProjectModeResult>;
};

const MODES: readonly { mode: ProjectMode; label: string }[] = [
  { mode: "developer", label: "Developer" },
  { mode: "projectManager", label: "Project Manager" },
];

/// Whether the Project Manager layout replaces the Developer one: only while
/// the experimental switch is on and the daemon says the Project is one.
export function projectManagerLayoutActive(flag: boolean, mode: ProjectMode | undefined): boolean {
  return flag && mode === "projectManager";
}

/// The selected Project's stored mode, read from the daemon while the
/// experimental switch is on. `changed` applies a mode just saved so the
/// layout follows without waiting for another read.
export function useProjectMode(
  projectId: string | undefined,
  actions: ProjectModeActions | undefined,
  enabled: boolean,
): { mode: ProjectMode | undefined; changed(mode: ProjectMode): void } {
  const [loaded, setLoaded] = useState<{ projectId: string; mode: ProjectMode }>();
  useEffect(() => {
    if (!enabled || !projectId || !actions) return;
    let active = true;
    actions.load(projectId).then(
      (result) => { if (active) setLoaded({ projectId, mode: result.mode }); },
      () => { if (active) setLoaded(undefined); },
    );
    return () => { active = false; };
  }, [projectId, actions, enabled]);
  return {
    mode: enabled && loaded && loaded.projectId === projectId ? loaded.mode : undefined,
    changed: (mode) => { if (projectId) setLoaded({ projectId, mode }); },
  };
}

/// The Project menu's mode choice. The daemon owns the mode; this only shows
/// the stored value and asks for a change against a freshly read revision.
export function ProjectModeMenuItems(props: {
  projectId: string;
  disabled: boolean;
  actions: ProjectModeActions;
  changed?(mode: ProjectMode): void;
}) {
  const { projectId, actions } = props;
  const [mode, setMode] = useState<ProjectMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setMode(undefined);
    setError(undefined);
    actions.load(projectId).then(
      (result) => { if (active) setMode(result.mode); },
      (failure: unknown) => { if (active) setError(errorMessage(failure)); },
    );
    return () => { active = false; };
  }, [projectId, actions]);

  const choose = async (next: ProjectMode) => {
    if (next === mode || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const current = await actions.load(projectId);
      const saved = await actions.save({ projectId, mode: next, expectedRevision: current.stateRevision });
      setMode(saved.mode);
      props.changed?.(saved.mode);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="project-menu-divider" role="separator" />
    <div className="project-menu-section-label" aria-hidden="true">Open as</div>
    {MODES.map((item) => (
      <button
        key={item.mode}
        type="button"
        role="menuitemradio"
        aria-checked={mode === item.mode}
        disabled={props.disabled || busy || mode === undefined}
        onClick={() => { void choose(item.mode); }}
      >
        <Icon name={mode === item.mode ? "check" : "circle"} />
        <span className="project-menu-label">{item.label}</span>
      </button>
    ))}
    {error ? <div className="project-menu-error" role="alert">{error}</div> : null}
  </>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
