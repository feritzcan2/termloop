import * as Updates from "expo-updates";

import type { AppUpdateClient } from "./app-update";

/// Native Expo Updates stays behind this platform adapter so the force-update
/// policy remains executable in the Node test environment.
export const expoAppUpdateClient: AppUpdateClient = {
  get enabled() { return Updates.isEnabled; },
  fetch: () => Updates.fetchUpdateAsync(),
  reload: () => Updates.reloadAsync(),
};
