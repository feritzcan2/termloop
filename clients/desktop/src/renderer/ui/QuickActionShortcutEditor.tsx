import { useRef, useState } from "react";
import { QUICK_ACTION_SHORTCUT_ICONS, quickActionShortcutSummary, type QuickActionShortcutDraft, type QuickActionShortcutIcon as ShortcutColor, type QuickActionShortcutSelection } from "../quick-action-shortcuts.js";
import { Icon } from "./Icon.js";
import { QuickActionShortcutIcon, shortcutColorStyle } from "./QuickActionShortcutIcon.js";
import "./quick-action-shortcuts.css";

export function QuickActionShortcutEditor({ selection, disabled, save, close, initialName, initialIcon, editing = false }: {
  selection: QuickActionShortcutSelection;
  disabled: boolean;
  save(draft: QuickActionShortcutDraft): void;
  close(): void;
  initialName?: string;
  initialIcon?: ShortcutColor;
  editing?: boolean;
}) {
  const [name, setName] = useState(initialName ?? `${selection.model === "default" ? selection.agentId : selection.model}${selection.reasoning === "default" ? "" : ` · ${selection.reasoning}`}`.slice(0, 60));
  const [icon, setIcon] = useState<ShortcutColor>(initialIcon ?? (selection.agentId === "claude" || selection.agentId === "codex" ? selection.agentId : "agent"));
  const [error, setError] = useState<string>();
  const saveRef = useRef<HTMLButtonElement>(null);
  const submit = () => {
    if (disabled || !name.trim()) return;
    try { save({ ...selection, name, icon }); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save shortcut."); }
  };
  return <section className="quick-action-shortcut-editor" aria-label={editing ? "Edit shortcut" : "Create shortcut"} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Enter") {
      event.stopPropagation();
      if (event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); saveRef.current?.click(); }
    }
  }}>
    <div className="shortcut-editor-heading"><strong>{editing ? "Edit shortcut" : "Create shortcut"}</strong><button type="button" aria-label="Cancel shortcut" onClick={close}><Icon name="close" /></button></div>
    <p>Start a new session in the current project with these model settings.</p>
    <code>{quickActionShortcutSummary(selection)}</code>
    <label className="shortcut-name">Name<input autoFocus type="text" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
    <fieldset className="shortcut-icon-picker"><legend>Icon color</legend><div>
      {QUICK_ACTION_SHORTCUT_ICONS.map((choice) => <label key={choice.id} title={choice.label} style={shortcutColorStyle(choice.id)} className={icon === choice.id ? "selected" : undefined}>
        <input type="radio" name="shortcut-icon" value={choice.id} aria-label={choice.label} checked={icon === choice.id} onChange={() => setIcon(choice.id)} />
        <QuickActionShortcutIcon agentId={selection.agentId} icon={choice.id} />
      </label>)}
    </div></fieldset>
    <div className="shortcut-editor-footer"><span className="shortcut-preview"><QuickActionShortcutIcon agentId={selection.agentId} icon={icon} /><span>{name.trim() || "Shortcut"}</span></span><button type="button" onClick={close}>Cancel</button><button ref={saveRef} className="shortcut-save" type="button" disabled={disabled || !name.trim()} onClick={submit}>{editing ? "Save changes" : "Save shortcut"}</button></div>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
