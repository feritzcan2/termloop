import { useEffect, useState } from "react";
import type { TaskDeveloperNoteDto } from "@termloop/contract/current";
import {
  MAX_TASK_DEVELOPER_NOTE_LENGTH,
  MAX_TASK_DEVELOPER_NOTES,
  readTaskDeveloperNotes,
  writeTaskDeveloperNotes,
} from "../task-developer-notes-memory.js";
import { Icon } from "./Icon.js";

function nextNoteId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function TaskDeveloperNotes(props: {
  projectId: string | undefined;
  taskId: string;
  taskTitle: string;
  notes: readonly TaskDeveloperNoteDto[];
  save(
    expected: readonly TaskDeveloperNoteDto[],
    next: readonly TaskDeveloperNoteDto[],
  ): Promise<string | undefined>;
}) {
  const [notes, setNotes] = useState<readonly TaskDeveloperNoteDto[]>(() => {
    if (props.notes.length > 0) return props.notes;
    return readTaskDeveloperNotes(props.projectId, props.taskId);
  });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const local = readTaskDeveloperNotes(props.projectId, props.taskId);
    const serverIds = new Set(props.notes.map((note) => note.id));
    const missingLocal = local.filter((note) => !serverIds.has(note.id));
    const migratedLocal = missingLocal.slice(0, MAX_TASK_DEVELOPER_NOTES - props.notes.length);
    const merged = [...props.notes, ...migratedLocal];
    setNotes(merged);
    setAdding(false);
    setDraft("");
    setError(undefined);
    if (local.length === 0) {
      setSaving(false);
      return;
    }
    if (missingLocal.length === 0) {
      writeTaskDeveloperNotes(props.projectId, props.taskId, []);
      setSaving(false);
      return;
    }
    if (migratedLocal.length === 0) {
      setSaving(false);
      setError("Developer note limit reached; local notes are still stored on this device.");
      return;
    }
    let active = true;
    setSaving(true);
    void props.save(props.notes, merged).then((failure) => {
      if (!active) return;
      setSaving(false);
      if (failure) setError(failure);
      else {
        const acceptedIds = new Set(merged.map((note) => note.id));
        const remaining = readTaskDeveloperNotes(props.projectId, props.taskId)
          .filter((note) => !acceptedIds.has(note.id));
        writeTaskDeveloperNotes(props.projectId, props.taskId, remaining);
        if (remaining.length > 0) {
          setError("Developer note limit reached; remaining local notes are still stored on this device.");
        }
      }
    });
    return () => { active = false; };
    // The current save callback is intentionally sampled for this projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId, props.taskId, props.notes]);

  useEffect(() => {
    const local = readTaskDeveloperNotes(props.projectId, props.taskId);
    if (local.length > 0) return;
    setNotes(props.notes);
  }, [props.notes, props.projectId, props.taskId]);

  const replaceNotes = async (next: readonly TaskDeveloperNoteDto[]) => {
    if (saving) return;
    const expected = notes;
    setNotes(next);
    setSaving(true);
    setError(undefined);
    const failure = await props.save(expected, next);
    setSaving(false);
    if (failure) {
      setNotes(expected);
      setError(failure);
    } else {
      writeTaskDeveloperNotes(props.projectId, props.taskId, []);
    }
  };
  const commitDraft = () => {
    const text = draft.trim().slice(0, MAX_TASK_DEVELOPER_NOTE_LENGTH);
    setAdding(false);
    setDraft("");
    if (!text || notes.length >= MAX_TASK_DEVELOPER_NOTES || saving) return;
    void replaceNotes([...notes, { id: nextNoteId(), text, completed: false }]);
  };
  const completedCount = notes.filter((note) => note.completed).length;

  return (
    <section
      className="task-developer-notes"
      aria-label={`Developer notes for ${props.taskTitle}`}
      aria-busy={saving || undefined}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="task-developer-notes-head">
        <span>Developer notes</span>
        {notes.length > 0 ? <small>{completedCount}/{notes.length}</small> : null}
        <button
          type="button"
          aria-label={`Add developer note to ${props.taskTitle}`}
          title={notes.length >= MAX_TASK_DEVELOPER_NOTES ? "Developer note limit reached" : "Add developer note"}
          disabled={saving || notes.length >= MAX_TASK_DEVELOPER_NOTES}
          onClick={() => setAdding(true)}
        ><Icon name="add" /></button>
      </header>
      {notes.length > 0 ? <ul className="task-developer-note-list">
        {notes.map((note) => <li key={note.id} className={note.completed ? "completed" : undefined}>
          <input
            type="checkbox"
            checked={note.completed}
            disabled={saving}
            aria-label={`${note.completed ? "Mark incomplete" : "Complete"}: ${note.text}`}
            onChange={() => void replaceNotes(notes.map((candidate) => candidate.id === note.id
              ? { ...candidate, completed: !candidate.completed }
              : candidate))}
          />
          <span>{note.text}</span>
          <button
            type="button"
            disabled={saving}
            aria-label={`Delete developer note: ${note.text}`}
            title="Delete note"
            onClick={() => void replaceNotes(notes.filter((candidate) => candidate.id !== note.id))}
          ><Icon name="close" /></button>
        </li>)}
      </ul> : null}
      {adding ? <form className="task-developer-note-form" onSubmit={(event) => { event.preventDefault(); commitDraft(); }}>
        <input
          autoFocus
          value={draft}
          maxLength={MAX_TASK_DEVELOPER_NOTE_LENGTH}
          aria-label={`New developer note for ${props.taskTitle}`}
          placeholder="Add a note…"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft("");
            setAdding(false);
          }}
        />
      </form> : null}
      {error ? <p className="task-developer-notes-error" role="alert">{error}</p> : null}
    </section>
  );
}
