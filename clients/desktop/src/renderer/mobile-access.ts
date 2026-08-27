export type MobileAccessPairingResult =
  | { ok: true; qrSvg: string }
  | { ok: false; error: string };
