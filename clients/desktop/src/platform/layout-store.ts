import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeLayoutDocument,
  emptyLayoutDocument,
  migrateLegacyLayoutDocument,
  type LayoutDocument,
} from "../layout/model.js";

const MAX_LAYOUT_BYTES = 256 * 1024;

export class LayoutFileStore {
  #pendingSource: string | undefined;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly legacyFilePath?: string,
    private readonly migrationProfileId: () => Promise<string> = async () => "local",
  ) {}

  async load(): Promise<LayoutDocument> {
    const current = await this.#read(this.filePath);
    if (current) {
      const decoded = decodeLayoutDocument(current);
      if (decoded) return decoded;
      const migrated = await this.#migrate(current);
      if (migrated) {
        await this.#write(this.#serialize(migrated));
        return migrated;
      }
      return emptyLayoutDocument();
    }
    if (!this.legacyFilePath || this.legacyFilePath === this.filePath) return emptyLayoutDocument();
    const legacy = await this.#read(this.legacyFilePath);
    if (!legacy) return emptyLayoutDocument();
    const migrated = await this.#migrate(legacy);
    if (!migrated) return emptyLayoutDocument();
    await this.#write(this.#serialize(migrated));
    return migrated;
  }

  async #read(filePath: string): Promise<unknown | undefined> {
    try {
      const source = await readFile(filePath, "utf8");
      if (Buffer.byteLength(source) > MAX_LAYOUT_BYTES) return undefined;
      return JSON.parse(source) as unknown;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async #migrate(value: unknown): Promise<LayoutDocument | undefined> {
    try {
      return migrateLegacyLayoutDocument(value, await this.migrationProfileId());
    } catch {
      return undefined;
    }
  }

  async save(value: unknown): Promise<void> {
    this.stage(value);
    await this.flush();
  }

  stage(value: unknown): void {
    const document = decodeLayoutDocument(value);
    if (!document) throw new Error("invalidLayoutDocument");
    this.#pendingSource = this.#serialize(document);
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = setTimeout(() => { void this.flush().catch(() => undefined); }, 150);
  }

  flush(): Promise<void> {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    const source = this.#pendingSource;
    this.#pendingSource = undefined;
    if (!source) return this.#writeQueue;
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(() => this.#write(source));
    return this.#writeQueue;
  }

  async #write(source: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, source, { mode: 0o600 });
    if (process.platform === "win32") await rm(this.filePath, { force: true });
    await rename(temporary, this.filePath);
  }

  #serialize(document: LayoutDocument): string {
    const source = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(source) > MAX_LAYOUT_BYTES) throw new Error("layoutDocumentTooLarge");
    return source;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
