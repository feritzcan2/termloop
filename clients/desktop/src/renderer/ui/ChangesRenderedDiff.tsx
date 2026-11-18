import { useMemo, type ReactNode } from "react";
import { Decoration, Diff, Hunk, type ChangeData, type FileData, type HunkData } from "react-diff-view";
import { changeReviewLine, type ChangeReviewNote } from "../changes-review.js";
import { gapBefore } from "../changes-full-file.js";
import { Icon } from "./Icon.js";
import { LineReviewWidget, changeReviewDraft, type ChangeReviewDraft } from "./ChangesLineReview.js";
import { useDiffSyntax } from "./useDiffSyntax.js";
import { plainDiffTokens, withEditMarks } from "../diff-review.js";
import { diffSideLines } from "../diff-syntax.js";

export function RenderedDiff({
  file,
  path,
  hunks,
  hiddenLines,
  viewType,
  notes,
  draft,
  openLineReview,
  editLineReview,
  updateLineReview,
  removeLineReview,
}: {
  file: FileData;
  path: string | undefined;
  hunks: HunkData[];
  hiddenLines: number | undefined;
  viewType: "unified" | "split";
  notes: readonly ChangeReviewNote[];
  draft: ChangeReviewDraft | undefined;
  openLineReview(change: ChangeData, side: "old" | "new"): void;
  editLineReview(draft: ChangeReviewDraft | undefined): void;
  updateLineReview(draft: ChangeReviewDraft, body: string): void;
  removeLineReview(key: string): void;
}) {
  const syntax = useDiffSyntax(hunks, path);
  // Plain tokens stand in for syntax colors so the changed span of each
  // paired line is marked for plain text and while colors load.
  const tokens = useMemo(
    () => withEditMarks(syntax ?? plainDiffTokens(diffSideLines(hunks)), hunks),
    [hunks, syntax],
  );
  const notesByChange = new Map(notes.map((note) => [note.changeKey, note]));
  const reviewTargets = new Map(
    notes.map((note) => [note.changeKey, changeReviewDraft(note)] as const),
  );
  if (draft) reviewTargets.set(draft.changeKey, draft);
  const widgets: Record<string, ReactNode> = {};
  for (const target of reviewTargets.values()) {
    const note = notesByChange.get(target.changeKey);
    widgets[target.changeKey] = (
      <LineReviewWidget
        key={target.key}
        draft={target}
        body={note?.body ?? ""}
        editing={draft?.key === target.key}
        edit={() => editLineReview(target)}
        change={(body) => updateLineReview(target, body)}
        close={() => editLineReview(undefined)}
        remove={() => removeLineReview(target.key)}
      />
    );
  }
  return (
    <div className="changes-diff-scroll">
      <Diff
        viewType={viewType}
        diffType={file.type}
        hunks={hunks}
        tokens={tokens}
        widgets={widgets}
        selectedChanges={[...reviewTargets.keys()]}
        renderGutter={({ change, side, renderDefault }) => {
          const commentable = change.type === "normal"
            || (change.type === "insert" && side === "new")
            || (change.type === "delete" && side === "old");
          if (!commentable) return renderDefault();
          return (
            <button
              type="button"
              className="changes-line-comment-trigger"
              aria-label={`Comment on ${side} line ${changeReviewLine(change, side).lineNumber}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLineReview(change, side);
              }}
            ><span>{renderDefault()}</span><b aria-hidden="true">+</b></button>
          );
        }}
      >
        {(rendered) => rendered.flatMap((hunk, index) => {
          const gap = gapBefore(rendered, index, hunk);
          const body = <Hunk key={hunk.content} hunk={hunk} />;
          if (gap <= 0) return [body];
          return [
            <Decoration key={`gap-${hunk.content}`}>
              <span className="changes-diff-gap">{gap} hidden {gap === 1 ? "line" : "lines"}</span>
            </Decoration>,
            body,
          ];
        })}
      </Diff>
      {hiddenLines !== undefined && hiddenLines > 0 ? (
        <p className="changes-diff-gap-total">
          {hiddenLines} {hiddenLines === 1 ? "line" : "lines"} of this file are not in the patch.
        </p>
      ) : null}
    </div>
  );
}

export function DiffState({ title, detail }: { title: string; detail: string }) {
  return <div className="changes-diff-state"><Icon name="focus" /><h2>{title}</h2><p>{detail}</p></div>;
}
