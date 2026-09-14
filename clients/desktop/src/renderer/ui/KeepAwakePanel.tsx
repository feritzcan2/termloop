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
export type KeepAwakeActions = {
  load(profileId: string): Promise<KeepAwakeStatusResult>;
  save(profileId: string, params: KeepAwakeSetParams): Promise<KeepAwakeStatusResult>;
  refreshToken: number;
};

export function KeepAwakePanel({ load, save, refreshToken, computerName, scopeLabel, embedded = false, disabled = false }: {
  load(): Promise<KeepAwakeStatusResult>;
  save(params: KeepAwakeSetParams): Promise<KeepAwakeStatusResult>;
  refreshToken: number;
  computerName?: string | undefined;
  scopeLabel?: string | undefined;
  embedded?: boolean;
  disabled?: boolean;
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
    if (disabled) { setStatus(undefined); return () => { cancelled = true; }; }
    load()
      .then((value) => { if (!cancelled) { setStatus(value); setFailure(undefined); } })
      .catch(() => { if (!cancelled) { setStatus(undefined); setFailure("Could not read the keep-awake setting."); } });
    return () => { cancelled = true; };
  }, [disabled, load]);

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
    if (!open || embedded) return;
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
  }, [embedded, open]);

  const submit = (mode: KeepAwakeMode, keepDisplayAwake: boolean, durationSeconds: number | null) => {
    if (disabled || saving || !status) return;
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
      {!embedded ? <button
        type="button"
        className={`keep-awake-trigger${engaged ? " is-engaged" : ""}${blocked ? " is-blocked" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status ? keepAwakeSummary(status, computerName) : "Keep awake"}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="keep-awake-trigger-dot" aria-hidden="true" />
        <span className="keep-awake-trigger-label">Keep Awake{scopeLabel ? ` · ${scopeLabel}` : ""}</span>
        {countdown ? <span className="keep-awake-trigger-countdown">{countdown}</span> : null}
      </button> : null}
      {open || embedded ? <section className={`keep-awake-panel${embedded ? " embedded" : ""}`} role={embedded ? undefined : "dialog"} aria-label="Keep awake">
        <header>
          <span>{scopeLabel ? `Power · ${scopeLabel}` : "Power"}</span>
          <h2>Keep {computerName ?? "this computer"} awake</h2>
        </header>
        <div className="keep-awake-body">
          <p className={`keep-awake-status${blocked ? " is-blocked" : ""}`}>
            {disabled ? "Connect to this computer with write access to change its power settings." : status ? keepAwakeSummary(status, computerName) : "Reading the current setting…"}
          </p>
          <fieldset disabled={disabled || saving || status === undefined}>
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
                <small>{keepAwakeModeHint(mode, computerName)}</small>
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
              disabled={disabled || saving || status === undefined}
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
              disabled={disabled || saving || status === undefined || status.mode === "off"}
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
