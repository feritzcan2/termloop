import { useEffect, useState } from "react";

import type { LaunchAtLoginStatus } from "../../launch-at-login.js";
import { SettingsSwitch } from "./SettingsSwitch.js";

export type LaunchAtLoginActions = {
  load(): Promise<LaunchAtLoginStatus>;
  set(enabled: boolean): Promise<LaunchAtLoginStatus>;
};

export function StartupSettings({ actions }: { actions: LaunchAtLoginActions }) {
  const [status, setStatus] = useState<LaunchAtLoginStatus>();
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
    <section className="startup-settings" aria-labelledby="startup-settings-title">
      <div className="settings-page-header">
        <h3 id="startup-settings-title">Startup</h3>
        <p>Choose what TermLoop does when you sign in to this computer.</p>
      </div>
      {status ? (
        <>
          <SettingsSwitch
            checked={status.state === "available" && status.enabled}
            disabled={saving || status.state !== "available"}
            title="Open TermLoop at login"
            description={launchAtLoginDescription(status)}
            change={(checked) => void change(checked)}
          />
          {status.state === "available" && status.requiresApproval ? (
            <p className="settings-footnote" role="status">
              macOS is waiting for your approval. Allow TermLoop in System Settings › General › Login Items.
            </p>
          ) : null}
        </>
      ) : loadingError ? (
        <p className="settings-error" role="alert">Could not load startup settings: {loadingError}</p>
      ) : (
        <p className="settings-loading" role="status">Loading startup settings…</p>
      )}
      {saveError ? <p className="settings-error" role="alert">Could not change startup settings: {saveError}</p> : null}
    </section>
  );
}

function launchAtLoginDescription(status: LaunchAtLoginStatus): string {
  if (status.state === "available") return "Start TermLoop automatically after you sign in.";
  return status.reason === "development"
    ? "Available only in an installed build. A development run cannot register itself as a login item."
    : "This operating system does not support opening TermLoop at login.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
