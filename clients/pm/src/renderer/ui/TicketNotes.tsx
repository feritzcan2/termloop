import { useState } from "react";
import type { PmTicketNote } from "@termloop/pm-contract/pm";
import { AUTHOR_LABEL } from "./VersionsList.js";
import { relativeTime } from "./format.js";

export type TicketNotesProps = {
  /** `undefined` while the first read is on its way. */
  notes: PmTicketNote[] | undefined;
  now: number;
  /** Whether an assistant can start for this project. */
  canUpdate: boolean;
  onAddNote(text: string): void;
  onFollowSource(): void;
  onRemoveNote(noteId: string): void;
  onOpenLink(url: string): void;
  onUpdateDescription(): void;
};

/**
 * What was learned about the ticket since its description was written, and
 * the links worth reading again. A pending note is newer than the newest
 * description version; "Update description" asks the assistant to merge the
 * pending notes and new facts from the sources into a description draft.
 */
export function TicketNotes(props: TicketNotesProps) {
  const [text, setText] = useState("");
  const notes = props.notes ?? [];
  const facts = notes.filter((note) => note.kind === "fact");
  const sources = notes.filter((note) => note.kind === "source");
  const pending = facts.filter((note) => note.pending).length;
  return (
    <>
      <h3 className="s">
        Notes <small>{pending > 0 ? `${pending} not in the description yet` : `${facts.length}`}</small>
        <span className="sp" />
        <button
          type="button"
          className="btn sm ghost"
          disabled={!props.canUpdate || (pending === 0 && sources.length === 0)}
          title={pending === 0 && sources.length === 0 ? "Add a note or a source first" : "The assistant drafts a description from the pending notes and sources"}
          onClick={props.onUpdateDescription}
        >
          Update description
        </button>
      </h3>
      {sources.length > 0 && (
        <ul className="note-sources" aria-label="Followed sources">
          {sources.map((note) => (
            <li key={note.id}>
              <button type="button" className="link" onClick={() => props.onOpenLink(note.url!)}>{note.text}</button>
              <span className="hint">{AUTHOR_LABEL[note.author]} · {relativeTime(note.createdAtEpochMs, props.now)}</span>
              <button type="button" className="icb remove" aria-label="Stop following source" onClick={() => props.onRemoveNote(note.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <ul className="notes" aria-label="Notes">
        {facts.map((note) => (
          <li key={note.id} className={note.pending ? "pending" : ""}>
            <span className="note-text">{note.text}</span>
            <span className="note-meta">
              {note.pending && <span className="draft">new</span>}
              <span>{AUTHOR_LABEL[note.author]} · {relativeTime(note.createdAtEpochMs, props.now)}</span>
              {note.url && <button type="button" className="link" onClick={() => props.onOpenLink(note.url!)}>source</button>}
            </span>
            <button type="button" className="icb remove" aria-label="Remove note" onClick={() => props.onRemoveNote(note.id)}>×</button>
          </li>
        ))}
      </ul>
      <form className="add-line" onSubmit={(event) => { event.preventDefault(); if (text.trim()) props.onAddNote(text.trim()); setText(""); }}>
        <input placeholder="+ Add what you learned (a decision, a changed scope…)" aria-label="New note" maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="button" className="btn sm ghost" onClick={props.onFollowSource}>Follow a link…</button>
      </form>
    </>
  );
}
