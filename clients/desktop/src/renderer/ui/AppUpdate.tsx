import type { UpdateSnapshot, UpdateStatus } from "../../update-status.js";
import { Icon } from "./Icon.js";

export type AppUpdateControls = {
  snapshot: UpdateSnapshot;
  check(): void;
  install(): void;
};

/// The sidebar keeps a found update visible from download through restart, so a
/// dismissed restart dialog never hides it. Quiet states stay in Settings.
export function UpdateNotice({ update }: { update: AppUpdateControls }) {
  const { status } = update.snapshot;
  if (status.state === "downloading") {
    return (
      <section className="update-notice" data-state="downloading" aria-label="Application update" aria-live="polite">
        <Icon name="download" />
        <div className="update-notice-copy">
          <strong>Downloading update</strong>
          <span>TermLoop {status.version}{status.percent === null ? "" : ` · ${status.percent}%`}</span>
          <progress max={100} value={status.percent ?? undefined} aria-label="Update download progress" />
        </div>
      </section>
    );
  }
  if (status.state === "ready" || status.state === "installing") {
    const installing = status.state === "installing";
    return (
      <section className="update-notice" data-state={status.state} aria-label="Application update" aria-live="polite">
        <Icon name="download" />
        <div className="update-notice-copy">
          <strong>{installing ? "Restarting to update…" : "Update ready"}</strong>
          <span>TermLoop {status.version}</span>
        </div>
        <button className="primary-button" type="button" disabled={installing} onClick={update.install}>Restart</button>
      </section>
    );
  }
  if (status.state === "failed" && status.version) {
    return (
      <section className="update-notice" data-state="failed" aria-label="Application update" aria-live="polite">
        <Icon name="alert" />
        <div className="update-notice-copy">
          <strong>Update download failed</strong>
          <span>TermLoop {status.version}</span>
        </div>
        <button className="secondary-button" type="button" onClick={update.check}>Retry</button>
      </section>
    );
  }
  return null;
}

export function UpdateSettings({ update }: { update: AppUpdateControls | undefined }) {
  const status: UpdateStatus = update?.snapshot.status ?? { state: "unsupported" };
  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";
  return (
    <section className="update-settings" aria-labelledby="update-settings-title">
      <div className="settings-page-header">
        <h3 id="update-settings-title">Updates</h3>
        <p>TermLoop checks for updates when it starts and every hour, downloads them in the background, and asks before restarting.</p>
      </div>
      <dl className="update-settings-facts">
        <div><dt>Current version</dt><dd>{update ? update.snapshot.currentVersion : "Unknown"}</dd></div>
        <div><dt>Status</dt><dd role="status">{updateStatusText(status)}</dd></div>
      </dl>
      {status.state === "unsupported" || !update ? null : (
        <div className="update-settings-actions">
          {status.state === "ready" || status.state === "installing" ? (
            <button className="primary-button" type="button" disabled={status.state === "installing"} onClick={update.install}>
              Restart and update
            </button>
          ) : (
            <button className="secondary-button" type="button" disabled={busy} onClick={update.check}>
              {status.state === "checking" ? "Checking…" : "Check for updates"}
            </button>
          )}
        </div>
      )}
      <p className="settings-footnote">
        {status.state === "unsupported"
          ? "Automatic updates are available in the installed macOS and Windows app."
          : "Restarting shuts down running terminals and the managed local service gracefully. A downloaded update you postpone installs the next time you quit TermLoop."}
      </p>
    </section>
  );
}

export function updateStatusText(status: UpdateStatus): string {
  switch (status.state) {
    case "unsupported": return "Automatic updates are off in this build.";
    case "idle": return "Waiting for the first check.";
    case "checking": return "Checking for updates…";
    case "current": return "TermLoop is up to date.";
    case "downloading": return `Downloading TermLoop ${status.version}${status.percent === null ? "…" : ` (${status.percent}%)`}`;
    case "ready": return `TermLoop ${status.version} is ready to install.`;
    case "installing": return `Restarting to install TermLoop ${status.version}…`;
    case "failed": return status.version
      ? `Downloading TermLoop ${status.version} failed.`
      : "The update server could not be reached.";
  }
}
