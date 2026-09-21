import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utils } from "ssh2";
import { createManagedIdentity, managedIdentityPaths } from "../src/platform/ssh-setup-connection.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

const roots: string[] = [];
afterEach(async () => { vi.mocked(writeFile).mockClear(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const id = "b65f4086-e46c-4aef-9eab-57f96fcaa629";
const target = { host: "fixture.invalid", port: 22, user: "fixture", name: "Fixture", identityFiles: [] };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "termloop-key-recovery-"));
  roots.push(root);
  const host = utils.parseKey(utils.generateKeyPairSync("ed25519").private);
  if (host instanceof Error || Array.isArray(host)) throw new Error("Invalid host fixture");
  return { root, identity: { key: host.getPublicSSH(), fingerprint: "fixture" }, ...managedIdentityPaths(root, id) };
}

describe("managed SSH identity recovery", () => {
  it.each([false, true])("recovers after a failed public-key write (partial file: %s)", async (partial) => {
    const f = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(actual.writeFile).mockImplementationOnce(async (file) => {
      if (partial) await actual.writeFile(file, "ssh-ed25519 truncated");
      throw Object.assign(new Error("Injected write failure"), { code: "ENOSPC" });
    });
    await expect(createManagedIdentity(f.root, id, target, f.identity)).rejects.toMatchObject({ code: "ENOSPC" });
    const originalPrivate = await readFile(f.identityFile);
    const recovered = await createManagedIdentity(f.root, id, target, f.identity);
    const again = await createManagedIdentity(f.root, id, target, f.identity);
    expect(await readFile(f.identityFile)).toEqual(originalPrivate);
    expect(again.publicKey).toBe(recovered.publicKey);
    const key = utils.parseKey(originalPrivate);
    const publicKey = utils.parseKey(recovered.publicKey);
    if (key instanceof Error || Array.isArray(key) || publicKey instanceof Error || Array.isArray(publicKey)) throw new Error("Invalid recovered identity");
    expect(publicKey.getPublicSSH()).toEqual(key.getPublicSSH());
    expect(publicKey.verify(Buffer.from("recovery"), key.sign(Buffer.from("recovery")))).toBe(true);
  });

  it("does not replace a damaged existing private key during recovery", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.identityFile), { recursive: true });
    await writeFile(f.identityFile, "incomplete-private-key");
    await expect(createManagedIdentity(f.root, id, target, f.identity)).rejects.toThrow(/managed SSH key is invalid/);
    expect(await readFile(f.identityFile, "utf8")).toBe("incomplete-private-key");
  });
});
