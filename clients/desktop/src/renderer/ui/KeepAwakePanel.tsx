import { useCallback, useEffect, useRef, useState } from "react";
import type { KeepAwakeMode, KeepAwakeSetParams, KeepAwakeStatusResult } from "@termloop/contract/current";
import {
  KEEP_AWAKE_MODES,
  KEEP_AWAKE_DURATIONS,
  keepAwakeCountdown,
  keepAwakeDurationLabel,
  keepAwakeIsBlocked,
  keepAwakeIsEngaged,
  keepAwakeLimitationSentence,
  keepAwakeModeHint,
  keepAwakeModeLabel,
  keepAwakeSummary,
} from "../keep-awake.js";

/**
 * Sidebar-footer control for the daemon-owned keep-awake hold.
 *
 * The trigger reads as a switch; opening it reveals the full choice, because
 * "keep this computer awake" has more than one honest answer: only while
 * agents run, always, and whether the screen should stay lit too.
 */
export function KeepAwakePanel({ load, save, refreshToken }: {
  load(): Promise<KeepAwakeStatusResult>;
  save(params: KeepAwakeSetParams): Promise<KeepAwakeStatusResult>;
  refreshToken: number;
}) {
  type DurationSelection = "none" | "active" | number;
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<KeepAwakeStatusResult>();
  const [durationSelection, setDurationSelection] = useState<DurationSelection>("none");
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    load()
      .then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => { if (!cancelled) setFailure("Could not read the keep-awake setting."); });
    return () => { cancelled = true; };
  }, [load]);

  // The daemon flips the hold on its own as agents start and exit, so the
  // panel follows the projection instead of only its own writes.
  useEffect(() => refresh(), [refresh, refreshToken]);

  useEffect(() => {
    if (!status) return;
    const timerActive = status.expiresAtEpochMs !== null
      && status.expiresAtEpochMs > Date.now();
    setDurationSelection((current) => timerActive
      ? current === "none" ? "active" : current
      : "none");
  }, [status]);

  useEffect(() => {
    const expiresAt = status?.expiresAtEpochMs;
    if (expiresAt === null || expiresAt === undefined || expiresAt <= Date.now()) return;
    setNowEpochMs(Date.now());
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNowEpochMs(current);
      if (current >= expiresAt) window.clearInterval(interval);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [status?.expiresAtEpochMs]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  const submit = (mode: KeepAwakeMode, keepDisplayAwake: boolean, durationSeconds: number | null) => {
    setSaving(true);
    setFailure(undefined);
    save({ mode, keepDisplayAwake, durationSeconds })
      .then(setStatus)
      .catch(() => setFailure("The daemon rejected that change."))
      .finally(() => setSaving(false));
  };

  const engaged = keepAwakeIsEngaged(status);
  const blocked = keepAwakeIsBlocked(status);
  const limitations = status ? keepAwakeLimitationSentence(status.limitations) : undefined;
  const countdown = status?.state === "active"
    ? keepAwakeCountdown(status.expiresAtEpochMs, nowEpochMs)
    : undefined;

  return (
    <div ref={rootRef} className="keep-awake-control">
      <button
        type="button"
        className={`keep-awake-trigger${engaged ? " is-engaged" : ""}${blocked ? " is-blocked" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status ? keepAwakeSummary(status) : "Keep awake"}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="keep-awake-trigger-dot" aria-hidden="true" />
        <span>Keep Awake</span>
        {countdown ? <span className="keep-awake-trigger-countdown">{countdown}</span> : null}
      </button>
      {open ? <section className="keep-awake-panel" role="dialog" aria-label="Keep awake">
        <header>
          <span>Power</span>
          <h2>Keep this computer awake</h2>
        </header>
        <div className="keep-awake-body">
          <p className={`keep-awake-status${blocked ? " is-blocked" : ""}`}>
            {status ? keepAwakeSummary(status) : "Reading the current setting…"}
          </p>
          <fieldset disabled={saving || status === undefined}>
            <legend>When</legend>
            {KEEP_AWAKE_MODES.map((mode) => <label key={mode} className="keep-awake-option">
              <input
                type="radio"
                name="keep-awake-mode"
                value={mode}
                checked={status?.mode === mode}
                onChange={() => {
                  setDurationSelection("none");
                  submit(mode, status?.keepDisplayAwake ?? false, null);
                }}
              />
              <span>
                <strong>{keepAwakeModeLabel(mode)}</strong>
                <small>{keepAwakeModeHint(mode)}</small>
              </span>
            </label>)}
          </fieldset>
          <label className="keep-awake-timer">
            <span>
              <strong>Timer</strong>
              <small>Keep the computer awake for a limited time.</small>
            </span>
            <select
              value={durationSelection === "active" ? "active" : durationSelection === "none" ? "none" : String(durationSelection)}
              disabled={saving || status === undefined}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "active") return;
                const duration = value === "none" ? null : Number(value);
                setDurationSelection(duration === null ? "none" : duration);
                submit(duration === null ? (status?.mode ?? "off") : "always", status?.keepDisplayAwake ?? false, duration);
              }}
            >
              <option value="none">No timer</option>
              {durationSelection === "active" ? <option value="active">Timer active</option> : null}
              {KEEP_AWAKE_DURATIONS.map((duration) => <option key={duration} value={duration}>{keepAwakeDurationLabel(duration)}</option>)}
            </select>
          </label>
          <label className="keep-awake-toggle">
            <input
              type="checkbox"
              checked={status?.keepDisplayAwake ?? false}
              disabled={saving || status === undefined || status.mode === "off"}
              onChange={(event) => submit(status?.mode ?? "off", event.target.checked, typeof durationSelection === "number" ? durationSelection : null)}
            />
            <span>
              <strong>Keep the display on too</strong>
              <small>Off by default — the screen sleeps while the machine keeps working.</small>
            </span>
          </label>
          {limitations ? <p className="keep-awake-caveat">{limitations}</p> : null}
          {failure ? <p className="keep-awake-failure">{failure}</p> : null}
        </div>
      </section> : null}
    </div>
  );
}
