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
  const ownershipCases = [
    ["modules/agent-runtime/src/session.rs", 'spawn_tracked_managed_process("codex", args);', null],
    ["modules/core/src/session_launch/mod.rs", 'spawn_tracked_managed_process("codex", args);', "DIRECT_AGENT_PROCESS_SPAWN"],
    ["modules/agent-runtime/src/delivery.rs", "terminal.input_atomic_receipted(id, epoch, data);", null],
    ["modules/launch/src/payload.rs", "LaunchPayload { program, args }", null],
    ["modules/invocation/src/product.rs", "fn launch() -> LaunchPayload { compose() }", null],
    ["modules/invocation/src/product.rs", "LaunchPayload { program, args }", "LAUNCH_PROVENANCE"],
  ];
  for (const [index, [relative, content, expected]] of ownershipCases.entries()) {
    const root = path.join(temporary, `ownership-${index}`);
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    const result = spawnSync(process.execPath, [path.resolve("tools/ci/check-boundaries.mjs"), "--root", root], { encoding: "utf8" });
    const output = `${result.stdout}\n${result.stderr}`;
    if (expected ? result.status === 0 || !output.includes(`${expected}:`) : result.status !== 0) {
      throw new Error(`ownership fixture ${relative} failed: ${output}`);
    }
  }
  console.log(`OWNERSHIP_FIXTURES_OK: ${ownershipCases.length} positive/negative cases through real checker`);
} finally { await rm(temporary, { recursive: true, force: true }); }
