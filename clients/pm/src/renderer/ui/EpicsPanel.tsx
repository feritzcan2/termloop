import { useState } from "react";
import type { PmBoardTicket, PmEpic, PmEpicBreakdown, PmSprint } from "@termloop/pm-contract/pm";
import { ticketLabel } from "./format.js";
import { Icon } from "./icons.js";

export type EpicsPanelProps = {
  epics: PmEpic[];
  breakdowns: PmEpicBreakdown[];
  tickets: PmBoardTicket[];
  sprints: PmSprint[];
  canCreate: boolean;
  onCreate(title: string, description: string): void;
  onRename(epicId: string, title: string): void;
  onDelete(epicId: string): void;
  /** Asks Steward to split a goal (or this epic) into tasks. */
  onPlan(epicId?: string): void;
  onOpenTicket(ticketId: string): void;
  /** Resolves true once the kept tasks are tickets. */
  onAccept(breakdownId: string, taskIndices: number[], sprintId: string | null): Promise<boolean>;
  onReject(breakdownId: string): void;
};

/**
 * The right sidebar's "Epics" view: the assistant's breakdowns waiting for
 * the PM first, then each epic with its progress and tickets. A breakdown
 * changes nothing until the PM accepts the tasks it keeps.
 */
export function EpicsPanel(props: EpicsPanelProps) {
  const [composing, setComposing] = useState(false);
  return (
    <div className="epics-panel">
      <div className="right-sidebar-tools">
        <span className="count-badge" title="Epics">{props.epics.length}</span>
        <span className="sp" />
        <button type="button" className="btn sm" disabled={!props.canCreate} title="Steward splits a goal into tasks for you to review" onClick={() => props.onPlan()}>
          Plan with Steward
        </button>
        <button type="button" className="view-action" disabled={!props.canCreate} onClick={() => setComposing(!composing)}>
          <Icon name="plus" />New epic
        </button>
      </div>
      {composing && <EpicForm onCreate={(title, description) => { props.onCreate(title, description); setComposing(false); }} onCancel={() => setComposing(false)} />}
      {props.breakdowns.length > 0 && (
        <>
          <div className="rail-subhead">Waiting for you</div>
          {props.breakdowns.map((breakdown) => (
            <BreakdownCard
              key={breakdown.id}
              breakdown={breakdown}
              epic={props.epics.find((epic) => epic.id === breakdown.epicId)}
              sprints={props.sprints}
              onAccept={(indices, sprintId) => props.onAccept(breakdown.id, indices, sprintId)}
              onReject={() => props.onReject(breakdown.id)}
            />
          ))}
        </>
      )}
      {props.epics.length === 0
        ? <p className="rail-empty">No epics yet. Create one, or ask Steward to plan a goal into tasks.</p>
        : (
          <ul className="epic-list" aria-label="Epics">
            {props.epics.map((epic) => (
              <EpicRow
                key={epic.id}
                epic={epic}
                tickets={props.tickets.filter((entry) => entry.ticket.epicId === epic.id)}
                onRename={(title) => props.onRename(epic.id, title)}
                onDelete={() => props.onDelete(epic.id)}
                onPlan={() => props.onPlan(epic.id)}
                onOpenTicket={props.onOpenTicket}
              />
            ))}
          </ul>
        )}
    </div>
  );
}

function EpicForm(props: { onCreate(title: string, description: string): void; onCancel(): void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      className="rail-form"
      onKeyDown={(event) => { if (event.key === "Escape") props.onCancel(); }}
      onSubmit={(event) => { event.preventDefault(); if (title.trim()) props.onCreate(title, description); }}
    >
      <input autoFocus placeholder="Epic title" aria-label="Epic title" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
      <input placeholder="Goal (optional)" aria-label="Epic goal" value={description} onChange={(event) => setDescription(event.target.value)} />
      <div className="rail-form-actions">
        <button type="button" className="btn sm ghost" onClick={props.onCancel}>Cancel</button>
        <button type="submit" className="btn sm pri" disabled={!title.trim()}>Create epic</button>
      </div>
    </form>
  );
}

function EpicRow(props: {
  epic: PmEpic;
  tickets: PmBoardTicket[];
  onRename(title: string): void;
  onDelete(): void;
  onPlan(): void;
  onOpenTicket(ticketId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(props.epic.title);
  const [confirming, setConfirming] = useState(false);
  const done = props.tickets.filter((entry) => entry.ticket.status === "done").length;
  const total = props.tickets.length;
  const commit = () => {
    setRenaming(false);
    if (title.trim() && title.trim() !== props.epic.title) props.onRename(title.trim());
    else setTitle(props.epic.title);
  };
  return (
    <li className="epic-row">
      <div className="epic-head">
        <button type="button" className="icb" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${props.epic.title}`} onClick={() => setOpen(!open)}>
          <Icon name={open ? "down" : "right"} />
        </button>
        {renaming ? (
          <input
            autoFocus
            aria-label="Epic title"
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") { setRenaming(false); setTitle(props.epic.title); }
            }}
          />
        ) : (
          <b className="epic-title" title={props.epic.description || undefined} onDoubleClick={() => setRenaming(true)}>{props.epic.title}</b>
        )}
        <span className="sp" />
        <span className="done" title="Done tickets">{done}/{total}</span>
      </div>
      <div className="epic-progress" role="progressbar" aria-label={`${props.epic.title} progress`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <i style={{ width: total === 0 ? "0%" : `${Math.round((done / total) * 100)}%` }} />
      </div>
      {open && (
        <>
          {props.epic.description && <p className="hint epic-goal">{props.epic.description}</p>}
          {total === 0 ? <p className="hint epic-goal">No tickets yet.</p> : (
            <ul className="epic-tickets">
              {props.tickets.map((entry) => (
                <li key={entry.ticket.id}>
                  <button type="button" className={`link ${entry.ticket.status === "done" ? "muted" : ""}`} onClick={() => props.onOpenTicket(entry.ticket.id)}>
                    {ticketLabel(entry.ticket)} {entry.ticket.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="epic-actions">
            <button type="button" className="btn sm" onClick={props.onPlan}>Plan tasks</button>
            <button type="button" className="btn sm ghost" onClick={() => setRenaming(true)}>Rename</button>
            <span className="sp" />
            {confirming ? (
              <>
                <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>Keep</button>
                <button type="button" className="btn sm pri" onClick={props.onDelete}>Delete epic</button>
              </>
            ) : (
              <button type="button" className="btn sm ghost" title="Its tickets stay and belong to no epic" onClick={() => setConfirming(true)}>Delete</button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function BreakdownCard(props: {
  breakdown: PmEpicBreakdown;
  epic: PmEpic | undefined;
  sprints: PmSprint[];
  onAccept(taskIndices: number[], sprintId: string | null): Promise<boolean>;
  onReject(): void;
}) {
  const { breakdown } = props;
  const [kept, setKept] = useState(() => new Set(breakdown.tasks.map((_, index) => index)));
  const openSprints = props.sprints.filter((sprint) => sprint.state !== "closed");
  const [sprintId, setSprintId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const target = breakdown.epic ? `New epic · ${breakdown.epic.title}` : props.epic?.title ?? "Epic";
  const toggle = (index: number) => {
    const next = new Set(kept);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setKept(next);
  };
  const accept = async () => {
    setBusy(true);
    const accepted = await props.onAccept([...kept].sort((a, b) => a - b), sprintId || null);
    if (!accepted) setBusy(false);
  };
  return (
    <section className="breakdown-card" aria-label={`Breakdown for ${target}`}>
      <b>{target}</b>
      <p className="hint">{breakdown.summary}</p>
      <ul className="breakdown-tasks">
        {breakdown.tasks.map((task, index) => (
          <li key={task.title}>
            <label title={task.description || undefined}>
              <input type="checkbox" checked={kept.has(index)} onChange={() => toggle(index)} />
              <span>{task.title}</span>
              {task.acceptanceCriteria.length > 0 && <span className="meta">{task.acceptanceCriteria.length} criteria</span>}
            </label>
          </li>
        ))}
      </ul>
      <div className="breakdown-actions">
        <select aria-label="Sprint for the new tickets" value={sprintId} onChange={(event) => setSprintId(event.target.value)}>
          <option value="">Backlog</option>
          {openSprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}{sprint.state === "active" ? " · active" : ""}</option>)}
        </select>
        <span className="sp" />
        <button type="button" className="btn sm ghost" disabled={busy} onClick={props.onReject}>Discard</button>
        <button type="button" className="btn sm pri" disabled={busy || kept.size === 0} onClick={() => void accept()}>
          Create {kept.size} {kept.size === 1 ? "ticket" : "tickets"}
        </button>
      </div>
    </section>
  );
}
