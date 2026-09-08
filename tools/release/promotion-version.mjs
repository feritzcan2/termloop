import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { newerVersion, parseVersion } from "../server/server-release.mjs";

export function promotionVersion(current, main, tags) {
  parseVersion(current);
  parseVersion(main);
  let reserved = main;
  for (const tag of tags) {
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) continue;
    const version = tag.slice(1);
    if (newerVersion(version, reserved)) reserved = version;
  }
  // Keep an unpublished version already prepared for this promotion, including retries.
  if (newerVersion(current, reserved)) return current;
  const [major, minor, patch] = parseVersion(reserved);
  const next = `${major}.${minor}.${patch + 1}`;
  parseVersion(next);
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [current, main, ...tags] = process.argv.slice(2);
  console.log(promotionVersion(current, main, tags));
}
