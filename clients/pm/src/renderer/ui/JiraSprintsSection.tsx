import { useEffect, useState } from "react";
import type { PmJiraBoardSprint, PmSprint } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import type { JiraSprintsView } from "./types.js";

export type JiraSprintsSectionProps = {
  /** Whether the project has a Jira source. */
  connected: boolean;
  /** The board sprints come from; null until one is chosen. */
  boardId: number | null;
  view: JiraSprintsView | undefined;
  /** The project's sprints, to tell which Jira sprints are imported. */
  sprints: PmSprint[];
  onLoad(chooseBoard?: boolean): void;
  onSetBoard(boardId: number): void;
  onImport(jiraSprintId: number): void;
  onSelectSprint(sprintId: string): void;
  onOpenSettings(): void;
};

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** "active · Oct 13 – Oct 27" style line of a Jira sprint. */
export function jiraSprintDates(sprint: PmJiraBoardSprint): string {
  const start = sprint.startEpochMs !== null ? DATE.format(sprint.startEpochMs) : undefined;
  const end = sprint.endEpochMs !== null ? DATE.format(sprint.endEpochMs) : undefined;
  const range = start && end ? `${start} – ${end}` : end ? `ends ${end}` : start ? `from ${start}` : undefined;
  return range ? `${sprint.state} · ${range}` : sprint.state;
}

/**
 * The Sprints panel's view of the project's Jira board: choose the board,
 * then see its active and future sprints and import one with its issues, or
 * sync one already imported.
 */
export function JiraSprintsSection(props: JiraSprintsSectionProps) {
  const { view, onLoad } = props;
  const needsRead = props.connected && view === undefined;
  useEffect(() => {
    if (needsRead) onLoad();
  }, [needsRead, onLoad]);
  const choosing = view?.boards !== undefined;
  const title = props.boardId !== null && !choosing ? `Jira board ${props.boardId}` : "Jira";
  return (
    <section aria-label="Jira sprints">
      <div className="rail-subhead jira-subhead">
        <span>{title}</span>
        {props.connected && (
          <span className="jira-subhead-actions">
            {props.boardId !== null && !choosing && (
              <button type="button" className="btn sm ghost" onClick={() => onLoad(true)}>Change board</button>
            )}
            {choosing && props.boardId !== null && (
              <button type="button" className="btn sm ghost" onClick={() => onLoad()}>Cancel</button>
            )}
            <button type="button" className="icb" title="Read Jira again" aria-label="Read Jira again" disabled={view?.loading} onClick={() => onLoad(choosing)}>
              <Icon name="refresh" />
            </button>
          </span>
        )}
      </div>
      {!props.connected ? (
        <p className="rail-empty">
          Connect Jira to see its sprints.{" "}
          <button type="button" className="link" onClick={props.onOpenSettings}>Open Settings</button>
        </p>
      ) : view?.error ? (
        <p className="rail-empty jira-error" role="alert">{view.error}</p>
      ) : choosing ? (
        <BoardPicker view={view} current={props.boardId} onSetBoard={props.onSetBoard} />
      ) : view?.sprints ? (
        <SprintList {...props} view={view} />
      ) : (
        <p className="rail-empty">Reading Jira…</p>
      )}
    </section>
  );
}

/** Boards whose name, project, or id contain every word of the filter; the current board first. */
export function filterBoards<B extends { id: number; name: string; location: string | null }>(boards: B[], filter: string, current: number | null): B[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = boards.filter((board) => {
    const text = `${board.name} ${board.location ?? ""} ${board.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return [...matching.filter((board) => board.id === current), ...matching.filter((board) => board.id !== current)];
}

function BoardPicker(props: { view: JiraSprintsView; current: number | null; onSetBoard(boardId: number): void }) {
  const [filter, setFilter] = useState("");
  const boards = props.view.boards?.boards ?? [];
  if (props.view.loading && boards.length === 0) return <p className="rail-empty">Reading boards…</p>;
  if (boards.length === 0) return <p className="rail-empty">This Jira account sees no boards.</p>;
  const shown = filterBoards(boards, filter, props.current);
  return (
    <>
      <div className="rail-form">
        <input
          type="search"
          aria-label="Filter boards"
          placeholder={`Filter ${boards.length} boards by name, project, or id`}
          value={filter}
          autoFocus
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="list" aria-label="Jira boards">
        {shown.map((board) => (
          <button
            key={board.id}
            type="button"
            className={`row jira-board-row ${board.id === props.current ? "active" : ""}`}
            onClick={() => props.onSetBoard(board.id)}
          >
            <span className="sq" />
            <span className="copy">
              <span className="row-title">{board.name}</span>
              <span className="row-sub"><span>{[board.kind, board.location, `#${board.id}`].filter(Boolean).join(" · ")}</span></span>
            </span>
            <span />
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="rail-empty">No board matches.</p>}
      {props.view.boards?.truncated && <p className="rail-empty">Only the first boards are listed.</p>}
    </>
  );
}

function SprintList(props: JiraSprintsSectionProps & { view: JiraSprintsView }) {
  const read = props.view.sprints;
  if (!read) return null;
  if (!read.sprintsSupported) return <p className="rail-empty">This board has no sprints. Choose a Scrum board.</p>;
  if (read.sprints.length === 0) return <p className="rail-empty">No active or future sprints on this board.</p>;
  return (
    <>
      <div className="list" aria-label="Jira board sprints">
        {read.sprints.map((jira) => {
          const mirror = props.sprints.find((sprint) => sprint.id === jira.sprintId);
          const importing = props.view.importing === jira.jiraSprintId;
          const frozen = mirror?.state === "closed";
          return (
            <div key={jira.jiraSprintId} className="jira-sprint-item">
              <button
                type="button"
                className="row sprint-row jira-sprint-row"
                data-state={jira.state === "active" ? "active" : "planned"}
                disabled={!mirror}
                title={mirror ? `Open ${mirror.name}` : "Not imported yet"}
                onClick={() => mirror && props.onSelectSprint(mirror.id)}
              >
                <span className="sq" />
                <span className="copy">
                  <span className="row-title">{jira.name}</span>
                  <span className="row-sub"><span>{jiraSprintDates(jira)}</span></span>
                </span>
                <span />
              </button>
              {frozen ? (
                <span className="chip off jira-sprint-action" title="This sprint is closed in the PM; it is not imported again">closed here</span>
              ) : (
                <button
                  type="button"
                  className={`btn sm ${mirror ? "ghost" : "pri"} jira-sprint-action`}
                  disabled={props.view.importing !== undefined}
                  title={mirror ? "Read this sprint's issues from Jira again" : "Import this sprint and its issues"}
                  onClick={() => props.onImport(jira.jiraSprintId)}
                >
                  {importing ? "Importing…" : mirror ? "Sync" : "Import"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {read.truncated && <p className="rail-empty">Only the first sprints are shown.</p>}
    </>
  );
}
