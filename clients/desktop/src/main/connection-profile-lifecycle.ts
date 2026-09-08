import type {
  ConnectionProfileConnectInput,
  ConnectionProfileConnectResult,
  ConnectionProfileSummary,
} from "../connection-profile-types.js";
import type { ConnectionProfileStore } from "./connection-profiles.js";
import type { ConnectionRegistry } from "./connection-registry.js";

type ProfileResources = { stopProfile(profileId: string): void };

/** Serializes each profile write through completion of its runtime effects. */
export class ConnectionProfileLifecycle {
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly profiles: Pick<ConnectionProfileStore, "connect" | "setEnabled" | "remove">,
    private readonly connections: Pick<ConnectionRegistry, "summaries" | "stopProfile">,
    private readonly gateways: ProfileResources,
    private readonly forwards: ProfileResources,
  ) {}

  connect(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult> {
    return this.#serialize(async () => {
      const result = await this.profiles.connect(input);
      await this.#finish();
      return result;
    });
  }

  setEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfileSummary[]> {
    return this.#serialize(async () => {
      await this.profiles.setEnabled(profileId, enabled);
      return this.#finish(enabled ? undefined : profileId);
    });
  }

  remove(profileId: string): Promise<ConnectionProfileSummary[]> {
    return this.#serialize(async () => {
      await this.profiles.remove(profileId);
      return this.#finish(profileId);
    });
  }

  async #finish(retiredProfileId?: string): Promise<ConnectionProfileSummary[]> {
    const errors: unknown[] = [];
    if (retiredProfileId !== undefined) {
      // Retire the exact committed target before any refresh can fail. Every
      // resource owner gets its cleanup even if another owner throws.
      for (const resources of [this.connections, this.gateways, this.forwards]) {
        try {
          resources.stopProfile(retiredProfileId);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    let summaries: ConnectionProfileSummary[] = [];
    try {
      // summaries synchronizes the registry once before projecting its state.
      summaries = await this.connections.summaries();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Connection profile was saved, but its connections could not be fully refreshed.");
    }
    return summaries;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
