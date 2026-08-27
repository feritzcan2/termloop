import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

assert.equal(process.platform, "darwin", "the real Ghostty E2E test requires macOS");

const root = process.cwd();
await Promise.all([
  access(path.join(root, "clients/desktop/native/ghostty-host/build/Release/ghostty_host.node")),
  access(path.join(root, "vendor/ghostty/zig-out/lib/libghostty.dylib")),
]);

process.env.TERMLOOP_E2E_REQUIRE_GHOSTTY = "1";
await import("./agent-resume.mjs");
