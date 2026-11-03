import { useState } from "react";

import { Icon } from "../Icon.js";
import { folderLeafName, type FolderTrailSegment } from "./folder-path.js";
import { FolderPicker, type FolderPickerActions } from "./folder-picker.js";

/// Where the folder chooser browses: the Agent's own connection, plus the OS
/// panel only when that connection is this computer.
export type RestoreFolderPicker = {
  actions: FolderPickerActions;
  sourceKey: string;
  pickLocalFolder?: ((defaultPath?: string) => Promise<string | null>) | undefined;
};

/// The folders a restore most often moves to, without duplicates.
export function restoreFolderQuickJumps(candidates: readonly (string | null | undefined)[]): readonly FolderTrailSegment[] {
  const seen = new Set<string>();
  const jumps: FolderTrailSegment[] = [];
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    jumps.push({ name: folderLeafName(path), path });
  }
  return jumps;
}

/// Restores an archived or deleted Agent into a folder the user picks instead
/// of the one it last ran in. The daemon proves the folder exists; the dialog
/// only carries the chosen path.
export function RestoreFolderDialog({ title, originalCwd, initialPath, quickJumps, picker, close, restore }: {
  title: string;
  originalCwd: string;
  initialPath: string | undefined;
  quickJumps: readonly FolderTrailSegment[];
  picker: RestoreFolderPicker;
  close(): void;
  /// Resolves with a failure message, or undefined once restored.
  restore(cwd: string): Promise<string | undefined>;
}) {
  // The folder the browser opens in starts selected, as in a native open panel.
  const [folder, setFolder] = useState(initialPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = folder.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const failure = await restore(folder.trim());
      if (failure) setError(failure);
      else close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape" && !busy) close(); }}>
      <button className="dialog-backdrop" aria-label="Cancel restoring in another folder" onClick={() => { if (!busy) close(); }} />
      <section className="dialog-card project-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-folder-title">
        <header className="dialog-header">
          <div>
            <h2 id="restore-folder-title">Restore in folder</h2>
            <p className="restore-folder-subtitle" title={originalCwd}>{title} · last ran in {folderLeafName(originalCwd) || originalCwd}</p>
          </div>
          <button className="icon-button quiet" aria-label="Close dialog" disabled={busy} onClick={close}><Icon name="close" /></button>
        </header>
        <div className="dialog-body project-dialog-body restore-folder-body">
          <div className="project-field project-folder-field">
            <div className="project-field-heading"><label id="restore-folder-label">Folder</label></div>
            <FolderPicker
              actions={picker.actions}
              sourceKey={picker.sourceKey}
              {...(initialPath ? { initialPath } : {})}
              quickJumps={quickJumps}
              selected={folder}
              onSelect={setFolder}
              idPrefix="restore-folder"
              labelledBy="restore-folder-label"
              autoFocusFilter
              pickLocalFolder={picker.pickLocalFolder}
            />
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
          <button className="primary-button" disabled={busy || !ready} title={folder || undefined} onClick={() => void submit()}>
            {busy ? "Restoring…" : ready ? `Restore in ${folderLeafName(folder) || folder}` : "Restore"}
          </button>
        </footer>
      </section>
    </div>
  );
}
