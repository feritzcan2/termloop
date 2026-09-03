const INDEX_KEY = "termloop.mobile.connections.v1";
const PROFILE_PREFIX = "termloop.mobile.connection.v1.";
const MAX_CONNECTIONS = 16;

export interface SecretStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface SavedConnection {
  readonly id: string;
  readonly name: string;
  readonly controlUrl: string;
  readonly controlToken: string;
  readonly terminalUrl: string;
  readonly terminalToken: string;
  readonly lastConnectedAtEpochMs: number | null;
  readonly productVersion: string | null;
  readonly contractIdentity: string | null;
}

export interface SecureConnectionRepository {
  list(): Promise<readonly SavedConnection[]>;
  get(id: string): Promise<SavedConnection | undefined>;
  save(connection: SavedConnection): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createSecureConnectionRepository(
  store: SecretStore,
): SecureConnectionRepository {
  return {
    async list() {
      const ids = await readIndex(store);
      const records = await Promise.all(ids.map((id) => readConnection(store, id)));
      return records.filter((record): record is SavedConnection => record !== undefined);
    },

    async get(id) {
      validateId(id);
      return readConnection(store, id);
    },

    async save(connection) {
      validateConnection(connection);
      const ids = await readIndex(store);
      const next = ids.includes(connection.id) ? ids : [...ids, connection.id];
      if (next.length > MAX_CONNECTIONS) throw new Error("Too many saved Macs.");
      await store.setItemAsync(profileKey(connection.id), JSON.stringify(connection));
      await store.setItemAsync(INDEX_KEY, JSON.stringify(next));
    },

    async remove(id) {
      validateId(id);
      const ids = await readIndex(store);
      await store.deleteItemAsync(profileKey(id));
      await store.setItemAsync(INDEX_KEY, JSON.stringify(ids.filter((candidate) => candidate !== id)));
    },
  };
}

async function readIndex(store: SecretStore): Promise<string[]> {
  const raw = await store.getItemAsync(INDEX_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_CONNECTIONS) return [];
    return parsed.filter((value): value is string => typeof value === "string" && validId(value));
  } catch {
    return [];
  }
}

async function readConnection(store: SecretStore, id: string): Promise<SavedConnection | undefined> {
  const raw = await store.getItemAsync(profileKey(id));
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSavedConnection(parsed)) return undefined;
    validateConnection(parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function validateConnection(connection: SavedConnection): void {
  validateId(connection.id);
  if (connection.name.length < 1 || connection.name.length > 120) {
    throw new Error("Connection name is invalid.");
  }
  validateEndpoint(connection.controlUrl, "/control");
  validateEndpoint(connection.terminalUrl, "/terminal");
  if (connection.controlToken.length < 16 || connection.terminalToken.length < 16) {
    throw new Error("Connection credential is invalid.");
  }
}

function validateEndpoint(value: string, requiredPath: string): void {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol)
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || url.pathname !== requiredPath) {
    throw new Error(`Connection endpoint must be a credential-free ${requiredPath} WebSocket URL.`);
  }
}

function isSavedConnection(value: unknown): value is SavedConnection {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.controlUrl === "string"
    && typeof record.controlToken === "string"
    && typeof record.terminalUrl === "string"
    && typeof record.terminalToken === "string"
    && (record.lastConnectedAtEpochMs === null || typeof record.lastConnectedAtEpochMs === "number")
    && (record.productVersion === null || typeof record.productVersion === "string")
    && (record.contractIdentity === null || typeof record.contractIdentity === "string")
    && Object.keys(record).every((key) => [
      "id",
      "name",
      "controlUrl",
      "controlToken",
      "terminalUrl",
      "terminalToken",
      "lastConnectedAtEpochMs",
      "productVersion",
      "contractIdentity",
    ].includes(key));
}

function profileKey(id: string): string {
  validateId(id);
  return `${PROFILE_PREFIX}${id}`;
}

function validateId(id: string): void {
  if (!validId(id)) throw new Error("Connection id is invalid.");
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
