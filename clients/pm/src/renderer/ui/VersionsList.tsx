import type { PmTicketAuthor, PmTicketVersion } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

const AUTHOR_LABEL: Record<PmTicketAuthor, string> = { pm: "You", agent: "Agent (accepted)", jira: "Jira" };

export type VersionsListProps = {
  versions: PmTicketVersion[] | undefined;
  now: number;
  onRestore(description: string): void;
};

/** The description history, newest first. Restoring only fills the editor. */
export function VersionsList(props: VersionsListProps) {
  if (!props.versions) return <p className="pm-hint">Loading versions…</p>;
  if (props.versions.length === 0) return <p className="pm-hint">No saved versions yet.</p>;
  const versions = [...props.versions].sort((left, right) => right.number - left.number);
  return (
    <ol className="pm-versions" aria-label="Description versions">
      {versions.map((version) => (
        <li key={version.number}>
          <div className="pm-version-head">
            <span className="pm-mono">v{version.number}</span>
            <span>{AUTHOR_LABEL[version.author]}</span>
            <span className="pm-muted">{relativeTime(version.recordedAtEpochMs, props.now)}</span>
            <button type="button" className="pm-button ghost small" onClick={() => props.onRestore(version.description)}>Load into editor</button>
          </div>
          <p className="pm-version-text">{version.description.slice(0, 280) || <em>Empty</em>}</p>
        </li>
      ))}
    </ol>
  );
}
