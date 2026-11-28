import { useEffect, useState } from "react";

import type { TelemetryStatus } from "../../telemetry-status.js";
import { SettingsSwitch } from "./SettingsSwitch.js";

export type TelemetryActions = {
  load(): Promise<TelemetryStatus>;
  set(enabled: boolean): Promise<TelemetryStatus>;
};

export function DiagnosticsSettings({ actions }: { actions: TelemetryActions }) {
  const [status, setStatus] = useState<TelemetryStatus>();
  const [loadingError, setLoadingError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void actions.load().then(
      (value) => { if (active) { setStatus(value); setLoadingError(undefined); } },
      (error) => { if (active) setLoadingError(errorMessage(error)); },
    );
    return () => { active = false; };
  }, [actions]);

  const change = async (enabled: boolean) => {
    if (status?.state !== "available" || saving) return;
    const previous = status;
    setStatus({ ...status, enabled });
    setSaving(true);
    setSaveError(undefined);
    try {
      setStatus(await actions.set(enabled));
    } catch (error) {
      setStatus(previous);
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="startup-settings" aria-labelledby="diagnostics-settings-title">
      <div className="settings-page-header">
        <h3 id="diagnostics-settings-title">Diagnostics</h3>
        <p>Help improve TermLoop by sending anonymous usage and error reports.</p>
      </div>
      {status ? (
        <>
          <SettingsSwitch
            checked={status.state === "available" && status.enabled}
            disabled={saving || status.state !== "available"}
            title="Send usage and error reports"
            description={status.state === "available"
              ? "Counts app launches with a random install ID and reports app errors. Terminal contents, project names, and personal data are never sent."
              : "Reporting is not available in this build."}
            change={(checked) => void change(checked)}
          />
          {status.state === "available" && status.restartRequired ? (
            <p className="settings-footnote" role="status">Reporting starts the next time TermLoop opens.</p>
          ) : null}
        </>
      ) : loadingError ? (
        <p className="settings-error" role="alert">Could not load diagnostics settings: {loadingError}</p>
      ) : (
        <p className="settings-loading" role="status">Loading diagnostics settings…</p>
      )}
      {saveError ? <p className="settings-error" role="alert">Could not change diagnostics settings: {saveError}</p> : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
