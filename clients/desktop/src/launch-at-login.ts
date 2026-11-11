/// Whether this installed app opens when the user signs in to the computer.
///
/// The operating system's login items are the only record: nothing is stored
/// by TermLoop, so a change made in System Settings shows here unchanged.
export type LaunchAtLoginStatus =
  | {
    state: "available";
    enabled: boolean;
    /** macOS registered the item but the user still has to allow it. */
    requiresApproval: boolean;
  }
  /**
   * `development`: an unpackaged run would register the bare Electron binary,
   * not TermLoop. `platform`: the OS has no login item Electron can manage.
   */
  | { state: "unsupported"; reason: "development" | "platform" };
