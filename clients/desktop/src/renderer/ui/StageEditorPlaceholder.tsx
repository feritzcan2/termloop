import { Icon } from "./Icon.js";

/// Stands in for a settings stage page whose entry is not there to edit: the
/// catalog is still loading, failed to load, or no longer contains it.
export function StageEditorPlaceholder({ label, error, loaded, close }: {
  label: string;
  error: string | undefined;
  loaded: boolean;
  close(): void;
}) {
  return (
    <section className="stage-editor" aria-label={label}>
      <header className="stage-editor-head">
        <div className="stage-editor-title"><span>{label}</span><h2>{label}</h2></div>
        <div className="stage-editor-actions">
          <button className="icon-button quiet" type="button" aria-label={`Close ${label}`} onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      {error
        ? <p className="settings-rail-error" role="alert">{error}</p>
        : <p className="settings-rail-empty">{loaded ? `This ${label.toLocaleLowerCase("en-US")} is no longer in the catalog.` : "Loading…"}</p>}
    </section>
  );
}
