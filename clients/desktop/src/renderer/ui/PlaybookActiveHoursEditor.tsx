import { useEffect, useMemo, useState } from "react";
import type { PlaybookActiveHoursDto } from "@termloop/contract/current";

import {
  PLAYBOOK_WEEKDAYS,
  playbookActiveHoursEqual,
  playbookActiveHoursIssue,
  playbookActiveHoursLabel,
  playbookActiveHoursOpensOn,
  playbookToggleWeekday,
  playbookWeekdayShortLabel,
  playbookWeekdaysLabel,
  playbookMinuteFromLabel,
  playbookMinuteLabel,
} from "./playbook-policy.js";
import "./playbook-check.css";

const DEFAULT_START = 9 * 60;
const DEFAULT_END = 18 * 60;

/** This computer's IANA zone, the natural default for a new window. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The daily hours automatic checks run in, for the whole Playbook or for
    one step. Without a window, the Playbook checks around the clock and a
    step follows the Playbook's hours. */
export function PlaybookActiveHoursEditor({
  scope,
  hours,
  inherited,
  busy,
  save,
}: {
  scope: "playbook" | "step";
  hours: PlaybookActiveHoursDto | null;
  /** The Playbook's own window, shown when a step follows it. */
  inherited?: PlaybookActiveHoursDto | null | undefined;
  busy: boolean;
  save(hours: PlaybookActiveHoursDto | null): Promise<void>;
}) {
  const [draft, setDraft] = useState<PlaybookActiveHoursDto | null>(hours);
  const startMinute = hours?.startMinute;
  const endMinute = hours?.endMinute;
  const timeZone = hours?.timeZone;
  const days = hours ? playbookWeekdaysLabel(hours) : undefined;
  useEffect(() => { setDraft(hours); },
    // Daemon refreshes return equal windows as new objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startMinute, endMinute, timeZone, days]);
  const issue = playbookActiveHoursIssue(draft);
  const changed = !playbookActiveHoursEqual(draft, hours);
  const subject = scope === "playbook" ? "Playbook" : "step";
  const draftZone = draft?.timeZone;
  const zones = useMemo(() => timeZoneChoices(draftZone), [draftZone]);
  return <div className="ap-section ap-step-check">
    <span className="ap-label">{scope === "playbook" ? "Playbook active hours" : "Active hours for this step"}</span>
    <div className="ap-step-check-fields">
      <label>
        <input type="checkbox" aria-label={`Limit ${subject} active hours`} checked={draft !== null} disabled={busy}
          onChange={(event) => setDraft(event.target.checked
            ? { startMinute: DEFAULT_START, endMinute: DEFAULT_END, timeZone: localTimeZone() }
            : null)} />
        Only between
      </label>
      {draft ? <>
        <input type="time" aria-label={`${subject} active hours start`} value={playbookMinuteLabel(draft.startMinute)} disabled={busy}
          onChange={(event) => {
            const minute = playbookMinuteFromLabel(event.target.value);
            if (minute !== undefined) setDraft({ ...draft, startMinute: minute });
          }} />
        <span>and</span>
        <input type="time" aria-label={`${subject} active hours end`} value={playbookMinuteLabel(draft.endMinute)} disabled={busy}
          onChange={(event) => {
            const minute = playbookMinuteFromLabel(event.target.value);
            if (minute !== undefined) setDraft({ ...draft, endMinute: minute });
          }} />
        <select aria-label={`${subject} active hours time zone`} value={draft.timeZone} disabled={busy}
          onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })}>
          {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
        </select>
        <span className="ap-weekdays" role="group" aria-label={`${subject} active days`}>
          {PLAYBOOK_WEEKDAYS.map((day) => <label key={day}>
            <input type="checkbox" aria-label={`${subject} active on ${day}`} disabled={busy}
              checked={playbookActiveHoursOpensOn(draft, day)}
              onChange={() => setDraft(playbookToggleWeekday(draft, day))} />
            {playbookWeekdayShortLabel(day)}
          </label>)}
        </span>
      </> : null}
      <button type="button" className="ap-btn primary" disabled={busy || !changed || issue !== undefined}
        onClick={() => void save(draft)}>Save</button>
    </div>
    <p className="ap-hint">{issue ?? hint(scope, draft, inherited)}</p>
  </div>;
}

function hint(scope: "playbook" | "step", draft: PlaybookActiveHoursDto | null, inherited: PlaybookActiveHoursDto | null | undefined): string {
  if (draft === null) {
    return scope === "playbook"
      ? "Steps are checked around the clock unless a step sets its own hours."
      : `This step follows the Playbook's hours (${playbookActiveHoursLabel(inherited)}).`;
  }
  const overnight = draft.startMinute > draft.endMinute ? " The window spans midnight." : "";
  const replaces = scope === "step" ? " These hours replace the Playbook's for this step." : "";
  return `Outside these hours automatic checks wait for the window to open; Run now still checks immediately.${overnight}${replaces}`;
}

/** Every zone the runtime knows, keeping a saved zone the list lacks. */
function timeZoneChoices(current: string | undefined): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const local = localTimeZone();
  const all = new Set([...(current ? [current] : []), local, "UTC", ...zones]);
  return [...all].sort((left, right) => left.localeCompare(right));
}
