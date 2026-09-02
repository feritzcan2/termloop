import { useEffect, useState } from "react";
import {
  MAX_TASK_DEVELOPER_NOTE_LENGTH,
  MAX_TASK_DEVELOPER_NOTES,
  readTaskDeveloperNotes,
  writeTaskDeveloperNotes,
  type TaskDeveloperNote,
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
}) {
  const [notes, setNotes] = useState<readonly TaskDeveloperNote[]>(
    () => readTaskDeveloperNotes(props.projectId, props.taskId),
  );
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setNotes(readTaskDeveloperNotes(props.projectId, props.taskId));
    setAdding(false);
    setDraft("");
  }, [props.projectId, props.taskId]);

  const replaceNotes = (change: (current: readonly TaskDeveloperNote[]) => readonly TaskDeveloperNote[]) => {
    setNotes((current) => {
      const next = change(current);
      writeTaskDeveloperNotes(props.projectId, props.taskId, next);
      return next;
    });
  };
  const commitDraft = () => {
    const text = draft.trim().slice(0, MAX_TASK_DEVELOPER_NOTE_LENGTH);
    setAdding(false);
    setDraft("");
    if (!text) return;
    replaceNotes((current) => current.length >= MAX_TASK_DEVELOPER_NOTES
      ? current
      : [...current, { id: nextNoteId(), text, completed: false }]);
  };
  const completedCount = notes.filter((note) => note.completed).length;

  return (
    <section
      className="task-developer-notes"
      aria-label={`Developer notes for ${props.taskTitle}`}
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
          disabled={notes.length >= MAX_TASK_DEVELOPER_NOTES}
          onClick={() => setAdding(true)}
        ><Icon name="add" /></button>
      </header>
      {notes.length > 0 ? <ul className="task-developer-note-list">
        {notes.map((note) => <li key={note.id} className={note.completed ? "completed" : undefined}>
          <input
            type="checkbox"
            checked={note.completed}
            aria-label={`${note.completed ? "Mark incomplete" : "Complete"}: ${note.text}`}
            onChange={() => replaceNotes((current) => current.map((candidate) => candidate.id === note.id
              ? { ...candidate, completed: !candidate.completed }
              : candidate))}
          />
          <span>{note.text}</span>
          <button
            type="button"
            aria-label={`Delete developer note: ${note.text}`}
            title="Delete note"
            onClick={() => replaceNotes((current) => current.filter((candidate) => candidate.id !== note.id))}
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
    </section>
  );
}

