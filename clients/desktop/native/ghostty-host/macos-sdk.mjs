import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Zig 0.15.2 cannot resolve arm64e-only libSystem stubs in macOS 26.4+ SDKs.
// Select an installed compatible SDK without changing the machine's Xcode.
export function selectCompatibleSdk(candidates) {
  for (const sdk of candidates) {
    try {
      const stub = readFileSync(path.join(sdk, "usr/lib/libSystem.tbd"), "utf8");
      const targets = stub.match(/^targets:\s*\[([^\]]*)\]/m)?.[1].split(/[,\s]+/);
      if (targets?.includes("arm64-macos") && targets.includes("x86_64-macos")) return sdk;
    } catch { /* Not an installed SDK. */ }
  }
  throw new Error("Ghostty's Zig 0.15.2 needs an SDK with arm64-macos libSystem stubs; install Xcode/CLT 26.3 or earlier, or set TERMLOOP_GHOSTTY_SDK to a compatible installed SDK.");
}

export function findGhosttySdk() {
  if (process.env.TERMLOOP_GHOSTTY_SDK) {
    return selectCompatibleSdk([process.env.TERMLOOP_GHOSTTY_SDK]);
  }
  const selected = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
  const current = selected.status === 0 ? selected.stdout.trim() : "";
  const directories = new Set([
    ...(current ? [path.dirname(current)] : []),
    "/Library/Developer/CommandLineTools/SDKs",
  ]);
  for (const entry of readdirSync("/Applications")) {
    if (/^Xcode.*\.app$/.test(entry)) {
      directories.add(path.join("/Applications", entry, "Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs"));
    }
  }
  const candidates = current ? [current] : [];
  for (const directory of directories) {
    try {
      candidates.push(...readdirSync(directory).filter((entry) => /^MacOSX.*\.sdk$/.test(entry))
        .sort().reverse().map((entry) => path.join(directory, entry)));
    } catch { /* An Xcode installation may not contain macOS SDKs. */ }
  }
  return selectCompatibleSdk(candidates);
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
