import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../model.js";
import type { ConnectionProfileSummary } from "../../../connection-profile-types.js";

import { Icon } from "../Icon.js";
import { worktreePathParent } from "../worktree-path-suggestion.js";
import { folderLeafName, folderQuickJumps } from "./folder-path.js";
import { FolderPicker, type FolderPickerActions } from "./folder-picker.js";
import type { AgentCapabilityDto } from "@termloop/contract/current";

const NAME_LIMIT = 120;

function clampName(value: string): string {
  return [...value].slice(0, NAME_LIMIT).join("");
}

/// Folders that already hold Projects on the same connection, newest first.
/// They are the folders a user is most likely to browse near, so the picker
/// offers them instead of making every Project start from the default root.
function projectParentFolders(projects: readonly Project[], profileId: string): readonly string[] {
  return projects
    .filter((project) => (project.connectionProfileId ?? "local") === profileId)
    .map((project) => worktreePathParent(project.folder_path))
    .filter((path): path is string => path.length > 0)
    .reverse();
}

export function ProjectDialog({
  open,
  close,
  projects,
  listProfiles,
  defaultProjectsRoot,
  browseDirectory,
  createProject,
  pickLocalFolder,
}: {
  open: boolean;
  close(): void;
  projects: readonly Project[];
  listProfiles(): Promise<readonly ConnectionProfileSummary[]>;
  defaultProjectsRoot(profileId: string): Promise<{ path: string }>;
  browseDirectory(profileId: string, path: string): ReturnType<FolderPickerActions["browse"]>;
  createProject(profileId: string, name: string, folderPath: string): Promise<void>;
  /// The OS folder panel. Offered only while the browsed filesystem is this
  /// computer, because it cannot see a remote connection's disks.
  pickLocalFolder?(defaultPath?: string): Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [folder, setFolder] = useState("");
  const [profiles, setProfiles] = useState<readonly ConnectionProfileSummary[]>([]);
  const [profileId, setProfileId] = useState("local");
  const [defaultRoot, setDefaultRoot] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The composition layer rebuilds these callbacks on every render, so the
  // dialog reads them through refs: an effect keyed on them would reset the
  // form and re-ask the daemon for a root on each unrelated repaint.
  const listProfilesRef = useRef(listProfiles);
  const defaultRootRef = useRef(defaultProjectsRoot);
  listProfilesRef.current = listProfiles;
  defaultRootRef.current = defaultProjectsRoot;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setName("");
    setNameEdited(false);
    setFolder("");
    setError("");
    void listProfilesRef.current()
      .then((values) => {
        if (!active) return;
        const enabled = values.filter((profile) => profile.enabled);
        setProfiles(enabled);
        setProfileId((current) => enabled.some((profile) => profile.id === current) ? current : enabled[0]?.id ?? "local");
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setDefaultRoot(undefined);
    void defaultRootRef.current(profileId)
      .then((root) => { if (active) setDefaultRoot(root.path); })
      .catch(() => { if (active) setDefaultRoot(undefined); });
    return () => { active = false; };
  }, [open, profileId]);

  // The folder is the whole point of this dialog, so the name follows it until
  // the user types a name of their own.
  useEffect(() => {
    if (nameEdited) return;
    setName(folder ? clampName(folderLeafName(folder)) : "");
  }, [folder, nameEdited]);

  if (!open) return null;

  const actions: FolderPickerActions = {
    defaultRoot: () => defaultProjectsRoot(profileId),
    browse: (path) => browseDirectory(profileId, path),
  };
  const quickJumps = folderQuickJumps(defaultRoot, projectParentFolders(projects, profileId), undefined);
  const ready = name.trim().length > 0 && folder.trim().length > 0;

  const submit = async () => {
    if (!ready) { setError("Pick a folder and give the Project a name."); return; }
    setBusy(true);
    setError("");
    try {
      await createProject(profileId, name.trim(), folder.trim());
      close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <button className="dialog-backdrop" aria-label="Cancel adding Project" onClick={close} />
      <section className="dialog-card project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header className="dialog-header">
          <div><h2 id="project-dialog-title">New Project</h2></div>
          <button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button>
        </header>
        <div className="dialog-body project-dialog-body">
          <div className="project-field">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              value={name}
              placeholder="Named after the folder you pick"
              autoComplete="off"
              onChange={(event) => { setNameEdited(true); setName(clampName(event.target.value)); }}
              onKeyDown={(event) => { if (event.key === "Enter" && ready && !busy) { event.preventDefault(); void submit(); } }}
            />
          </div>
          <div className="project-field project-folder-field">
            {/* The computer sits in the Folder heading because it only chooses
                which filesystem the browser below walks. A separate labelled
                field pushed the name off the top of a short window. */}
            <div className="project-field-heading">
              <label id="project-folder-label">Folder</label>
              {profiles.length > 1 ? (
                <span className="project-field-aside">
                  <label htmlFor="project-computer">on</label>
                  <select id="project-computer" value={profileId} onChange={(event) => { setProfileId(event.target.value); setFolder(""); }}>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </span>
              ) : null}
            </div>
            <FolderPicker
              actions={actions}
              sourceKey={profileId}
              quickJumps={quickJumps}
              selected={folder}
              onSelect={setFolder}
              idPrefix="project-create"
              labelledBy="project-folder-label"
              autoFocusFilter
              pickLocalFolder={profileId === "local" ? pickLocalFolder : undefined}
            />
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={close}>Cancel</button>
          <button className="primary-button" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? "Adding…" : name.trim() ? `Add ${name.trim()}` : "Add Project"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/// Project details are the repository facts only. What a new Task starts with
/// is not a Project setting: it lives on the Task settings page, next to the
/// Task Sources that also create Tasks.
export function ProjectDetailsDialog({ project, projects, close, actions, defaultProjectsRoot, updateProject, pickLocalFolder }: {
  project: Project;
  projects: readonly Project[];
  close(): void;
  actions: FolderPickerActions;
  defaultProjectsRoot(): Promise<{ path: string }>;
  updateProject(projectId: string, name: string, folderPath: string): Promise<string | undefined>;
  pickLocalFolder?(defaultPath?: string): Promise<string | null>;
}) {
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(project.folder_path);
  const [defaultRoot, setDefaultRoot] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const profileId = project.connectionProfileId ?? "local";

  const defaultRootRef = useRef(defaultProjectsRoot);
  defaultRootRef.current = defaultProjectsRoot;

  useEffect(() => { requestAnimationFrame(() => nameRef.current?.focus()); }, []);
  useEffect(() => {
    let active = true;
    void defaultRootRef.current()
      .then((root) => { if (active) setDefaultRoot(root.path); })
      .catch(() => { if (active) setDefaultRoot(undefined); });
    return () => { active = false; };
  }, []);

  const quickJumps = useMemo(
    () => folderQuickJumps(defaultRoot, projectParentFolders(projects, profileId), undefined),
    [defaultRoot, profileId, projects],
  );
  const moved = folder.trim() !== project.folder_path;
  const ready = name.trim().length > 0 && folder.trim().length > 0;

  const submit = async () => {
    if (!ready) { setError("Choose a folder and enter a Project name."); return; }
    setBusy(true);
    setError(undefined);
    try {
      const failure = await updateProject(project.id, name.trim(), folder.trim());
      if (failure) setError(failure); else close();
    } finally { setBusy(false); }
  };

  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <button className="dialog-backdrop" aria-label="Cancel editing Project" onClick={close} />
      <section className="dialog-card project-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-project-title">
        <header className="dialog-header">
          <div><span className="dialog-eyebrow">Project details</span><h2 id="edit-project-title">Edit {project.name}</h2></div>
          <button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button>
        </header>
        <div className="dialog-body project-dialog-body project-details-dialog-body">
          <>
            <div className="project-field">
              <label htmlFor="edit-project-name">Name</label>
              <input
                ref={nameRef}
                id="edit-project-name"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(clampName(event.target.value))}
                onKeyDown={(event) => { if (event.key === "Enter" && ready && !busy) { event.preventDefault(); void submit(); } }}
              />
            </div>
            <div className="project-field project-folder-field">
              <div className="project-field-heading">
                <label id="edit-project-folder-label">Folder</label>
                {moved ? <button type="button" className="quiet-text-button" onClick={() => setFolder(project.folder_path)}>Undo folder change</button> : null}
              </div>
              <FolderPicker
                actions={actions}
                sourceKey={profileId}
                initialPath={project.folder_path}
                quickJumps={quickJumps}
                selected={folder}
                onSelect={setFolder}
                idPrefix="project-edit"
                labelledBy="edit-project-folder-label"
                pickLocalFolder={profileId === "local" ? pickLocalFolder : undefined}
              />
              <p className="field-help">
                {moved
                  ? `New Sessions will start in ${folder.trim()}. Sessions that are already running keep ${project.folder_path}.`
                  : "A new folder is used only for future Sessions. Existing Sessions keep their original working directory."}
              </p>
            </div>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
          </>
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
          <button className="primary-button" disabled={busy || !ready} onClick={() => void submit()}>{busy ? "Saving…" : "Save changes"}</button>
        </footer>
      </section>
    </div>
  );
}
