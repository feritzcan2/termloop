import { useEffect, useState, type ReactNode } from "react";

import type {
  DesktopNotificationPreferences,
  NotificationPreferences,
  RemoteNotificationPreferences,
} from "../../notification-preferences.js";
import {
  ConnectionProfilesDialog,
  type ConnectionProfilesDialogProps,
} from "./ConnectionProfilesDialog.js";
import type { AppearanceTheme } from "../appearance-theme.js";

export type SettingsPage = "appearance" | "notifications" | "servers";

type SettingsDialogProps = Omit<ConnectionProfilesDialogProps, "close" | "embedded"> & {
  close(): void;
  initialPage?: SettingsPage;
  appearanceTheme: AppearanceTheme;
  changeAppearanceTheme(theme: AppearanceTheme): void;
  loadNotificationPreferences(): Promise<NotificationPreferences>;
  saveNotificationPreferences(preferences: NotificationPreferences): Promise<NotificationPreferences>;
};

export function SettingsDialog({
  close,
  initialPage = "notifications",
  appearanceTheme,
  changeAppearanceTheme,
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

  const savePreferences = async (
    previous: NotificationPreferences,
    next: NotificationPreferences,
  ) => {
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

  const updateDesktopPreference = async (key: keyof DesktopNotificationPreferences, value: boolean) => {
    if (!preferences || saving) return;
    const previous = preferences;
    const next = { ...preferences, [key]: value };
    await savePreferences(previous, next);
  };

  const updateRemotePreference = async (
    target: "mobile" | "watch",
    key: keyof RemoteNotificationPreferences,
    value: boolean,
  ) => {
    if (!preferences || saving) return;
    const previous = preferences;
    const next = {
      ...preferences,
      [target]: { ...preferences[target], [key]: value },
    };
    await savePreferences(previous, next);
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
            <button type="button" className={page === "appearance" ? "active" : ""} aria-current={page === "appearance" ? "page" : undefined} onClick={() => setPage("appearance")}>Appearance</button>
            <button type="button" className={page === "notifications" ? "active" : ""} aria-current={page === "notifications" ? "page" : undefined} onClick={() => setPage("notifications")}>Notifications</button>
            <button type="button" className={page === "servers" ? "active" : ""} aria-current={page === "servers" ? "page" : undefined} onClick={() => setPage("servers")}>Servers</button>
          </nav>
          <main className="settings-content">
            {page === "appearance" ? (
              <AppearanceSettings theme={appearanceTheme} change={changeAppearanceTheme} />
            ) : page === "notifications" ? (
              <NotificationSettings
                preferences={preferences}
                loadingError={loadingError}
                saveError={saveError}
                saving={saving}
                updateDesktop={updateDesktopPreference}
                updateRemote={updateRemotePreference}
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

function AppearanceSettings({
  change,
  theme,
}: {
  change(theme: AppearanceTheme): void;
  theme: AppearanceTheme;
}) {
  return (
    <section className="appearance-settings" aria-labelledby="appearance-settings-title">
      <div className="settings-page-header">
        <h3 id="appearance-settings-title">Appearance</h3>
        <p>Choose how TermLoop looks on this computer.</p>
      </div>
      <div className="appearance-options" role="radiogroup" aria-label="Color theme">
        <AppearanceOption theme="dark" selected={theme === "dark"} change={change} />
        <AppearanceOption theme="light" selected={theme === "light"} change={change} />
      </div>
      <p className="settings-footnote">The selected theme also applies to terminal panes and is remembered on this computer.</p>
    </section>
  );
}

function AppearanceOption({
  change,
  selected,
  theme,
}: {
  change(theme: AppearanceTheme): void;
  selected: boolean;
  theme: AppearanceTheme;
}) {
  const light = theme === "light";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? "appearance-option selected" : "appearance-option"}
      onClick={() => change(theme)}
    >
      <span className={`appearance-preview ${theme}`} aria-hidden="true">
        <i />
        <b><em /><em /><em /></b>
      </span>
      <span className="appearance-option-copy">
        <strong>{light ? "Light" : "Dark"}</strong>
        <small>{light ? "Bright surfaces with dark text." : "Dim surfaces with light text."}</small>
      </span>
      <span className="appearance-option-check" aria-hidden="true">{selected ? "✓" : ""}</span>
    </button>
  );
}

function NotificationSettings({
  loadingError,
  preferences,
  saveError,
  saving,
  updateDesktop,
  updateRemote,
}: {
  loadingError: string | undefined;
  preferences: NotificationPreferences | undefined;
  saveError: string | undefined;
  saving: boolean;
  updateDesktop(key: keyof DesktopNotificationPreferences, value: boolean): Promise<void>;
  updateRemote(
    target: "mobile" | "watch",
    key: keyof RemoteNotificationPreferences,
    value: boolean,
  ): Promise<void>;
}) {
  return (
    <section className="notification-settings" aria-labelledby="notification-settings-title">
      <div className="settings-page-header">
        <h3 id="notification-settings-title">Notifications</h3>
        <p>Choose which alerts this Mac sends to each of your TermLoop devices.</p>
      </div>
      {preferences ? (
        <>
          <NotificationDeviceSection
            title="Desktop"
            description="Notifications shown by TermLoop on this computer."
          >
            <SettingsSwitch
              checked={preferences.enabled}
              disabled={saving}
              title="Agent attention notifications"
              description="Show a desktop notification when an Agent needs input."
              change={(checked) => void updateDesktop("enabled", checked)}
            />
            <SettingsSwitch
              checked={preferences.notifyWhenFocused}
              disabled={saving || !preferences.enabled}
              title="Show while TermLoop is active"
              description="Also notify when this window is already focused."
              change={(checked) => void updateDesktop("notifyWhenFocused", checked)}
            />
            <SettingsSwitch
              checked={preferences.playSound}
              disabled={saving || !preferences.enabled}
              title="Play notification sound"
              description="Use the system notification sound for Agent alerts."
              change={(checked) => void updateDesktop("playSound", checked)}
            />
          </NotificationDeviceSection>

          <RemoteNotificationSection
            target="mobile"
            title="Mobile"
            description="Push notifications sent to iPhones paired with this Mac."
            preferences={preferences.mobile}
            saving={saving}
            update={updateRemote}
          />

          <RemoteNotificationSection
            target="watch"
            title="Apple Watch"
            description="Direct Watch notifications, including notification actions."
            preferences={preferences.watch}
            saving={saving}
            update={updateRemote}
          />
        </>
      ) : loadingError ? (
        <p className="settings-error" role="alert">Could not load notification settings: {loadingError}</p>
      ) : (
        <p className="settings-loading" role="status">Loading notification settings…</p>
      )}
      {saveError ? <p className="settings-error" role="alert">Could not save notification settings: {saveError}</p> : null}
      <p className="settings-footnote">Device-level notification permissions remain controlled by the operating system on each device.</p>
    </section>
  );
}

function NotificationDeviceSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="notification-device-section">
      <header><h4>{title}</h4><p>{description}</p></header>
      <div className="settings-card">{children}</div>
    </section>
  );
}

function RemoteNotificationSection({
  description,
  preferences,
  saving,
  target,
  title,
  update,
}: {
  description: string;
  preferences: RemoteNotificationPreferences;
  saving: boolean;
  target: "mobile" | "watch";
  title: string;
  update(
    target: "mobile" | "watch",
    key: keyof RemoteNotificationPreferences,
    value: boolean,
  ): Promise<void>;
}) {
  const deviceName = target === "mobile" ? "iPhone" : "Apple Watch";
  return (
    <NotificationDeviceSection title={title} description={description}>
      <SettingsSwitch
        accessibleName={`${deviceName} notifications`}
        checked={preferences.enabled}
        disabled={saving}
        title={`${deviceName} notifications`}
        description={`Send notifications from this Mac to ${deviceName}.`}
        change={(checked) => void update(target, "enabled", checked)}
      />
      <SettingsSwitch
        accessibleName={`${deviceName}: Send while this Mac is active`}
        checked={preferences.notifyWhenMacActive}
        disabled={saving || !preferences.enabled}
        title="Send while this Mac is active"
        description="Also send push notifications while keyboard or mouse activity is detected on this Mac."
        change={(checked) => void update(target, "notifyWhenMacActive", checked)}
      />
      <SettingsSwitch
        accessibleName={`${deviceName}: Agent needs input`}
        checked={preferences.agentNeedsInput}
        disabled={saving || !preferences.enabled}
        title="Agent needs input"
        description="Alert when an Agent is waiting for your response."
        change={(checked) => void update(target, "agentNeedsInput", checked)}
      />
      <SettingsSwitch
        accessibleName={`${deviceName}: Agent ready for review`}
        checked={preferences.agentReadyForReview}
        disabled={saving || !preferences.enabled}
        title="Agent ready for review"
        description="Alert when an Agent finishes a turn for you to review."
        change={(checked) => void update(target, "agentReadyForReview", checked)}
      />
      <SettingsSwitch
        accessibleName={`${deviceName}: Steward messages and approvals`}
        checked={preferences.stewardMessages}
        disabled={saving || !preferences.enabled}
        title="Steward messages and approvals"
        description="Alert for Steward replies, proposals, and suggestions."
        change={(checked) => void update(target, "stewardMessages", checked)}
      />
      <SettingsSwitch
        accessibleName={`${deviceName}: Play notification sound`}
        checked={preferences.playSound}
        disabled={saving || !preferences.enabled}
        title="Play notification sound"
        description={`Include sound with ${deviceName} notifications.`}
        change={(checked) => void update(target, "playSound", checked)}
      />
    </NotificationDeviceSection>
  );
}

function SettingsSwitch({
  accessibleName,
  change,
  checked,
  description,
  disabled,
  title,
}: {
  accessibleName?: string;
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
        aria-label={accessibleName ?? title}
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
