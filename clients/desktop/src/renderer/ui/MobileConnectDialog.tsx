import { useEffect, useState } from "react";
import type { VoiceCredentialsSetParams, VoiceSettingsResult } from "@termloop/contract/current";

import type { MobileAccessPairingResult } from "../mobile-access.js";

export function MobileConnectDialog({ close, prepare, loadVoiceSettings, saveVoiceCredentials }: {
  close(): void;
  prepare(): Promise<MobileAccessPairingResult>;
  loadVoiceSettings(): Promise<VoiceSettingsResult>;
  saveVoiceCredentials(params: VoiceCredentialsSetParams): Promise<VoiceSettingsResult>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<MobileAccessPairingResult>();
  const [voiceConfigured, setVoiceConfigured] = useState<boolean>();
  const [apiKey, setApiKey] = useState("");
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceError, setVoiceError] = useState<string>();

  useEffect(() => {
    let active = true;
    setResult(undefined);
    void Promise.resolve()
      .then(prepare)
      .then((value) => { if (active) setResult(value); })
      .catch((cause: unknown) => {
        if (!active) return;
        setResult({
          ok: false,
          error: cause instanceof Error ? cause.message : "Mobile Access could not be prepared.",
        });
      });
    return () => { active = false; };
  }, [attempt, prepare]);

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(loadVoiceSettings)
      .then((value) => { if (active) setVoiceConfigured(value.configured); })
      .catch(() => { if (active) setVoiceError("Voice settings could not be loaded."); });
    return () => { active = false; };
  }, [loadVoiceSettings]);

  const saveVoice = async () => {
    if (voiceSaving || !validApiKey(apiKey)) return;
    setVoiceSaving(true);
    setVoiceError(undefined);
    try {
      const next = await saveVoiceCredentials({ apiKey });
      setVoiceConfigured(next.configured);
      setApiKey("");
    } catch {
      setVoiceError("OpenAI API key could not be saved.");
    } finally {
      setVoiceSaving(false);
    }
  };

  return (
    <div className="mobile-connect-layer" role="presentation">
      <button className="mobile-connect-backdrop" type="button" tabIndex={-1} aria-label="Close mobile connection" onClick={close} />
      <section className="mobile-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-connect-title">
        <header>
          <div>
            <span>TermLoop Mobile</span>
            <h2 id="mobile-connect-title">Connect your phone</h2>
          </div>
          <button type="button" aria-label="Close" onClick={close}>×</button>
        </header>
        <div className="mobile-connect-body">
          {result === undefined ? (
            <div className="mobile-connect-loading" role="status"><span aria-hidden="true" />Preparing Mobile Access…</div>
          ) : result.ok ? (
            <>
              <div className="mobile-connect-qr" aria-label="TermLoop Mobile pairing QR" dangerouslySetInnerHTML={{ __html: result.qrSvg }} />
              <ol>
                <li>Keep Tailscale connected on this computer and your iPhone.</li>
                <li>On iPhone, open TermLoop and tap <strong>Pair a computer</strong>.</li>
                <li>Scan this QR code. The app connects automatically.</li>
              </ol>
            </>
          ) : (
            <div className="mobile-connect-error" role="alert">
              <p>{result.error}</p>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
            </div>
          )}
          <section className="mobile-connect-voice" aria-labelledby="mobile-connect-voice-title">
            <div>
              <span>Steward Voice</span>
              <h3 id="mobile-connect-voice-title">OpenAI voice</h3>
              <p>{voiceConfigured === undefined
                ? "Checking secure key storage…"
                : voiceConfigured
                  ? "Ready — the API key is stored in this computer's secure credential store."
                  : "Add an API key for natural Watch transcription and speech."}</p>
            </div>
            <div className="mobile-connect-voice-form">
              <input
                aria-label="OpenAI API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={voiceConfigured ? "Stored — paste to replace" : "sk-…"}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button type="button" disabled={!validApiKey(apiKey) || voiceSaving} onClick={() => { void saveVoice(); }}>
                {voiceSaving ? "Saving…" : "Save key"}
              </button>
            </div>
            {voiceError ? <p className="mobile-connect-voice-error" role="alert">{voiceError}</p> : null}
          </section>
        </div>
        <footer>The OpenAI key never leaves the daemon except as provider authorization.</footer>
      </section>
    </div>
  );
}

function validApiKey(value: string): boolean {
  return value.length >= 20 && value.length <= 512 && /^sk-\S+$/u.test(value);
}
