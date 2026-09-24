import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { it } from "vitest";

it("preserves a leading zero byte in generated Ed25519 public keys", () => {
  const ssh2Path = createRequire(import.meta.url).resolve("ssh2");
  // This public test-only pair has a zero as the first byte of its 32-byte key.
  // A child isolates the crypto fixture from every other SSH test.
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const crypto = require("node:crypto");
    const publicKey = Buffer.from("302a300506032b657003210000f1563457e6574a0a744774e347a031f2448be44d7f7bf9274f2fa8094642b9", "hex");
    const privateKey = Buffer.from("302e020100300506032b657004220420e6e3ce44b5e694c58f1bf1b0a6fa7d1e6fa8ddd872b483259807d47d5c50b8a5", "hex");
    crypto.generateKeyPairSync = () => ({ publicKey, privateKey });
    const { utils } = require(process.argv[1]);
    const generated = utils.generateKeyPairSync("ed25519");
    const parsed = utils.parseKey(generated.private);
    assert.ok(!(parsed instanceof Error), String(parsed));
    assert.ok(parsed.getPublicSSH().subarray(-32).equals(publicKey.subarray(-32)));
    const message = Buffer.from("TermLoop SSH key regression fixture");
    assert.ok(crypto.verify(null, message, { key: publicKey, format: "der", type: "spki" }, parsed.sign(message)));
  `, ssh2Path], { encoding: "utf8", timeout: 10_000 });
});
