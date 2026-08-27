import os from "node:os";

const FALLBACK_DEVICE_NAME = "TermLoop Desktop";
const MAX_DEVICE_NAME_LENGTH = 80;

export function localDeviceName(): string {
  const hostname = os.hostname().trim();
  return (hostname || FALLBACK_DEVICE_NAME).slice(0, MAX_DEVICE_NAME_LENGTH);
}
