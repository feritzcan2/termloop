import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("matrix includes many-terminal cliff probes", async () => {
  const source = await readFile(new URL("../src/renderer.ts", import.meta.url), "utf8");
  assert.match(source, /\[1, 8, 16, 32\]/);
  assert.match(source, /onContextLoss/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /installDsrResponder/);
  const main = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /backgroundThrottling: false/);
});
