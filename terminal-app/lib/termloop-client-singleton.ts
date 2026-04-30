import { TermLoopClient } from './termloop-client';

let instance: TermLoopClient | null = null;

export function getTermLoopClient(): TermLoopClient {
  if (!instance) instance = new TermLoopClient();
  return instance;
}

/** Reset the singleton (useful for testing or when connection config changes). */
export function resetTermLoopClient(): void {
  if (instance) {
    instance.disconnect().catch(() => {});
  }
  instance = null;
}
