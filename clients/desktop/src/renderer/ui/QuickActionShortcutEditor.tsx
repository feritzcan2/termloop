import { useRef, useState } from "react";
import { QUICK_ACTION_SHORTCUT_ICONS, quickActionShortcutSummary, type QuickActionShortcutDraft, type QuickActionShortcutIcon, type QuickActionShortcutSelection } from "../quick-action-shortcuts.js";
import { Icon } from "./Icon.js";
import "./quick-action-shortcuts.css";

export function QuickActionShortcutEditor({ selection, disabled, save, close }: {
  selection: QuickActionShortcutSelection;
  disabled: boolean;
  save(draft: QuickActionShortcutDraft): void;
  close(): void;
}) {
  const [name, setName] = useState(`${selection.model === "default" ? selection.agentId : selection.model}${selection.reasoning === "default" ? "" : ` · ${selection.reasoning}`}`.slice(0, 60));
  const [icon, setIcon] = useState<QuickActionShortcutIcon>(selection.agentId === "claude" || selection.agentId === "codex" ? selection.agentId : "agent");
  const [error, setError] = useState<string>();
  const saveRef = useRef<HTMLButtonElement>(null);
  const submit = () => {
    if (disabled || !name.trim()) return;
    try { save({ ...selection, name, icon }); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save shortcut."); }
  };
  return <section className="quick-action-shortcut-editor" aria-label="Create shortcut" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Enter") {
      event.stopPropagation();
      if (event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); saveRef.current?.click(); }
    }
  }}>
    <div className="shortcut-editor-heading"><strong>Create shortcut</strong><button type="button" aria-label="Cancel shortcut" onClick={close}><Icon name="close" /></button></div>
    <p>Start a new session in the current project with these model settings.</p>
    <code>{quickActionShortcutSummary(selection)}</code>
    <label className="shortcut-name">Name<input autoFocus type="text" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
    <fieldset className="shortcut-icon-picker"><legend>Icon</legend><div>
      {QUICK_ACTION_SHORTCUT_ICONS.map((choice) => <label key={choice.id} title={choice.label} className={icon === choice.id ? "selected" : undefined}>
        <input type="radio" name="shortcut-icon" value={choice.id} aria-label={choice.label} checked={icon === choice.id} onChange={() => setIcon(choice.id)} />
        <Icon name={choice.id} />
      </label>)}
    </div></fieldset>
    <div className="shortcut-editor-footer"><span className="shortcut-preview"><Icon name={icon} /><span>{name.trim() || "Shortcut"}</span></span><button type="button" onClick={close}>Cancel</button><button ref={saveRef} className="shortcut-save" type="button" disabled={disabled || !name.trim()} onClick={submit}>Save shortcut</button></div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
