import { useEffect, useState } from "react";
import type { AgentForkSettingsResult, AgentForkSettingsSetParams } from "@termloop/contract/current";

import type { ConnectionProfileSummary } from "../../connection-profile-types.js";
import { connectionStatusSuffix } from "../connection-source-status.js";
import { SettingsSwitch } from "./SettingsSwitch.js";

/** The fork preference lives on each daemon, so every action names the
    computer it asks. The composition root binds these to that computer. */
export type AgentForkSettingsActions = {
  get(profileId: string): Promise<AgentForkSettingsResult>;
  set(profileId: string, params: AgentForkSettingsSetParams): Promise<AgentForkSettingsResult>;
};

export function AgentForkSettings({ actions, listProfiles, initialProfileId = "local" }: {
  actions: AgentForkSettingsActions;
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
    <section className="agent-fork-settings" aria-labelledby="agent-fork-settings-title">
      <div className="settings-page-header">
        <h3 id="agent-fork-settings-title">Agent settings</h3>
        <p>Choose how TermLoop prepares the Agents it starts on this computer.</p>
      </div>
      {profiles && profiles.length > 1 ? <label className="conn-field agent-server-select"><span>Computer</span>
        <select aria-label="Computer" value={profile?.id ?? ""} onChange={(event) => setSelectedProfileId(event.target.value)}>
          {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{connectionStatusSuffix(candidate.state, candidate.message)}</option>)}
        </select>
      </label> : null}
      {profilesError ? <p className="settings-error" role="alert">Could not load computers: {profilesError}</p>
        : !profiles ? <p className="settings-loading" role="status">Loading computers…</p>
        : profile ? <AgentForkSettingsPanel key={profile.id} profileId={profile.id} actions={actions} />
        : <p className="settings-empty">No computers are configured.</p>}
    </section>
  );
}

function AgentForkSettingsPanel({ actions, profileId }: { actions: AgentForkSettingsActions; profileId: string }) {
  const [settings, setSettings] = useState<AgentForkSettingsResult>();
  const [loadingError, setLoadingError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void actions.get(profileId).then(
      (value) => { if (active) { setSettings(value); setLoadingError(undefined); } },
      (error) => { if (active) setLoadingError(errorMessage(error)); },
    );
    return () => { active = false; };
  }, [actions, profileId]);
  const change = async (systemPromptEnabled: boolean) => {
    if (!settings || saving) return;
    const previous = settings;
    setSettings({ ...settings, systemPromptEnabled });
    setSaving(true);
    setSaveError(undefined);
    try {
      setSettings(await actions.set(profileId, { systemPromptEnabled }));
    } catch (error) {
      setSettings(previous);
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  if (!settings) {
    return loadingError
      ? <p className="settings-error" role="alert">Could not load Agent settings: {loadingError}</p>
      : <p className="settings-loading" role="status">Loading Agent settings…</p>;
  }
  return (
    <section className="notification-device-section">
      <header>
        <h4>Forks</h4>
        <p>A fork copies a running Agent's conversation into a new Agent while the original keeps working.</p>
      </header>
      <div className="settings-card">
        <SettingsSwitch
          checked={settings.systemPromptEnabled}
          disabled={saving}
          title="Tell forks they are a fork"
          description="Give each new fork the message below as standing instructions (Codex developer instructions, Claude session-start context), so it knows the source Agent is still running and waits for your instructions."
          change={(checked) => void change(checked)}
        />
      </div>
      <figure className="agent-fork-prompt">
        <figcaption>Instructions added to new forks. TermLoop fills in the source Session ID.</figcaption>
        <pre aria-label="Fork system prompt">{settings.systemPrompt}</pre>
      </figure>
      <figure className="agent-fork-prompt">
        <figcaption>Added after it only when the source Agent is still working at fork time.</figcaption>
        <pre aria-label="Fork active source prompt">{settings.activeSourcePrompt}</pre>
      </figure>
      {saveError ? <p className="settings-error" role="alert">Could not save Agent settings: {saveError}</p> : null}
      <p className="settings-footnote">Changes apply to forks started afterwards. Running forks keep the instructions they started with.</p>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
