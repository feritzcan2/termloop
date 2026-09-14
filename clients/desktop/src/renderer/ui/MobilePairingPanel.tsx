import { useEffect, useState } from "react";
import type { MobileAccessPairingResult } from "../mobile-access.js";

export function MobilePairingPanel({ prepare, computerName = "this computer", remote = false }: {
  prepare(): Promise<MobileAccessPairingResult>;
  computerName?: string;
  remote?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<MobileAccessPairingResult>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    void Promise.resolve().then(prepare).then((value) => { if (active) setResult(value); }).catch((cause: unknown) => {
      if (active) setResult({ ok: false, error: cause instanceof Error ? cause.message : "Mobile Access could not be prepared. Try again." });
    });
    return () => { active = false; };
  }, [attempt, prepare]);

  return <>
    {result === undefined ? (
      <div className="mobile-connect-loading" role="status"><span aria-hidden="true" />Preparing Mobile Access{remote ? ` on ${computerName}` : ""}…</div>
    ) : result.ok ? (
      <>
        <div className="mobile-connect-qr" aria-label="TermLoop Mobile pairing QR" dangerouslySetInnerHTML={{ __html: result.qrSvg }} />
        <ol>
          <li>Keep Tailscale connected on {computerName} and your iPhone.</li>
          <li>On iPhone, open TermLoop and tap <strong>Pair a computer</strong>.</li>
          <li>Scan this QR code. The app connects automatically.</li>
        </ol>
        {remote ? <p className="conn-note">Your phone connects directly to {computerName}. This computer can be closed. Mobile Access starts with the server and updates with TermLoop.</p> : null}
      </>
    ) : (
      <div className="mobile-connect-error" role="alert">
        <p>{result.error}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
      </div>
    )}
  </>;
}
