import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop build output", () => {
  it("embeds electron-updater for the self-contained development launch bundle", async () => {
    const mainBundle = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");

    expect(mainBundle).not.toMatch(/from\s+["']electron-updater["']/);
    expect(mainBundle).toContain('const require = __termloopCreateRequire(import.meta.url);');
  });
});
