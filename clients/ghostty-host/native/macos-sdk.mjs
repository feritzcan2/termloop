import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Ghostty builds against the selected Xcode/CLT macOS SDK. TERMLOOP_GHOSTTY_SDK
// pins a different installed SDK without changing the machine's Xcode.
export function findGhosttySdk() {
  const override = process.env.TERMLOOP_GHOSTTY_SDK;
  if (override) {
    if (!existsSync(path.join(override, "usr/lib/libSystem.tbd"))) {
      throw new Error(`TERMLOOP_GHOSTTY_SDK is not an installed macOS SDK: ${override}`);
    }
    return override;
  }
  const selected = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
  const current = selected.status === 0 ? selected.stdout.trim() : "";
  if (!current) throw new Error("no macOS SDK is selected; install Xcode or the Command Line Tools");
  return current;
}

export function withGhosttySdk(sdk, callback) {
  const directory = mkdtempSync(path.join(tmpdir(), "termloop-ghostty-sdk-"));
  const quoted = `'${sdk.replaceAll("'", "'\\''")}'`;
  try {
    // Zig's build runner ignores --sysroot and asks xcrun for "macosx".
    // Scope this exact SDK-query override to the Zig subprocess and its children.
    writeFileSync(path.join(directory, "xcrun"), `#!/bin/sh\nif [ "$#" = 3 ] && [ "$1" = --sdk ] && [ "$2" = macosx ] && [ "$3" = --show-sdk-path ]; then\n  printf '%s\\n' ${quoted}\nelse\n  exec /usr/bin/xcrun "$@"\nfi\n`, { mode: 0o700 });
    return callback({ ...process.env, SDKROOT: sdk, PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}` });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
