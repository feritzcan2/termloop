import { useState } from "react";
import type { TaskDeveloperNoteDto } from "@termloop/contract/current";
import type { Task } from "../model.js";
import { MAX_TASK_DEVELOPER_NOTES, MAX_TASK_DEVELOPER_NOTE_LENGTH } from "../task-developer-notes-memory.js";
import { Icon } from "./Icon.js";
import "./playbook-task-notes.css";

export type SavePlaybookTaskNotes = (
  taskId: string, expected: readonly TaskDeveloperNoteDto[], next: readonly TaskDeveloperNoteDto[],
) => Promise<string | undefined>;

export function PlaybookTaskNotes(props: { task: Task; disabled?: boolean | undefined; save: SavePlaybookTaskNotes }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const notes = props.task.developer_notes ?? [];
  const full = notes.length >= MAX_TASK_DEVELOPER_NOTES;
  const submit = async () => {
    const text = draft.trim();
    if (!text || saving || props.disabled || full) return;
    setSaving(true); setError(undefined); setSaved(false);
    try {
      const failure = await props.save(props.task.id, notes, [...notes, {
        id: globalThis.crypto.randomUUID(), text, completed: false,
      }]);
      if (failure) setError(failure);
      else { setDraft(""); setSaved(true); }
    } catch {
      setError("The note could not be saved. Try again.");
    } finally { setSaving(false); }
  };
  return <>
    <button type="button" className="playbook-note-toggle" aria-label={`Notes for ${props.task.title}`}
      title="Notes for the task agent" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="edit" />{notes.length > 0 ? <span>{notes.length}</span> : null}
    </button>
    {open ? <form className="playbook-task-notes" aria-label={`Task agent notes for ${props.task.title}`}
      aria-busy={saving} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <strong>Notes for the task agent</strong>
      <small>Saved with the Task. The agent sees them when it reads the Task.</small>
      {notes.length > 0 ? <ul>{notes.map((note) => <li key={note.id} className={note.completed ? "completed" : undefined}>{note.text}</li>)}</ul> : null}
      <textarea autoFocus rows={3} maxLength={MAX_TASK_DEVELOPER_NOTE_LENGTH}
        aria-label="Note for the task agent" placeholder="Add context or instructions for this task…"
        disabled={saving || props.disabled || full} value={draft}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }} />
      {error ? <p role="alert">{error}</p> : null}
      {full ? <small>Task note limit reached. Manage existing notes from Task details.</small> : null}
      <footer>{saved ? <span role="status">Note saved</span> : <span>{draft.length}/{MAX_TASK_DEVELOPER_NOTE_LENGTH}</span>}
        <button type="submit" disabled={saving || props.disabled || full || !draft.trim()}>{saving ? "Saving…" : "Save note"}</button>
      </footer>
    </form> : null}
  </>;
}
