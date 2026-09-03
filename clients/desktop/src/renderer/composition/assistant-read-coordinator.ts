export type AssistantReadIdentity = {
  readonly profileId: string;
  readonly projectId: string;
};

type ReadSlot = {
  loadedGeneration: number;
  hasValue: boolean;
  value: unknown;
  inFlight?: Promise<unknown>;
};

type IdentityEntry = {
  generation: number;
  readonly slots: Map<string, ReadSlot>;
};

const MAX_RETAINED_IDENTITIES = 8;

function identityKey(identity: AssistantReadIdentity): string {
  return `${identity.profileId}\0${identity.projectId}`;
}

/**
 * Owns assistant projection reads above React surfaces. Every named read is
 * single-flight for one computer/Project and invalidations received while it
 * is running collapse into exactly one trailing read before consumers resolve.
 */
export class AssistantReadCoordinator {
  readonly #entries = new Map<string, IdentityEntry>();

  invalidate(identity: AssistantReadIdentity): void {
    this.#entry(identity).generation += 1;
  }

  /** Marks retained Projects on one computer stale without issuing reads. */
  invalidateProfile(profileId: string): void {
    const prefix = `${profileId}\0`;
    for (const [key, entry] of this.#entries) {
      if (key.startsWith(prefix)) entry.generation += 1;
    }
  }

  read<Result>(
    identity: AssistantReadIdentity,
    readKey: string,
    load: () => Promise<Result>,
  ): Promise<Result> {
    const entry = this.#entry(identity);
    const existingSlot = entry.slots.get(readKey);
    const slot: ReadSlot = existingSlot
      ?? { loadedGeneration: 0, hasValue: false, value: undefined };
    if (!existingSlot) {
      entry.slots.set(readKey, slot);
    }
    if (slot.inFlight) return slot.inFlight as Promise<Result>;
    if (slot.hasValue && slot.loadedGeneration >= entry.generation) {
      return Promise.resolve(slot.value as Result);
    }

    const drain = async (): Promise<Result> => {
      do {
        const loadingGeneration = entry.generation;
        const value = await load();
        slot.value = value;
        slot.hasValue = true;
        slot.loadedGeneration = loadingGeneration;
      } while (slot.loadedGeneration < entry.generation);
      return slot.value as Result;
    };
    const tracked = drain().finally(() => {
      if (slot.inFlight === tracked) delete slot.inFlight;
    });
    slot.inFlight = tracked;
    return tracked;
  }

  wrapMutation<Args extends unknown[], Result>(
    identity: AssistantReadIdentity,
    mutation: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args) => {
      const result = await mutation(...args);
      this.invalidate(identity);
      return result;
    };
  }

  #entry(identity: AssistantReadIdentity): IdentityEntry {
    const key = identityKey(identity);
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing;
    }
    while (this.#entries.size >= MAX_RETAINED_IDENTITIES) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const entry: IdentityEntry = { generation: 1, slots: new Map() };
    this.#entries.set(key, entry);
    return entry;
  }
}

const ASSISTANT_INVALIDATION_TOPICS = new Set([
  "companion",
  "steward",
  "worker",
  "routine",
  "playbook",
  "session",
  "agentStatus",
]);

export function assistantInvalidationMatchesSelection(
  invalidatedProfileId: string,
  selectedProfileId: string,
  topics: readonly string[],
): boolean {
  return invalidatedProfileId === selectedProfileId
    && assistantInvalidationIncludesProjection(topics);
}

export function assistantInvalidationIncludesProjection(topics: readonly string[]): boolean {
  return topics.some((topic) => ASSISTANT_INVALIDATION_TOPICS.has(topic));
}
