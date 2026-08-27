import * as SecureStore from "expo-secure-store";

import type { SecretStore } from "./secure-connections";

export const nativeSecretStore: SecretStore = SecureStore;
