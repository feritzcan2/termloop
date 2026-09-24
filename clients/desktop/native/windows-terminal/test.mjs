import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const temp = realpathSync(os.tmpdir());
  const profile = mkdtempSync(path.join(temp, "termloop-windows-terminal-test-"));
  env.TERMLOOP_NATIVE_TEST_PROFILE = profile;
  try {
    const result = spawnSync(require("electron"), [fileURLToPath(new URL("smoke.cjs", import.meta.url))], {
      env, windowsHide: true, stdio: "inherit", timeout: 45000,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    if (path.dirname(realpathSync(profile)) !== temp) throw new Error("Native test profile escaped temporary directory");
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
