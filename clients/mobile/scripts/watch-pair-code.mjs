// Generates a one-time six-digit pairing code for the TermLoop watch client.
// Usage: node scripts/watch-pair-code.mjs [--state-dir <gateway state dir>]
// The code (hashed, never stored in clear) expires after ten minutes and is
// consumed by the gateway's POST /watch/pair on first successful use.
import { randomInt } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WATCH_PAIR_TTL_MS, hashPairCode } from "./mobile-access-watch.mjs";

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const stateDirectory = option("--state-dir") ?? (await latestGatewayStateDirectory());
const configFile = path.join(stateDirectory, "gateway.json");
const config = JSON.parse(await readFile(configFile, "utf8"));
if (typeof config.watchToken !== "string" || config.watchToken.length < 32) {
  throw new Error("Gateway config has no watch token. Re-run: pnpm --filter @termloop/mobile mobile-access");
}

const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
const pairFile = path.join(stateDirectory, "watch-pair.json");
await writeFile(
  pairFile,
  `${JSON.stringify({ codeHash: hashPairCode(code), expiresAtEpochMs: Date.now() + WATCH_PAIR_TTL_MS })}\n`,
  { mode: 0o600 },
);
await chmod(pairFile, 0o600);

console.log(`Watch pairing code: ${code}`);
console.log("Valid for 10 minutes, single use.");
const host = await tailnetHost();
if (host) console.log(`On the watch, enter host: ${host}`);
else console.log("On the watch, enter this Mac's tailnet DNS name as the host.");

async function latestGatewayStateDirectory() {
  const root = path.join(os.homedir(), "Library/Application Support/TermLoop Mobile Access");
  let newest;
  for (const entry of await readdir(root)) {
    const candidate = path.join(root, entry);
    try {
      const info = await stat(path.join(candidate, "gateway.json"));
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs: info.mtimeMs };
    } catch {
      // Not a gateway state directory.
    }
  }
  if (!newest) {
    throw new Error("No mobile access gateway found. Run: pnpm --filter @termloop/mobile mobile-access");
  }
  return newest.path;
}

async function tailnetHost() {
  for (const candidate of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const status = JSON.parse((await execFile(candidate, ["status", "--json"])).stdout);
      const dnsName = status?.Self?.DNSName;
      if (typeof dnsName === "string" && dnsName.length > 0) return dnsName.replace(/\.$/, "");
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
