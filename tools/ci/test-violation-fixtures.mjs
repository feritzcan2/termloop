import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { rules } from "./boundary-rules.mjs";

const fixtures = JSON.parse(await readFile("tests/fixtures/architecture-violations/fixtures.json", "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "termloop-boundary-fixtures-"));
try {
  for (const fixture of fixtures) {
    const parsed = path.parse(fixture.file); const file = path.join(temporary, parsed.dir, `${fixture.rule.toLowerCase()}${parsed.ext}`);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, fixture.content);
  }
  const checker = spawnSync(process.execPath, [path.resolve("tools/ci/check-boundaries.mjs"), "--root", temporary], { encoding: "utf8" });
  const output = `${checker.stdout}\n${checker.stderr}`;
  if (checker.status === 0) throw new Error("real boundary checker accepted deliberate violations");
  const missing = rules.map((rule) => rule.id).filter((id) => !output.includes(`${id}:`));
  if (missing.length) throw new Error(`real checker missed: ${missing.join(", ")}`);
  console.log(`VIOLATION_FIXTURES_OK: ${fixtures.length} deliberate failures through real checker`);
} finally { await rm(temporary, { recursive: true, force: true }); }
