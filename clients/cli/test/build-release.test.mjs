import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("release bundle has one shebang and can load bundled CommonJS dependencies", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "termloop-cli-bundle-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "termloopctl.mjs");

  const built = spawnSync(process.execPath, ["build-release.mjs", `--outfile=${output}`], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);

  const source = await readFile(output, "utf8");
  assert.equal(source.match(/^#!\/usr\/bin\/env node$/gm)?.length, 1);

  const invoked = spawnSync(process.execPath, [output, "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(invoked.status, 2, invoked.stderr);
  assert.match(invoked.stderr, /usage: termloopctl/);
  assert.doesNotMatch(invoked.stderr, /Dynamic require/);
});
