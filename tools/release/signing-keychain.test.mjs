import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const setup = workflow.match(/^( +)keychain_path=.*\n[\s\S]*?(?=^\1pnpm --filter @termloop\/desktop native:ghostty:universal)/m)?.[0];
assert.ok(setup, "release signing setup must be exercised by this fixture");

for (const failImport of [false, true]) {
  test(`signing preserves the user keychain and cleans up after ${failImport ? "import failure" : "success"}`, { skip: process.platform === "win32" }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-signing-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = ['"/fixture/login.keychain-db"', '"/fixture/other.keychain"'].join("\n") + "\n";
    await writeFile(path.join(directory, "search-list"), original);
    await writeFile(path.join(directory, "default"), "/fixture/login.keychain-db\n");
    const script = `
set -euo pipefail
uuidgen() { printf 'fixture-password\\n'; }
base64() { cat; }
security() {
  local action="$1"; shift
  local last="" value
  for value in "$@"; do last="$value"; done
  case "$action" in
    default-keychain)
      if [[ "$*" == *"-s "* ]]; then printf '%s\\n' "$last" > "$RUNNER_TEMP/default";
      else cat "$RUNNER_TEMP/default"; fi ;;
    list-keychains)
      if [[ "$*" == *"-s "* ]]; then
        shift 3
        printf '\"%s\"\\n' "$@" > "$RUNNER_TEMP/search-list"
      else cat "$RUNNER_TEMP/search-list"; fi ;;
    create-keychain) touch "$last" ;;
    delete-keychain) rm "$last" ;;
    import) [[ "$FAIL_IMPORT" == "0" ]] ;;
    find-identity) printf '%s\\n' "$MACOS_SIGNING_IDENTITY" ;;
    set-keychain-settings|unlock-keychain|set-key-partition-list) ;;
    *) return 98 ;;
  esac
}
codesign() {
  [[ "$*" == *"--keychain $CSC_KEYCHAIN "* ]]
  test "$(cat "$RUNNER_TEMP/default")" = /fixture/login.keychain-db
  test "$(head -1 "$RUNNER_TEMP/search-list")" = '\"/fixture/login.keychain-db\"'
  test -f "$CSC_KEYCHAIN"
  printf 'signed\\n' >> "$RUNNER_TEMP/signed"
}
${setup}
`;
    const result = spawnSync("/bin/bash", ["-c", script], {
      encoding: "utf8", timeout: 10_000,
      env: {
        PATH: process.env.PATH, RUNNER_TEMP: directory, FAIL_IMPORT: failImport ? "1" : "0",
        MACOS_CERTIFICATE_BASE64: "fixture", MACOS_CERTIFICATE_PASSWORD: "fixture",
        MACOS_SIGNING_IDENTITY: "Developer ID Application: Fixture",
        MACOS_API_KEY_BASE64: "", MACOS_API_KEY_ID: "", MACOS_API_ISSUER: "",
      },
    });
    assert.equal(result.status, failImport ? 1 : 0, result.stdout + result.stderr);
    assert.equal(await readFile(path.join(directory, "default"), "utf8"), "/fixture/login.keychain-db\n");
    assert.equal(await readFile(path.join(directory, "search-list"), "utf8"), original);
    for (const name of ["termloop-release-signing.keychain-db", "termloop-release-signing.p12"]) {
      await assert.rejects(readFile(path.join(directory, name)), { code: "ENOENT" });
    }
    if (!failImport) assert.equal(await readFile(path.join(directory, "signed"), "utf8"), "signed\nsigned\nsigned\n");
  });
}
