type ElectronSafeStorage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
};

/** Linux may report encryption available while using reversible basic-text storage. */
export function secureCredentialStorageAvailable(
  storage: ElectronSafeStorage,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  if (platform !== "linux") return true;
  const backend = storage.getSelectedStorageBackend?.();
  return backend === "gnome_libsecret"
    || backend === "kwallet"
    || backend === "kwallet5"
    || backend === "kwallet6";
}
