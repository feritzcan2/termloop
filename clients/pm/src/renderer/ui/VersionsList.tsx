import type { PmTicketAuthor, PmTicketVersion } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

const AUTHOR_LABEL: Record<PmTicketAuthor, string> = { pm: "you", agent: "assistant", jira: "jira" };
const AUTHOR_TITLE: Record<PmTicketAuthor, string> = {
  pm: "Saved by the project manager",
  agent: "An agent proposal the project manager accepted",
  jira: "Pulled from Jira",
};

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export type VersionsListProps = {
  versions: PmTicketVersion[] | undefined;
  now: number;
  onRestore(description: string): void;
};

/** The description history, newest first. Restoring only fills the editor. */
export function VersionsList(props: VersionsListProps) {
  if (!props.versions) return <p className="hint">Loading versions…</p>;
  if (props.versions.length === 0) return <p className="hint">No saved versions yet.</p>;
  const versions = [...props.versions].sort((left, right) => right.number - left.number);
  return (
    <ol className="versions" aria-label="Description versions">
      {versions.map((version) => (
        <li key={version.number}>
          <b>v{version.number}</b>
          <span className="version-text" title={version.description}>{version.description.split("\n", 1)[0]!.slice(0, 160) || <em>Empty</em>}</span>
          <button type="button" className="btn sm ghost restore" onClick={() => props.onRestore(version.description)}>Load into editor</button>
          <time dateTime={new Date(version.recordedAtEpochMs).toISOString()} title={`${AUTHOR_TITLE[version.author]} · ${TIME.format(version.recordedAtEpochMs)}`}>
            {AUTHOR_LABEL[version.author]} · {relativeTime(version.recordedAtEpochMs, props.now)}
          </time>
        </li>
      ))}
    </ol>
  );
}
