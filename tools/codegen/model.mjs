import { readFile } from "node:fs/promises";
import path from "node:path";
import { contractIdentity } from "./contract-identity.mjs";

// Loads one contract target's schema and its companion schemas into the model
// every emitter reads: merged definitions, methods, events, MCP-only tools,
// capability scopes, patterns, and identities.
export async function loadContractModel(root, target) {
  const schema = JSON.parse(await readFile(path.join(root, target.schemaPath), "utf8"));
  const extras = [];
  for (const extra of target.extraSchemas ?? []) {
    extras.push({ owner: extra.owner, role: extra.role, schema: JSON.parse(await readFile(path.join(root, extra.path), "utf8")) });
  }
  for (const [index, extra] of extras.entries()) {
    for (const key of Object.keys(extra.schema.$defs ?? {})) {
      if (Object.hasOwn(schema.$defs, key)) throw new Error(`${extra.owner} definition shadows control definition: ${key}`);
      for (const earlier of extras.slice(0, index)) {
        if (Object.hasOwn(earlier.schema.$defs ?? {}, key)) throw new Error(`${extra.owner} definition shadows ${earlier.owner} definition: ${key}`);
      }
    }
  }
  const definitions = Object.assign({}, schema.$defs, ...extras.map((extra) => extra.schema.$defs));
  const methods = schema.$defs.method.enum;
  const methodShapes = schema["x-methods"];
  const events = schema.$defs.eventName.enum;
  const eventShapes = schema["x-events"];
  const mcpToolShapes = Object.assign({}, ...extras.map((extra) => extra.schema["x-mcp-tools"] ?? {}));
  const mcpTools = Object.keys(mcpToolShapes);
  const mcpToolRoles = (tool) => Array.isArray(mcpToolShapes[tool].role) ? mcpToolShapes[tool].role : [mcpToolShapes[tool].role];
  for (const [tool, shape] of Object.entries(mcpToolShapes)) {
    if (!mcpToolRoles(tool).every((role) => schema.$defs.mcpToolRole.enum.includes(role)) || !shape.params?.$ref || !shape.result?.$ref) {
      throw new Error(`invalid MCP tool shape: ${tool}`);
    }
  }
  if (JSON.stringify(Object.keys(methodShapes)) !== JSON.stringify(methods)) {
    throw new Error("x-methods must define every method once and in method enum order");
  }
  if (JSON.stringify(Object.keys(eventShapes)) !== JSON.stringify(events)) {
    throw new Error("x-events must define every event once and in event enum order");
  }
  for (const [scope, scoped] of Object.entries(schema["x-capability-scopes"] ?? {})) {
    const unknown = scoped.filter((method) => !methods.includes(method));
    if (unknown.length) throw new Error(`capability scope ${scope} names unknown methods: ${unknown.join(", ")}`);
  }
  const accessExtra = extras.find((extra) => extra.role === "access");
  return {
    definitions,
    methods,
    methodShapes,
    events,
    eventShapes,
    mcpToolShapes,
    mcpTools,
    toolsForMcpRole: (role) => mcpTools.filter((tool) => mcpToolRoles(tool).includes(role)),
    capabilityScopes: schema["x-capability-scopes"] ?? {},
    contractPatterns: [...new Set([schema, ...extras.map((extra) => extra.schema)].flatMap((source) => [...collectPatterns(source)]))].sort(),
    identity: contractIdentity(schema),
    accessIdentity: accessExtra ? contractIdentity(accessExtra.schema) : undefined,
    generatedDefinitions: Object.entries(definitions).filter(([, value]) => value["x-codegen"]),
    emptyParamMethods: methods.filter((method) => referenceKey(methodShapes[method].params.$ref) === "emptyParams"),
  };
}

function collectPatterns(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPatterns(item, found);
  } else if (value && typeof value === "object") {
    if (typeof value.pattern === "string") found.add(value.pattern);
    for (const child of Object.values(value)) collectPatterns(child, found);
  }
  return found;
}

export function definitionName(model, key) {
  const definition = model.definitions[key];
  if (!definition) throw new Error(`unknown schema definition: ${key}`);
  return definition["x-codegen-name"] ?? typeName(key);
}

export function referenceKey(reference) {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) throw new Error(`external refs are unsupported: ${reference}`);
  return reference.slice(prefix.length);
}

export function typeName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function rustFieldName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toLowerCase();
}

export function dereferenceLocalSchema(model, node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((value) => dereferenceLocalSchema(model, value, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    const key = referenceKey(node.$ref);
    if (seen.has(key)) throw new Error(`recursive MCP input schema ref is unsupported: ${key}`);
    return dereferenceLocalSchema(model, model.definitions[key], new Set([...seen, key]));
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !key.startsWith("x-codegen"))
      .map(([key, value]) => [key, dereferenceLocalSchema(model, value, seen)]),
  );
}

export function nullableUnionInner(node) {
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2) return undefined;
  const nonNull = node.anyOf.filter((value) => value.type !== "null");
  const nulls = node.anyOf.filter((value) => value.type === "null");
  return nonNull.length === 1 && nulls.length === 1 ? nonNull[0] : undefined;
}
