import { useState } from "react";

import type {
  ContextBankCatalogItemDto,
  ContextBankCatalogResult,
  ContextBankSiblingConflictDto,
} from "@termloop/contract/current";
import { Icon } from "./Icon.js";

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function ContextBankConflictResolver({ conflict, files, resolve, resolved, close }: {
  conflict: ContextBankSiblingConflictDto;
  files: readonly ContextBankCatalogItemDto[];
  resolve(conflictId: string, sourceFileId: string): Promise<ContextBankCatalogResult>;
  resolved(catalog: ContextBankCatalogResult): void;
  close(): void;
}) {
  const [sourceFileId, setSourceFileId] = useState(files[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const source = files.find((file) => file.id === sourceFileId);

  const apply = async () => {
    if (!source || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      resolved(await resolve(conflict.id, source.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return <section className="context-conflict-resolver" aria-label={`Resolve ${conflict.directoryPath} sibling conflict`}>
    <header>
      <div><Icon name="copy" /><strong>Choose source of truth</strong></div>
      <button className="icon-button quiet" type="button" aria-label="Close conflict resolver" disabled={saving} onClick={close}><Icon name="close" /></button>
    </header>
    <p>Every other sibling in this folder will be overwritten with the selected file’s complete content.</p>
    <div className="context-conflict-sources" role="radiogroup" aria-label="Source file">
      {files.map((file) => <button
        className={file.id === sourceFileId ? "selected" : ""}
        type="button"
        role="radio"
        aria-checked={file.id === sourceFileId}
        key={file.id}
        disabled={saving}
        onClick={() => setSourceFileId(file.id)}
      >
        <i aria-hidden="true" />
        <span><strong>{fileName(file.relativePath)}</strong><small>{file.lineCount} lines · {file.relativePath}</small></span>
      </button>)}
    </div>
    {error ? <p className="context-conflict-error" role="alert">{error}</p> : null}
    <footer>
      <button className="secondary-button" type="button" disabled={saving} onClick={close}>Cancel</button>
      <button className="danger-button" type="button" disabled={!source || saving} onClick={() => void apply()}>
        {saving ? "Overwriting…" : `Overwrite ${Math.max(0, files.length - 1)} file${files.length === 2 ? "" : "s"}`}
      </button>
    </footer>
  </section>;
}
