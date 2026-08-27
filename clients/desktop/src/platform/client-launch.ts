import { randomUUID } from "node:crypto";

/** Runtime-only idempotency key for one real Electron process launch. */
export function createClientLaunchId(): string {
  return randomUUID();
}

/** Runtime-only idempotency key for one archive operation. */
export function createArchiveOperationId(): string {
  return randomUUID();
}
