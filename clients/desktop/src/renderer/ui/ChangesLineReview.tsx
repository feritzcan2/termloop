import { MAX_CHANGE_REVIEW_NOTE_CHARS, type ChangeReviewNote } from "../changes-review.js";

export type ChangeReviewDraft = Omit<ChangeReviewNote, "body">;

export function changeReviewDraft(note: ChangeReviewNote): ChangeReviewDraft {
  const { body: _body, ...draft } = note;
  return draft;
}

/// One line comment beneath its diff line: a summary until it is opened for editing.
export function LineReviewWidget({ draft, body, editing, edit, change, close, remove }: {
  draft: ChangeReviewDraft;
  body: string;
  editing: boolean;
  edit(): void;
  change(body: string): void;
  close(): void;
  remove(): void;
}) {
  if (!editing) {
    return (
      <button type="button" className="changes-line-comment-summary" onClick={edit}>
        <strong>{draft.lineSide} line {draft.lineNumber}</strong><span>{body}</span>
      </button>
    );
  }
  return (
    <div className="changes-line-comment-editor">
      <label><span>{draft.lineSide} line {draft.lineNumber}</span>
        <textarea
          autoFocus
          value={body}
          maxLength={MAX_CHANGE_REVIEW_NOTE_CHARS}
          placeholder="Write a comment for this line…"
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        />
      </label>
      <div>
        {body ? <button type="button" className="quiet-button" onClick={remove}>Delete</button> : null}
        <button type="button" className="secondary-button" onClick={close}>Done</button>
      </div>
    </div>
  );
}
