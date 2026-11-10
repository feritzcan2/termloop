import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/// The exact digest of one schema document. It changes on every edit and is
/// exposed only for diagnostics; peers never compare it for compatibility.
export function contractRevision(schema) {
  return sha256(canonicalJson(schema));
}

/// The compatibility identity peers compare on the wire. A schema that declares
/// `x-contract-major` keeps one identity for the whole major line, so additive
/// changes (checked by tools/codegen/check-compat.mjs) never strand older
/// peers. A schema without a major (the access plane) stays exact.
export function contractIdentity(schema) {
  const major = schema["x-contract-major"];
  if (major === undefined) return contractRevision(schema);
  if (!Number.isSafeInteger(major) || major < 1) throw new Error("x-contract-major must be a positive integer");
  return sha256(canonicalJson({ contract: schema.$id, major }));
}
