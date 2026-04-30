import * as SecureStore from 'expo-secure-store';

const cmuxKey = (id: string) => `termloop_pw_${id}`;
const sshKey = (id: string) => `ssh_pw_${id}`;
const legacyCmuxKey = (id: string) => `termloop_token_${id}`;

export async function getTermLoopPassword(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(cmuxKey(id));
}

export async function setTermLoopPassword(id: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(cmuxKey(id), password);
}

export async function deleteTermLoopPassword(id: string): Promise<void> {
  try { await SecureStore.deleteItemAsync(cmuxKey(id)); } catch {}
}

export async function getSshPassword(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(sshKey(id));
}

export async function setSshPassword(id: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(sshKey(id), password);
}

export async function deleteSshPassword(id: string): Promise<void> {
  try { await SecureStore.deleteItemAsync(sshKey(id)); } catch {}
}

/** Migrate any value at termloop_token_<id> over to termloop_pw_<id>. Idempotent. */
export async function renameLegacyTermLoopKey(id: string): Promise<void> {
  const existing = await SecureStore.getItemAsync(legacyCmuxKey(id));
  if (existing == null) return;
  await SecureStore.setItemAsync(cmuxKey(id), existing);
  try { await SecureStore.deleteItemAsync(legacyCmuxKey(id)); } catch {}
}
