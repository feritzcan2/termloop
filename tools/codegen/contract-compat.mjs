import { referenceKey } from "./model.mjs";

// Structural wire-compatibility diff between two versions of the control
// schema. Peers within one `x-contract-major` must interoperate in both
// directions: TypeScript readers ignore unknown fields and enum values, the
// server rejects unknown request fields only when a client actually sends them,
// and unknown methods fail with a typed `methodNotFound`. Under those rules a
// change is additive when every peer pair keeps working on existing data, and
// breaking otherwise.

// Keys that never reach the wire: documentation and generator hints.
const NON_WIRE_KEYS = new Set(["description", "title", "examples", "$comment", "$schema", "$id", "default"]);
// Size bounds guard each reader against its peer. Moving one only matters for
// values beyond the old bound, which fail closed on that single message.
const BOUND_KEYS = new Set([
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "x-utf8-max-bytes",
]);
const STRUCTURAL_KEYS = new Set([
  "$ref", "type", "const", "enum", "pattern", "format", "properties", "required", "items",
  "anyOf", "oneOf", "allOf", "if", "then", "else", "additionalProperties",
]);

export function contractMajor(schema) {
  return schema["x-contract-major"] ?? 0;
}

export function compareContracts(base, head) {
  const breaking = [];
  const additive = [];
  const visited = new Set();

  const resolve = (schema, node) => node.$ref ? schema.$defs?.[referenceKey(node.$ref)] : node;

  function walk(b, h, path) {
    if (b === h) return;
    if (typeof b !== "object" || typeof h !== "object" || b === null || h === null) {
      if (JSON.stringify(b) !== JSON.stringify(h)) breaking.push({ path, message: "schema changed" });
      return;
    }
    if (b.$ref || h.$ref) {
      // Same named definition: compared once at the top level.
      if (b.$ref === h.$ref) return;
      const pair = `${b.$ref ?? path}|${h.$ref ?? path}`;
      if (visited.has(pair)) return;
      visited.add(pair);
      const rb = resolve(base, b);
      const rh = resolve(head, h);
      if (!rb || !rh) {
        breaking.push({ path, message: `reference ${b.$ref ?? "(inline)"} → ${h.$ref ?? "(inline)"} cannot be resolved` });
        return;
      }
      walk(rb, rh, path);
      return;
    }
    for (const key of new Set([...Object.keys(b), ...Object.keys(h)])) {
      if (NON_WIRE_KEYS.has(key) || BOUND_KEYS.has(key) || STRUCTURAL_KEYS.has(key)) continue;
      if (key.startsWith("x-")) continue;
      if (JSON.stringify(b[key]) !== JSON.stringify(h[key])) breaking.push({ path, message: `unsupported keyword ${key} changed` });
    }
    const typeOf = (node) => node.type === undefined ? undefined : [].concat(node.type).sort().join("|");
    if (typeOf(b) !== typeOf(h)) breaking.push({ path, message: `type ${typeOf(b) ?? "(any)"} → ${typeOf(h) ?? "(any)"}` });
    if (JSON.stringify(b.const) !== JSON.stringify(h.const)) breaking.push({ path, message: `const ${JSON.stringify(b.const)} → ${JSON.stringify(h.const)}` });
    if (b.pattern !== h.pattern) breaking.push({ path, message: "pattern changed" });
    if (b.format !== h.format) breaking.push({ path, message: "format changed" });
    if (b.enum || h.enum) {
      if (!b.enum || !h.enum) {
        breaking.push({ path, message: h.enum ? "enum restriction added" : "enum restriction removed" });
      } else {
        for (const value of b.enum) if (!h.enum.includes(value)) breaking.push({ path, message: `enum value ${JSON.stringify(value)} removed` });
        for (const value of h.enum) if (!b.enum.includes(value)) additive.push({ path, message: `enum value ${JSON.stringify(value)} added` });
      }
    }
    if (b.properties || h.properties || b.required || h.required) {
      const bp = b.properties ?? {};
      const hp = h.properties ?? {};
      const br = new Set(b.required ?? []);
      const hr = new Set(h.required ?? []);
      for (const field of Object.keys(bp)) {
        if (!Object.hasOwn(hp, field)) breaking.push({ path: `${path}.${field}`, message: "property removed" });
      }
      for (const field of Object.keys(hp)) {
        if (Object.hasOwn(bp, field)) {
          walk(bp[field], hp[field], `${path}.${field}`);
          if (br.has(field) && !hr.has(field)) breaking.push({ path: `${path}.${field}`, message: "property became optional" });
          if (!br.has(field) && hr.has(field)) breaking.push({ path: `${path}.${field}`, message: "property became required" });
        } else if (hr.has(field)) {
          breaking.push({ path: `${path}.${field}`, message: "new required property (add it as optional instead)" });
        } else {
          additive.push({ path: `${path}.${field}`, message: "optional property added" });
        }
      }
    }
    if (b.items || h.items) {
      if (!b.items || !h.items) breaking.push({ path, message: "array items changed" });
      else walk(b.items, h.items, `${path}[]`);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (!b[key] && !h[key]) continue;
      if (!b[key] || !h[key] || b[key].length !== h[key].length) {
        breaking.push({ path, message: `${key} variants changed` });
        continue;
      }
      b[key].forEach((variant, index) => walk(variant, h[key][index], `${path}<${key}${index}>`));
    }
    for (const key of ["if", "then", "else"]) {
      if (!b[key] && !h[key]) continue;
      if (!b[key] || !h[key]) breaking.push({ path, message: `${key} condition changed` });
      else walk(b[key], h[key], `${path}<${key}>`);
    }
    if (typeof b.additionalProperties === "object" && typeof h.additionalProperties === "object") {
      walk(b.additionalProperties, h.additionalProperties, `${path}{*}`);
    }
  }

  const listDiff = (label, before = [], after = []) => {
    for (const name of before) if (!after.includes(name)) breaking.push({ path: label, message: `${JSON.stringify(name)} removed` });
    for (const name of after) if (!before.includes(name)) additive.push({ path: label, message: `${JSON.stringify(name)} added` });
  };

  listDiff("methods", base.$defs?.method?.enum, head.$defs?.method?.enum);
  listDiff("events", base.$defs?.eventName?.enum, head.$defs?.eventName?.enum);
  for (const [method, shape] of Object.entries(base["x-methods"] ?? {})) {
    const next = head["x-methods"]?.[method];
    if (!next) continue;
    walk(shape.params, next.params, `${method}.params`);
    walk(shape.result, next.result, `${method}.result`);
  }
  for (const [event, shape] of Object.entries(base["x-events"] ?? {})) {
    const next = head["x-events"]?.[event];
    if (next) walk(shape.payload, next.payload, `${event}.payload`);
  }
  for (const [scope, methods] of Object.entries(base["x-capability-scopes"] ?? {})) {
    const next = head["x-capability-scopes"]?.[scope];
    if (!next) breaking.push({ path: `scope ${scope}`, message: "capability scope removed" });
    else for (const method of methods) if (!next.includes(method)) breaking.push({ path: `scope ${scope}`, message: `${JSON.stringify(method)} removed` });
  }
  for (const [key, definition] of Object.entries(base.$defs ?? {})) {
    // Method and event name lists are compared above; removed definitions only
    // matter through a referrer, which the walk already reports.
    if (key === "method" || key === "eventName" || !head.$defs?.[key]) continue;
    walk(definition, head.$defs[key], `$defs.${key}`);
  }
  return { baseMajor: contractMajor(base), headMajor: contractMajor(head), breaking, additive };
}

/// Returns `{ ok, summary }` for the policy: breaking changes require a major
/// bump, and the major never decreases.
export function evaluateCompatibility(base, head) {
  const result = compareContracts(base, head);
  const { baseMajor, headMajor, breaking } = result;
  if (headMajor < baseMajor) return { ...result, ok: false, reason: `x-contract-major decreased from ${baseMajor} to ${headMajor}` };
  if (headMajor > baseMajor) return { ...result, ok: true, reason: `x-contract-major bumped from ${baseMajor} to ${headMajor}` };
  if (breaking.length) return { ...result, ok: false, reason: `${breaking.length} breaking change(s) without an x-contract-major bump` };
  return { ...result, ok: true, reason: "compatible within the same contract major" };
}
