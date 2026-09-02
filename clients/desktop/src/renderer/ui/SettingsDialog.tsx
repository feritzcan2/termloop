import { useEffect, useState } from "react";

import type { NotificationPreferences } from "../../notification-preferences.js";
import {
  ConnectionProfilesDialog,
  type ConnectionProfilesDialogProps,
} from "./ConnectionProfilesDialog.js";

export type SettingsPage = "notifications" | "servers";

type SettingsDialogProps = Omit<ConnectionProfilesDialogProps, "close" | "embedded"> & {
  close(): void;
  initialPage?: SettingsPage;
  loadNotificationPreferences(): Promise<NotificationPreferences>;
  saveNotificationPreferences(preferences: NotificationPreferences): Promise<NotificationPreferences>;
};

export function SettingsDialog({
  close,
  initialPage = "notifications",
  loadNotificationPreferences,
  saveNotificationPreferences,
  ...connectionProps
}: SettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [preferences, setPreferences] = useState<NotificationPreferences>();
  const [loadingError, setLoadingError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void loadNotificationPreferences().then(
      (value) => {
        if (!active) return;
        setPreferences(value);
        setLoadingError(undefined);
      },
      (error) => {
        if (active) setLoadingError(errorMessage(error));
      },
    );
    return () => { active = false; };
  }, [loadNotificationPreferences]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const updatePreference = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!preferences || saving) return;
    const previous = preferences;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setSaving(true);
    setSaveError(undefined);
    try {
      setPreferences(await saveNotificationPreferences(next));
    } catch (error) {
      setPreferences(previous);
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-layer" role="presentation">
      <button className="settings-backdrop" type="button" tabIndex={-1} aria-label="Close settings" onClick={close} />
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span>TermLoop</span><h2 id="settings-title">Settings</h2></div>
          <button type="button" aria-label="Close" onClick={close}>×</button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <button type="button" className={page === "notifications" ? "active" : ""} aria-current={page === "notifications" ? "page" : undefined} onClick={() => setPage("notifications")}>Notifications</button>
            <button type="button" className={page === "servers" ? "active" : ""} aria-current={page === "servers" ? "page" : undefined} onClick={() => setPage("servers")}>Servers</button>
          </nav>
          <main className="settings-content">
            {page === "notifications" ? (
              <NotificationSettings
                preferences={preferences}
                loadingError={loadingError}
                saveError={saveError}
                saving={saving}
                update={updatePreference}
              />
            ) : (
              <>
                <div className="settings-page-header">
                  <h3>Servers</h3>
                  <p>Connect to other TermLoop computers or share this one.</p>
                </div>
                <ConnectionProfilesDialog {...connectionProps} embedded close={close} />
              </>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function NotificationSettings({
  loadingError,
  preferences,
  saveError,
  saving,
  update,
}: {
  loadingError: string | undefined;
  preferences: NotificationPreferences | undefined;
  saveError: string | undefined;
  saving: boolean;
  update(key: keyof NotificationPreferences, value: boolean): Promise<void>;
}) {
  return (
    <section className="notification-settings" aria-labelledby="notification-settings-title">
      <div className="settings-page-header">
        <h3 id="notification-settings-title">Notifications</h3>
        <p>Choose when TermLoop should notify you that an Agent needs input.</p>
      </div>
      {preferences ? (
        <div className="settings-card">
          <SettingsSwitch
            checked={preferences.enabled}
            disabled={saving}
            title="Agent attention notifications"
            description="Show a desktop notification when an Agent needs input."
            change={(checked) => void update("enabled", checked)}
          />
          <SettingsSwitch
            checked={preferences.notifyWhenFocused}
            disabled={saving || !preferences.enabled}
            title="Show while TermLoop is active"
            description="Also notify when this window is already focused."
            change={(checked) => void update("notifyWhenFocused", checked)}
          />
          <SettingsSwitch
            checked={preferences.playSound}
            disabled={saving || !preferences.enabled}
            title="Play notification sound"
            description="Use the system notification sound for Agent alerts."
            change={(checked) => void update("playSound", checked)}
          />
        </div>
      ) : loadingError ? (
        <p className="settings-error" role="alert">Could not load notification settings: {loadingError}</p>
      ) : (
        <p className="settings-loading" role="status">Loading notification settings…</p>
      )}
      {saveError ? <p className="settings-error" role="alert">Could not save notification settings: {saveError}</p> : null}
      <p className="settings-footnote">System notification permissions can also be changed in your operating system settings.</p>
    </section>
  );
}

function SettingsSwitch({
  change,
  checked,
  description,
  disabled,
  title,
}: {
  change(checked: boolean): void;
  checked: boolean;
  description: string;
  disabled: boolean;
  title: string;
}) {
  return (
    <div className={disabled ? "settings-row disabled" : "settings-row"}>
      <div><strong>{title}</strong><small>{description}</small></div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={checked ? "settings-switch on" : "settings-switch"}
        disabled={disabled}
        onClick={() => change(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
