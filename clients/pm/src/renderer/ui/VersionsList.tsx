import { useState } from "react";
import type { PmTicketAuthor, PmTicketVersion } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";
import { lineDiff } from "./ProposalCard.js";

export const AUTHOR_LABEL: Record<PmTicketAuthor, string> = { pm: "you", agent: "assistant", jira: "jira" };
const AUTHOR_TITLE: Record<PmTicketAuthor, string> = {
  pm: "Saved by the project manager",
  agent: "An agent proposal the project manager accepted",
  jira: "Pulled from Jira",
};

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export type VersionsListProps = {
  versions: PmTicketVersion[] | undefined;
  headVersion: number;
  now: number;
  onRestore(description: string): void;
};

/**
 * The description history, newest first. Opening a version shows what it
 * changed from the one before; loading one only fills the editor, and saving
 * it makes it the newest version.
 */
export function VersionsList(props: VersionsListProps) {
  const [open, setOpen] = useState<number>();
  if (!props.versions) return <p className="hint">Loading versions…</p>;
  if (props.versions.length === 0) return <p className="hint">No saved versions yet. Each save, yours or an accepted draft, becomes a version here.</p>;
  const versions = [...props.versions].sort((left, right) => right.number - left.number);
  return (
    <ol className="versions" aria-label="Description versions">
      {versions.map((version, index) => {
        const previous = versions[index + 1];
        const expanded = open === version.number;
        return (
          <li key={version.number} className={expanded ? "open" : ""}>
            <button
              type="button"
              className="version-row"
              aria-expanded={expanded}
              title={expanded ? "Hide changes" : previous ? `Show changes since v${previous.number}` : "Show the first version"}
              onClick={() => setOpen(expanded ? undefined : version.number)}
            >
              <b>v{version.number}{version.number === props.headVersion && <em> current</em>}</b>
              <span className="version-text" title={version.description}>{version.description.split("\n", 1)[0]!.slice(0, 160) || <em>Empty</em>}</span>
            </button>
            {version.number === props.headVersion
              ? <span />
              : <button type="button" className="btn sm ghost restore" onClick={() => props.onRestore(version.description)}>Load into editor</button>}
            <time dateTime={new Date(version.recordedAtEpochMs).toISOString()} title={`${AUTHOR_TITLE[version.author]} · ${TIME.format(version.recordedAtEpochMs)}`}>
              {AUTHOR_LABEL[version.author]} · {relativeTime(version.recordedAtEpochMs, props.now)}
            </time>
            {expanded && (
              <div className="draft-diff version-diff" aria-label={`Changes in v${version.number}`}>
                {lineDiff(previous?.description ?? "", version.description).map((line, lineIndex) => (
                  <div key={lineIndex} className={`diff-line ${line.kind}`}>{line.text || " "}</div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
