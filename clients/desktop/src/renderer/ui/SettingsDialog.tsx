import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  DesktopNotificationPreferences,
  NotificationPreferences,
  RemoteNotificationPreferences,
} from "../../notification-preferences.js";
import {
  ConnectionProfilesDialog,
  type ConnectionProfilesDialogProps,
} from "./ConnectionProfilesDialog.js";
import type { AppearancePreference } from "../appearance-theme.js";
import { showsWindowDragRegion, type KeyboardPlatform } from "../command-surface.js";
import { Icon, type IconName } from "./Icon.js";
import { UpdateSettings, type AppUpdateControls } from "./AppUpdate.js";
import { MobileConnectDialog, type MobileConnectDialogProps } from "./MobileConnectDialog.js";
import { IntegrationsSettings, type IntegrationActions } from "./IntegrationsSettings.js";
import { AgentConnectionsPanel, type AgentConnectionActions } from "./AgentConnectionsPanel.js";
import type { ConnectionProfileSummary } from "../../connection-profile-types.js";

export type SettingsPage = "appearance" | "notifications" | "updates" | "experimental" | "servers" | "accounts" | "integrations" | "mobile";

type SettingsNavItem = {
  page: SettingsPage;
  title: string;
  icon: IconName;
  keywords: string;
};

const appNavItems: SettingsNavItem[] = [
  { page: "appearance", title: "Appearance", icon: "palette", keywords: "theme color dark light system mode look" },
  { page: "notifications", title: "Notifications", icon: "bell", keywords: "alerts sound push desktop iphone mobile apple watch steward review input" },
  { page: "updates", title: "Updates", icon: "download", keywords: "version about upgrade release check restart install download" },
];

const computerNavItems: SettingsNavItem[] = [
  { page: "servers", title: "Computers", icon: "monitor", keywords: "servers remote ssh tailscale host share connection keep awake power" },
  { page: "accounts", title: "Agent accounts", icon: "agent", keywords: "claude codex account login sign in sign out switch default usage limits rate remove" },
  { page: "integrations", title: "Integrations", icon: "link", keywords: "github gh azure devops az jira pull request pr build checks ci review token pat credentials providers" },
  { page: "mobile", title: "Pair phone", icon: "phone", keywords: "mobile iphone qr pairing voice transcription" },
  { page: "experimental", title: "Experimental", icon: "sparkles", keywords: "experimental preview beta project manager pm mode" },
];

type SettingsDialogProps = Omit<ConnectionProfilesDialogProps, "close" | "embedded"> & {
  close(): void;
  initialPage?: SettingsPage;
  platform?: KeyboardPlatform;
  appearancePreference: AppearancePreference;
  changeAppearancePreference(preference: AppearancePreference): void;
  loadNotificationPreferences(): Promise<NotificationPreferences>;
  saveNotificationPreferences(preferences: NotificationPreferences): Promise<NotificationPreferences>;
  showScope?: boolean;
  localComputerName?: string | undefined;
  mobile?: Omit<MobileConnectDialogProps, "close" | "embedded" | "computerName">;
  update?: AppUpdateControls | undefined;
  /** The selected computer's experimental Project Manager mode switch. */
  projectManagerMode?: { enabled: boolean; available: boolean; change(enabled: boolean): Promise<string | undefined> } | undefined;
  /** Per-computer provider status. Absent hosts simply omit the page. */
  integrations?: { actions: IntegrationActions; openTaskSettings?: (() => void) | undefined } | undefined;
};

export function SettingsDialog({
  close,
  initialPage = "notifications",
  platform = "linux",
  appearancePreference,
  changeAppearancePreference,
  loadNotificationPreferences,
  saveNotificationPreferences,
  showScope = false,
  localComputerName,
  mobile,
  update,
  integrations,
  projectManagerMode,
  ...connectionProps
}: SettingsDialogProps) {
  const [selectedPage, setPage] = useState<SettingsPage>(initialPage);
  const [query, setQuery] = useState("");
  const [preferences, setPreferences] = useState<NotificationPreferences>();
  const [loadingError, setLoadingError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [initialProfileId] = useState(connectionProps.initialProfileId);
  const [accountsProfileId, setAccountsProfileId] = useState(initialProfileId);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const navGroups = [
    { title: showScope ? "This app" : "General", items: appNavItems.filter((item) => matchesSettingsQuery(item, query)) },
    {
      title: "Computers",
      items: computerNavItems.filter((item) => (item.page !== "mobile" || mobile)
        && (item.page !== "integrations" || integrations)
        && (item.page !== "accounts" || connectionProps.agentConnections)
        && (item.page !== "experimental" || projectManagerMode)
        && matchesSettingsQuery(item, query)),
    },
  ].filter((group) => group.items.length > 0);
  const visiblePages = navGroups.flatMap((group) => group.items.map((item) => item.page));
  // While searching, the content follows the selection only if it still matches;
  // otherwise it shows the first match so the pane never displays a filtered-out page.
  const page = visiblePages.includes(selectedPage) ? selectedPage : visiblePages[0];

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
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (searchRef.current?.value) setQuery("");
      else close();
    };
    // Over native terminals Settings is portaled into the overlay window, whose
    // keys never reach this renderer's own window.
    const owner = viewRef.current?.ownerDocument.defaultView ?? window;
    owner.addEventListener("keydown", onKeyDown);
    return () => owner.removeEventListener("keydown", onKeyDown);
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
    <div ref={viewRef} className="settings-view" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <aside className="settings-sidebar">
        {showsWindowDragRegion(platform) ? <div className="window-drag-region" aria-hidden="true" /> : null}
        <div className="settings-sidebar-head">
          <button type="button" className="settings-back" onClick={close}>
            <Icon name="arrowLeft" />Back to app
          </button>
        </div>
        <div className="settings-search">
          <h2 id="settings-title">Settings</h2>
          <label>
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              autoFocus
              value={query}
              placeholder="Search settings"
              aria-label="Search settings"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? null : <kbd aria-hidden="true">{platform === "mac" ? "⌘F" : "Ctrl F"}</kbd>}
          </label>
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {navGroups.map((group) => (
            <div key={group.title} className="settings-nav-section">
              <span className="settings-nav-group">{group.title}</span>
              {group.items.map((item) => (
                <button
                  key={item.page}
                  type="button"
                  className={page === item.page ? "active" : ""}
                  aria-current={page === item.page ? "page" : undefined}
                  onClick={() => setPage(item.page)}
                >
                  <Icon name={item.icon} />
                  <span>{item.title}</span>
                  {item.page === "mobile" && showScope ? <small>This computer</small> : null}
                </button>
              ))}
            </div>
          ))}
          {navGroups.length === 0 ? <p className="settings-nav-empty">No matching settings.</p> : null}
        </nav>
      </aside>
      <main className="settings-content">
        <div className="settings-content-inner">
          {showScope && (page === "appearance" || page === "notifications" || page === "updates") ? <p className="settings-scope-label">This app · {localComputerName ?? "This computer"}</p> : null}
          {page === undefined ? (
            <p className="settings-empty">No settings found for “{query.trim()}”</p>
          ) : page === "appearance" ? (
            <AppearanceSettings preference={appearancePreference} change={changeAppearancePreference} />
          ) : page === "notifications" ? (
            <NotificationSettings
              preferences={preferences}
              loadingError={loadingError}
              saveError={saveError}
              saving={saving}
              updateDesktop={updateDesktopPreference}
              updateRemote={updateRemotePreference}
            />
          ) : page === "updates" ? (
            <UpdateSettings update={update} />
          ) : page === "experimental" ? (
            <ExperimentalSettings projectManagerMode={projectManagerMode} />
          ) : page === "integrations" && integrations ? (
            <IntegrationsSettings
              actions={integrations.actions}
              listProfiles={connectionProps.list}
              initialProfileId={initialProfileId}
              openTaskSettings={integrations.openTaskSettings ? () => { close(); integrations.openTaskSettings?.(); } : undefined}
            />
          ) : page === "accounts" && connectionProps.agentConnections ? (
            <AgentAccountsSettings key={accountsProfileId} actions={connectionProps.agentConnections} listProfiles={connectionProps.list} initialProfileId={accountsProfileId} />
          ) : page === "mobile" && mobile ? (
            <MobileConnectDialog {...mobile} embedded computerName={showScope ? localComputerName : undefined} close={close} />
          ) : (
            <>
              <div className="settings-page-header">
                <h3>Computers</h3>
                <p>Manage your computers and remote access.</p>
              </div>
              <ConnectionProfilesDialog {...connectionProps} initialProfileId={initialProfileId} embedded close={close} openAgentAccounts={connectionProps.agentConnections ? (profileId) => { setAccountsProfileId(profileId); setQuery(""); setPage("accounts"); } : undefined} pairPhone={mobile ? () => { setQuery(""); setPage("mobile"); } : undefined} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function AgentAccountsSettings({ actions, listProfiles, initialProfileId = "local" }: {
  actions: AgentConnectionActions;
  listProfiles(): Promise<ConnectionProfileSummary[]>;
  initialProfileId?: string | undefined;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>();
  const [profilesError, setProfilesError] = useState<string>();
  const [selectedProfileId, setSelectedProfileId] = useState(initialProfileId);
  useEffect(() => {
    let active = true;
    void listProfiles().then(
      (value) => { if (active) { setProfiles(value); setProfilesError(undefined); } },
      (error) => { if (active) setProfilesError(errorMessage(error)); },
    );
    return () => { active = false; };
  }, [listProfiles]);
  const profile = profiles?.find((candidate) => candidate.id === selectedProfileId)
    ?? profiles?.find((candidate) => candidate.id === "local")
    ?? profiles?.[0];
  return (
    <section className="agent-accounts-settings" aria-labelledby="agent-accounts-settings-title">
      <div className="settings-page-header">
        <h3 id="agent-accounts-settings-title">Agent accounts</h3>
        <p>Sign Claude and Codex in with one or more accounts, choose which one new Agents use, and watch each account's usage limits.</p>
      </div>
      {profiles && profiles.length > 1 ? <label className="conn-field agent-server-select"><span>Computer</span>
        <select aria-label="Computer" value={profile?.id ?? ""} onChange={(event) => setSelectedProfileId(event.target.value)}>
          {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.state === "offline" ? " · Offline" : ""}</option>)}
        </select>
      </label> : null}
      {profilesError ? <p className="settings-error" role="alert">Could not load computers: {profilesError}</p>
        : !profiles ? <p className="settings-loading" role="status">Loading computers…</p>
        : profile ? <AgentConnectionsPanel key={profile.id} profile={profile} actions={actions} />
        : <p className="settings-empty">No computers are configured.</p>}
    </section>
  );
}

function matchesSettingsQuery(item: SettingsNavItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const haystack = `${item.title} ${item.keywords}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function AppearanceSettings({
  change,
  preference,
}: {
  change(preference: AppearancePreference): void;
  preference: AppearancePreference;
}) {
  return (
    <section className="appearance-settings" aria-labelledby="appearance-settings-title">
      <div className="settings-page-header">
        <h3 id="appearance-settings-title">Appearance</h3>
        <p>Choose how TermLoop looks on this computer.</p>
      </div>
      <div className="appearance-options" role="radiogroup" aria-label="Color theme">
        <AppearanceOption preference="system" selected={preference === "system"} change={change} />
        <AppearanceOption preference="light" selected={preference === "light"} change={change} />
        <AppearanceOption preference="dark" selected={preference === "dark"} change={change} />
      </div>
      <p className="settings-footnote">System follows macOS appearance changes instantly. The resolved theme also applies to terminal panes.</p>
    </section>
  );
}

function AppearanceOption({
  change,
  preference,
  selected,
}: {
  change(preference: AppearancePreference): void;
  preference: AppearancePreference;
  selected: boolean;
}) {
  const copy = {
    system: ["System", "Follow this Mac automatically."],
    light: ["Light", "Bright surfaces with dark text."],
    dark: ["Dark", "Dim surfaces with light text."],
  } satisfies Record<AppearancePreference, [string, string]>;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? "appearance-option selected" : "appearance-option"}
      onClick={() => change(preference)}
    >
      <span className={`appearance-preview ${preference}`} aria-hidden="true">
        <i />
        <b><em /><em /><em /></b>
      </span>
      <span className="appearance-option-copy">
        <strong>{copy[preference][0]}</strong>
        <small>{copy[preference][1]}</small>
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

function ExperimentalSettings({ projectManagerMode }: { projectManagerMode: SettingsDialogProps["projectManagerMode"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section aria-labelledby="experimental-settings-title">
      <div className="settings-page-header">
        <h3 id="experimental-settings-title">Experimental</h3>
        <p>Features that are still being built. They may change or disappear.</p>
      </div>
      <SettingsSwitch
        title="Project Manager mode"
        description="Lets a Project on this computer be opened as Project Manager or Developer. While it is off every Project works as a Developer Project, exactly as today."
        checked={projectManagerMode?.enabled ?? false}
        disabled={!projectManagerMode?.available || busy}
        change={(enabled) => {
          if (!projectManagerMode) return;
          setBusy(true);
          setError(undefined);
          void projectManagerMode.change(enabled).then((failure) => {
            setError(failure);
            setBusy(false);
          });
        }}
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
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
