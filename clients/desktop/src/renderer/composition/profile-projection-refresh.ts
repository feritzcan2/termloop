import { KeyedProjectionRefreshQueue } from "../state/projection-refresh.js";

/**
 * Source snapshots carry live Agent status. Serialize those reads independently
 * of the slower Project details so a pending worktree read cannot hold the next
 * status invalidation. Callers still await both stages and receive their errors.
 */
export class ProfileProjectionRefresh {
  readonly #sources: KeyedProjectionRefreshQueue<string>;

  constructor(
    refreshSource: (profileId: string) => Promise<void>,
    private readonly refreshProject: (profileId: string) => Promise<void>,
  ) {
    this.#sources = new KeyedProjectionRefreshQueue(refreshSource);
  }

  async request(profileId: string): Promise<void> {
    await this.#sources.request(profileId);
    await this.refreshProject(profileId);
  }

  retain(profileIds: ReadonlySet<string>): void {
    this.#sources.retain(profileIds);
  }
}
