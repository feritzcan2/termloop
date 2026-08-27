import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type PromptAsset = {
  id: string;
  title: string;
  category: string;
  version: number | undefined;
  canonicalBody: string;
  effectiveBody: string;
  customized: boolean;
  source: "builtIn" | "project" | "worker" | "routine" | "provider";
  editable: boolean;
  resettable: boolean;
  /// The exact file a customization is stored in. It is what an
  /// Improve-with-agent launch hands the agent, and it is absent for a prompt
  /// this store does not back with a file.
  overridePath?: string;
};

const MAX_PROMPT_BYTES = 256 * 1024;
const PROMPT_ID = /^builtin\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function promptTitle(id: string): string {
  return id.split(".").slice(1).map((part) => part.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase())).join(" · ");
}

function promptCategory(id: string): string {
  const category = id.split(".")[1] ?? "other";
  return category.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function promptVersion(body: string): number | undefined {
  const match = body.match(/^- version: `([^`]+)`$/m);
  const version = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(version) ? version : undefined;
}

function promptFile(directory: string, id: string): string {
  if (!PROMPT_ID.test(id)) throw new Error("invalidPromptId");
  return path.join(directory, `${id}.md`);
}

export class PromptAssetStore {
  constructor(private readonly canonicalDirectory: string, private readonly overrideDirectory: string) {}

  async list(): Promise<PromptAsset[]> {
    const entries = await readdir(this.canonicalDirectory, { withFileTypes: true });
    const assets: PromptAsset[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("builtin.") || !entry.name.endsWith(".md")) continue;
      const id = entry.name.slice(0, -3);
      if (!PROMPT_ID.test(id)) continue;
      const canonicalBody = await readFile(path.join(this.canonicalDirectory, entry.name), "utf8");
      const effectiveBody = await readFile(path.join(this.overrideDirectory, entry.name), "utf8").catch(() => canonicalBody);
      assets.push({
        id,
        title: promptTitle(id),
        category: promptCategory(id),
        version: promptVersion(canonicalBody),
        canonicalBody,
        effectiveBody,
        customized: effectiveBody !== canonicalBody,
        source: "builtIn",
        overridePath: promptFile(this.overrideDirectory, id),
        editable: true,
        resettable: true,
      });
    }
    return assets.sort((left, right) => left.id.localeCompare(right.id));
  }

  async update(id: string, body: string): Promise<PromptAsset[]> {
    if (!body.trim() || Buffer.byteLength(body, "utf8") > MAX_PROMPT_BYTES) throw new Error("invalidPromptBody");
    const canonical = await readFile(promptFile(this.canonicalDirectory, id), "utf8");
    if (!body.includes(`- id: \`${id}\``)) throw new Error("promptIdentityMustBePreserved");
    if (body === canonical) return this.reset(id);
    await mkdir(this.overrideDirectory, { recursive: true });
    await writeFile(promptFile(this.overrideDirectory, id), body, "utf8");
    return this.list();
  }

  async reset(id: string): Promise<PromptAsset[]> {
    await unlink(promptFile(this.overrideDirectory, id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return this.list();
  }
}
