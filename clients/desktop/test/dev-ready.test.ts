import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  publishDevelopmentReadyMarker,
  removeDevelopmentReadyMarker,
} from "../src/platform/dev-ready.js";

describe("development ready marker", () => {
  it("publishes one atomic PID-bound marker and removes it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-dev-ready-"));
    const marker = path.join(directory, "runtime", "desktop.ready.json");
    await publishDevelopmentReadyMarker(marker, 42);
    await expect(readFile(marker, "utf8")).resolves.toBe('{"version":1,"pid":42}\n');
    await removeDevelopmentReadyMarker(marker);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  });

  it("does nothing without an invocation-owned marker path", async () => {
    await publishDevelopmentReadyMarker(undefined, 42);
    await removeDevelopmentReadyMarker(undefined);
  });
});
