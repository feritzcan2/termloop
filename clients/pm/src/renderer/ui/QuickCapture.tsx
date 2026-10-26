import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PmSprint, PmTicketPriority } from "@termloop/pm-contract/pm";
import { PRIORITY_LABEL, PRIORITY_ORDER } from "./format.js";
import type { TicketCapture } from "./types.js";

const BACKLOG = "";

/**
 * The quick capture overlay (double Shift or Cmd/Ctrl+N): one title line and
 * a compact row of sprint, priority, assignee and the assistant draft toggle.
 * Enter creates and closes; Shift+Enter creates and stays open for the next
 * ticket with the row's choices kept. Esc or a backdrop click closes.
 * `onCreate` resolves true once the ticket exists.
 */
export function QuickCapture(props: {
  sprints: PmSprint[];
  defaultSprintId: string | null;
  assignees: string[];
  canAskAssistant: boolean;
  onCreate(capture: TicketCapture): Promise<boolean>;
  onClose(): void;
}) {
  const title = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<TicketCapture>(() => ({
    title: "",
    sprintId: props.defaultSprintId,
    priority: "medium",
    assignee: "",
    askAssistant: props.canAskAssistant,
  }));
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<TicketCapture>) => setDraft((current) => ({ ...current, ...patch }));
  const openSprints = props.sprints.filter((sprint) => sprint.state !== "closed");

  useEffect(() => { title.current?.focus(); }, []);

  const submit = async (keepOpen: boolean) => {
    if (busy || !draft.title.trim()) return;
    setBusy(true);
    const created = await props.onCreate({ ...draft, askAssistant: draft.askAssistant && props.canAskAssistant });
    setBusy(false);
    if (!created) return;
    if (!keepOpen) {
      props.onClose();
      return;
    }
    update({ title: "" });
    title.current?.focus();
  };
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit(event.shiftKey);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };

  return (
    <div className="capture-layer" onKeyDown={closeOnEscape}>
      <button type="button" className="capture-backdrop" aria-label="Close quick capture" tabIndex={-1} onClick={props.onClose} />
      <div className="capture" role="dialog" aria-modal="true" aria-label="Quick capture">
        <input
          ref={title}
          className="capture-title"
          aria-label="Ticket title"
          placeholder="What needs doing?"
          maxLength={160}
          value={draft.title}
          disabled={busy}
          onChange={(event) => update({ title: event.target.value })}
          onKeyDown={submitOnEnter}
        />
        <div className="capture-options">
          <label className="capture-chip">
            <span>SPRINT</span>
            <select
              aria-label="Sprint"
              value={draft.sprintId ?? BACKLOG}
              onChange={(event) => update({ sprintId: event.target.value === BACKLOG ? null : event.target.value })}
            >
              {openSprints.map((sprint) => (
                <option key={sprint.id} value={sprint.id}>{sprint.name}{sprint.state === "active" ? " (active)" : ""}</option>
              ))}
              <option value={BACKLOG}>Backlog</option>
            </select>
          </label>
          <label className="capture-chip">
            <span>PRIORITY</span>
            <select aria-label="Priority" value={draft.priority} onChange={(event) => update({ priority: event.target.value as PmTicketPriority })}>
              {PRIORITY_ORDER.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
            </select>
          </label>
          <label className="capture-chip assignee">
            <span>ASSIGNEE</span>
            <input
              aria-label="Assignee"
              placeholder="Unassigned"
              list="capture-assignees"
              maxLength={120}
              value={draft.assignee}
              onChange={(event) => update({ assignee: event.target.value })}
              onKeyDown={submitOnEnter}
            />
            <datalist id="capture-assignees">
              {props.assignees.map((assignee) => <option key={assignee} value={assignee} />)}
            </datalist>
          </label>
          <label className="capture-check" title={props.canAskAssistant ? undefined : "Select a project to start Steward"}>
            <input
              type="checkbox"
              checked={draft.askAssistant && props.canAskAssistant}
              disabled={!props.canAskAssistant}
              onChange={(event) => update({ askAssistant: event.target.checked })}
            />
            Ask Steward to draft the description
          </label>
        </div>
        <div className="capture-hint">
          <span><kbd>Enter</kbd> create</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> create and add another</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/** The confirmation line after a capture; clicking it opens the ticket. */
export function CaptureToast(props: { label: string; onOpen(): void; onDismiss(): void }) {
  return (
    <div className="capture-toast" role="status">
      <button type="button" className="link plain" onClick={props.onOpen}>Created <b>{props.label}</b></button>
      <button type="button" className="icb" aria-label="Dismiss" onClick={props.onDismiss}>×</button>
    </div>
  );
}
