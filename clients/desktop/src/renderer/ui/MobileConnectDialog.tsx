import { useEffect, useState } from "react";

import type { MobileAccessPairingResult } from "../mobile-access.js";

export function MobileConnectDialog({ close, prepare }: {
  close(): void;
  prepare(): Promise<MobileAccessPairingResult>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<MobileAccessPairingResult>();

  useEffect(() => {
    let active = true;
    setResult(undefined);
    void prepare().then((value) => { if (active) setResult(value); });
    return () => { active = false; };
  }, [attempt, prepare]);

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
        </div>
        <footer>Pairing grants project visibility and terminal input on this computer.</footer>
      </section>
    </div>
  );
}
