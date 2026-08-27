import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  mobileAccessNodeExecutable,
  mobileAccessScriptPath,
  prepareMobileAccessQr,
} from "../src/platform/mobile-access.js";

describe("mobile access QR preparation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      force: true,
      recursive: true,
    })));
  });

  async function script(source: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-mobile-access-test-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "fixture.mjs");
    await writeFile(file, source);
    return file;
  }

  it("resolves the source script from the checkout when the desktop runs from a launch bundle", () => {
    expect(mobileAccessScriptPath(
      "/Library/Application Support/termloop-next/launches/bundle.123/clients/desktop/dist",
      "/Volumes/code/termloop-next",
    )).toBe(path.join(
      "/Volumes/code/termloop-next",
      "clients",
      "mobile",
      "scripts",
      "mobile-access.mjs",
    ));
  });

  it("falls back to node when the launcher provides an empty executable", () => {
    expect(mobileAccessNodeExecutable()).toBe("node");
    expect(mobileAccessNodeExecutable(" ")).toBe("node");
    expect(mobileAccessNodeExecutable("/opt/node/bin/node")).toBe("/opt/node/bin/node");
  });

  it("turns a versioned pairing payload into QR geometry without returning the payload", async () => {
    const pairingScript = await script('console.log(\'TLMP1:{"fixture":true}\');');

    const svg = await prepareMobileAccessQr(pairingScript, process.execPath);

    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('style="stroke-linecap:butt;stroke-linejoin:miter;stroke-width:1"');
    expect(svg).not.toContain("TLMP1:");
    expect(svg).not.toContain("fixture");
  });

  it("rejects output that does not contain a pairing payload", async () => {
    const pairingScript = await script('console.log("not a pairing code");');

    await expect(prepareMobileAccessQr(pairingScript, process.execPath)).rejects.toThrow(
      "Mobile Access did not produce a valid pairing code.",
    );
  });
});
