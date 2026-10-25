import { useState, type KeyboardEvent } from "react";
import type { PmTicketNoteKind } from "@termloop/pm-contract/pm";

export type NoteDraft = { kind: PmTicketNoteKind; text: string; url: string | null };

const COPY: Record<PmTicketNoteKind, { title: string; text: string; placeholder: string; url: string }> = {
  fact: {
    title: "Add a note",
    text: "What did you learn?",
    placeholder: "A decision, a changed scope, an answer to an open question…",
    url: "Where it came from (optional)",
  },
  source: {
    title: "Follow a link",
    text: "Label",
    placeholder: "Slack #checkout thread",
    url: "Link to read again for new facts",
  },
};

/** Only an HTTPS link is kept, as the daemon requires. */
export function noteUrlValid(url: string): boolean {
  return /^https:\/\/[^\s@/]+(\/\S*)?$/.test(url);
}

/**
 * Records a fact or a followed source for one ticket, from the ticket's
 * context menu or its Notes section. The note is raw input: the description
 * changes only through a draft the PM applies. `onSubmit` resolves true once
 * the note is stored.
 */
export function NoteDialog(props: {
  kind: PmTicketNoteKind;
  ticketLabel: string;
  onSubmit(draft: NoteDraft): Promise<boolean>;
  onClose(): void;
}) {
  const copy = COPY[props.kind];
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const link = url.trim();
  const linkOk = link === "" ? props.kind === "fact" : noteUrlValid(link);
  const ready = text.trim() !== "" && linkOk && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const stored = await props.onSubmit({ kind: props.kind, text: text.trim(), url: link || null });
    setBusy(false);
    if (stored) props.onClose();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={keys} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal note-dialog" role="dialog" aria-modal="true" aria-label={copy.title}>
        <div className="modal-head">
          <b>{copy.title}</b>
          <span className="meta">{props.ticketLabel}</span>
          <span className="sp" />
          <button type="button" className="icb" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <label className="note-field">
          <span>{copy.text}</span>
          {props.kind === "fact"
            ? <textarea autoFocus aria-label={copy.text} rows={4} maxLength={2000} placeholder={copy.placeholder} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
            : <input autoFocus aria-label={copy.text} maxLength={120} placeholder={copy.placeholder} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />}
        </label>
        <label className="note-field">
          <span>{copy.url}</span>
          <input aria-label="Link" placeholder="https://…" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
        </label>
        {link !== "" && !noteUrlValid(link) && <p className="hint warn">Use an https:// link.</p>}
        <div className="modal-foot">
          <span className="hint">The description changes only when you apply the assistant's draft.</span>
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn sm pri" disabled={!ready} onClick={() => void submit()}>{props.kind === "fact" ? "Add note" : "Follow"}</button>
        </div>
      </div>
    </div>
  );
}
