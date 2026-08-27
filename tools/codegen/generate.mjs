import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { contractIdentity } from "./contract-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = path.join(root, "contract/schema/control.current.schema.json");
const mcpSchemaPath = path.join(root, "contract/schema/mcp.ask-to.schema.json");
const accessSchemaPath = path.join(root, "contract/schema/access.v1.schema.json");
const schemaSource = await readFile(schemaPath, "utf8");
const mcpSchemaSource = await readFile(mcpSchemaPath, "utf8");
const accessSchemaSource = await readFile(accessSchemaPath, "utf8");
const schema = JSON.parse(schemaSource);
const mcpSchema = JSON.parse(mcpSchemaSource);
const accessSchema = JSON.parse(accessSchemaSource);
const identity = contractIdentity(schema);
const accessIdentity = contractIdentity(accessSchema);
for (const [owner, extraSchema] of [["MCP", mcpSchema], ["access", accessSchema]]) {
  for (const key of Object.keys(extraSchema.$defs ?? {})) {
    if (Object.hasOwn(schema.$defs, key)) throw new Error(`${owner} definition shadows control definition: ${key}`);
    if (owner === "access" && Object.hasOwn(mcpSchema.$defs ?? {}, key)) throw new Error(`access definition shadows MCP definition: ${key}`);
  }
}
const definitions = { ...schema.$defs, ...mcpSchema.$defs, ...accessSchema.$defs };
const methods = schema.$defs.method.enum;
const methodShapes = schema["x-methods"];
const eventShapes = schema["x-events"];
const events = schema.$defs.eventName.enum;
const mcpToolShapes = mcpSchema["x-mcp-tools"] ?? {};
const mcpTools = Object.keys(mcpToolShapes);
for (const [tool, shape] of Object.entries(mcpToolShapes)) {
  const roles = Array.isArray(shape.role) ? shape.role : [shape.role];
  if (!roles.every((role) => schema.$defs.mcpToolRole.enum.includes(role)) || !shape.params?.$ref || !shape.result?.$ref) {
    throw new Error(`invalid MCP tool shape: ${tool}`);
  }
}
const toolsForMcpRole = (role) => mcpTools.filter((tool) => {
  const roles = Array.isArray(mcpToolShapes[tool].role) ? mcpToolShapes[tool].role : [mcpToolShapes[tool].role];
  return roles.includes(role);
});
const mcpInteractiveTools = toolsForMcpRole("interactive");
const mcpStewardTools = toolsForMcpRole("steward");
const mcpWorkerTools = toolsForMcpRole("worker");
const mcpHelperTools = toolsForMcpRole("helper");
const mcpImproverTools = toolsForMcpRole("improver");
const mcpToolDefinitions = mcpTools.map((name) => ({
  name,
  description: mcpToolShapes[name].description,
  inputSchema: dereferenceLocalSchema(mcpToolShapes[name].params),
  annotations: mcpToolShapes[name].annotations,
}));
const contractPatterns = [...new Set([
  ...collectPatterns(schema),
  ...collectPatterns(mcpSchema),
  ...collectPatterns(accessSchema),
])].sort();
const readOnlyMethods = schema["x-capability-scopes"]["control.readOnly"];
const companionMethods = schema["x-capability-scopes"]["control.companion"];
const emptyParamMethods = methods.filter((method) => referenceKey(methodShapes[method].params.$ref) === "emptyParams");

if (JSON.stringify(Object.keys(methodShapes)) !== JSON.stringify(methods)) {
  throw new Error("x-methods must define every method once and in method enum order");
}
if (JSON.stringify(Object.keys(eventShapes)) !== JSON.stringify(events)) {
  throw new Error("x-events must define every event once and in event enum order");
}

const generatedDefinitions = Object.entries(definitions).filter(([, value]) => value["x-codegen"]);
const rustMethods = methods.map((method) => `    ${JSON.stringify(method)},`).join("\n");
const rustReadOnlyMethods = readOnlyMethods.map((method) => `    ${JSON.stringify(method)},`).join("\n");
const rustCompanionMethods = companionMethods.map((method) => `    ${JSON.stringify(method)},`).join("\n");
const rustEvents = events.map((event) => `    ${JSON.stringify(event)},`).join("\n");
const rustMcpTools = mcpTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n");
const rustMcpInteractiveTools = mcpInteractiveTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n");
const rustMcpHelperTools = mcpHelperTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n");
const rustMcpImproverTools = mcpImproverTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n");
const rustPatternStatics = contractPatterns.map((pattern, index) =>
  `static CONTRACT_PATTERN_${index}: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(${JSON.stringify(pattern)}).expect("generated contract pattern"));`,
).join("\n");
const rustPatternMatches = contractPatterns.map((pattern, index) =>
  `        ${JSON.stringify(pattern)} => CONTRACT_PATTERN_${index}.is_match(text),`,
).join("\n");

const rustDefinitions = generatedDefinitions
  .map(([key, definition]) => renderRustDefinition(key, definition))
  .join("\n\n");
const tsDefinitions = generatedDefinitions
  .map(([key, definition]) => renderTypeScriptDefinition(key, definition))
  .join("\n\n");

const methodAliasesRust = methods.flatMap((method) => {
  const stem = typeName(method);
  const aliases = [
    [`${stem}Params`, rustType(methodShapes[method].params)],
    [`${stem}Result`, rustType(methodShapes[method].result)],
  ];
  return aliases
    .filter(([name, target]) => name !== target)
    .map(([name, target]) => `pub type ${name} = ${target};`);
}).join("\n");

const methodAliasesTypeScript = methods.flatMap((method) => {
  const stem = typeName(method);
  const aliases = [
    [`${stem}Params`, typeScriptType(methodShapes[method].params)],
    [`${stem}Result`, typeScriptType(methodShapes[method].result)],
  ];
  return aliases
    .filter(([name, target]) => name !== target)
    .map(([name, target]) => `export type ${name} = ${target};`);
}).join("\n");

const rustConstraintHelpers = Object.entries(definitions)
  .map(([key, definition]) => `#[allow(\n    dead_code,\n    unused_comparisons,\n    unused_parens,\n    unused_variables,\n    clippy::absurd_extreme_comparisons,\n    clippy::len_zero,\n    clippy::redundant_closure,\n)]\nfn validate_${rustFieldName(key)}(value: &Value) -> bool {\n    ${rustConstraintInline(definition, "value")}\n}`)
  .join("\n\n");

const rust = formatRust(`// @generated by tools/codegen/generate.mjs; do not edit.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn json_array_unique(values: &[Value]) -> bool {
    values
        .iter()
        .enumerate()
        .all(|(index, value)| !values[index + 1..].contains(value))
}

${rustPatternStatics}

fn contract_pattern_matches(pattern: &str, text: &str) -> bool {
    match pattern {
${rustPatternMatches}
        _ => false,
    }
}

pub const CONTRACT_IDENTITY: &str = ${JSON.stringify(identity)};
pub const ACCESS_PROTOCOL_IDENTITY: &str = ${JSON.stringify(accessIdentity)};
pub const METHODS: &[&str] = &[
${rustMethods}
];
pub const READ_ONLY_METHODS: &[&str] = &[
${rustReadOnlyMethods}
];
pub const COMPANION_METHODS: &[&str] = &[
${rustCompanionMethods}
];
pub const EVENTS: &[&str] = &[
${rustEvents}
];
pub const MCP_TOOLS: &[&str] = &[
${rustMcpTools}
];
pub const MCP_INTERACTIVE_TOOLS: &[&str] = &[
${rustMcpInteractiveTools}
];
pub const MCP_STEWARD_TOOLS: &[&str] = &[
${mcpStewardTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n")}
];
pub const MCP_WORKER_TOOLS: &[&str] = &[
${mcpWorkerTools.map((tool) => `    ${JSON.stringify(tool)},`).join("\n")}
];
pub const MCP_HELPER_TOOLS: &[&str] = &[
${rustMcpHelperTools}
];
pub const MCP_IMPROVER_TOOLS: &[&str] = &[
${rustMcpImproverTools}
];
pub const MCP_TOOL_DEFINITIONS_JSON: &str = ${JSON.stringify(JSON.stringify(mcpToolDefinitions))};

${rustDefinitions}

${methodAliasesRust}

${rustConstraintHelpers}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_method_params(method: &str, params: &Value) -> bool {
    match method {
${methods.map((method) => `        ${JSON.stringify(method)} => serde_json::from_value::<${typeName(method)}Params>(params.clone()).is_ok() && ${rustConstraint(methodShapes[method].params, "params")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_method_result(method: &str, result: &Value) -> bool {
    match method {
${methods.map((method) => `        ${JSON.stringify(method)} => serde_json::from_value::<${typeName(method)}Result>(result.clone()).is_ok() && ${rustConstraint(methodShapes[method].result, "result")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_event_payload(event: &str, payload: &Value) -> bool {
    match event {
${events.map((event) => `        ${JSON.stringify(event)} => serde_json::from_value::<${typeName(event)}Payload>(payload.clone()).is_ok() && ${rustConstraint(eventShapes[event].payload, "payload")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_mcp_tool_params(tool: &str, params: &Value) -> bool {
    match tool {
${mcpTools.map((tool) => `        ${JSON.stringify(tool)} => serde_json::from_value::<${definitionName(referenceKey(mcpToolShapes[tool].params.$ref))}>(params.clone()).is_ok() && ${rustConstraint(mcpToolShapes[tool].params, "params")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_mcp_tool_result(tool: &str, result: &Value) -> bool {
    match tool {
${mcpTools.map((tool) => `        ${JSON.stringify(tool)} => serde_json::from_value::<${definitionName(referenceKey(mcpToolShapes[tool].result.$ref))}>(result.clone()).is_ok() && ${rustConstraint(mcpToolShapes[tool].result, "result")},`).join("\n")}
        _ => false,
    }
}
`);

const methodParamsEntries = methods
  .map((method) => `  ${JSON.stringify(method)}: ${typeName(method)}Params;`)
  .join("\n");
const methodResultEntries = methods
  .map((method) => `  ${JSON.stringify(method)}: ${typeName(method)}Result;`)
  .join("\n");

const ts = `// @generated by tools/codegen/generate.mjs; do not edit.
export const CONTRACT_IDENTITY = ${JSON.stringify(identity)} as const;
export const ACCESS_PROTOCOL_IDENTITY = ${JSON.stringify(accessIdentity)} as const;
export const METHODS = ${JSON.stringify(methods)} as const;
export const READ_ONLY_METHODS = ${JSON.stringify(readOnlyMethods)} as const;
export const COMPANION_METHODS = ${JSON.stringify(companionMethods)} as const;
export const EVENTS = ${JSON.stringify(events)} as const;
export const MCP_TOOLS = ${JSON.stringify(mcpTools)} as const;
export const MCP_INTERACTIVE_TOOLS = ${JSON.stringify(mcpInteractiveTools)} as const;
export const MCP_STEWARD_TOOLS = ${JSON.stringify(mcpStewardTools)} as const;
export const MCP_WORKER_TOOLS = ${JSON.stringify(mcpWorkerTools)} as const;
export const MCP_HELPER_TOOLS = ${JSON.stringify(mcpHelperTools)} as const;
export const MCP_IMPROVER_TOOLS = ${JSON.stringify(mcpImproverTools)} as const;
export const MCP_TOOL_DEFINITIONS = ${JSON.stringify(mcpToolDefinitions)} as const;
export type Method = typeof METHODS[number];

${tsDefinitions}

${methodAliasesTypeScript}

export interface MethodParams {
${methodParamsEntries}
}
export interface MethodResults {
${methodResultEntries}
}
export type ParamsFor<M extends Method> = MethodParams[M];
export type ResultFor<M extends Method> = MethodResults[M];
export type MethodsWithEmptyParams = ${emptyParamMethods.map(JSON.stringify).join(" | ")};
export type CallArgs<M extends Method> = M extends MethodsWithEmptyParams
  ? [params?: ParamsFor<M>]
  : [params: ParamsFor<M>];
const CONTROL_REQUEST_TIMEOUT_MS = 12_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 300_000;
export function controlRequestTimeoutMs(method: Method): number {
  return method === "task.cleanupWorktree" || method === "task.discardStaleWorktree" || method === "session.relocateAgentToTask" || method === "session.relocateAgentToProject" || method === "taskSource.boardList" || method === "taskSource.boardListStored" || method === "taskSource.statusList" || method === "taskSource.statusListStored" || method === "taskSource.refresh" || method === "playbook.update"
    ? LONG_RUNNING_REQUEST_TIMEOUT_MS
    : CONTROL_REQUEST_TIMEOUT_MS;
}
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonArrayUnique(values: unknown[]): boolean {
  return values.every((value, index) =>
    !values.slice(index + 1).some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  );
}

const CONTRACT_PATTERNS = new Map<string, RegExp>([
${contractPatterns.map((pattern) => `  [${JSON.stringify(pattern)}, new RegExp(${JSON.stringify(pattern)}, "u")],`).join("\n")}
]);

export function validateMethodResult(method: string, result: unknown): boolean {
  switch (method) {
${methods.map((method) => `    case ${JSON.stringify(method)}: return ${typeScriptConstraint(methodShapes[method].result, "result")};`).join("\n")}
    default: return false;
  }
}

export function validateEventPayload(event: string, payload: unknown): boolean {
  switch (event) {
${events.map((event) => `    case ${JSON.stringify(event)}: return ${typeScriptConstraint(eventShapes[event].payload, "payload")};`).join("\n")}
    default: return false;
  }
}

export function validateMcpToolResult(tool: string, result: unknown): boolean {
  switch (tool) {
${mcpTools.map((tool) => `    case ${JSON.stringify(tool)}: return ${typeScriptConstraint(mcpToolShapes[tool].result, "result")};`).join("\n")}
    default: return false;
  }
}

export interface SocketLike { addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void, options?: { once?: boolean }): void; send(data: string): void; close(): void; }
export type SocketFactory = (url: string) => SocketLike;
export class TermLoopControlError extends Error {
  constructor(message: string, readonly code: ErrorCode | undefined, readonly details: ProtocolErrorDetails | undefined) {
    super(message);
    this.name = "TermLoopControlError";
  }
}
type PendingControlCall = {
  readonly method: Method;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
const MAX_CONTROL_IN_FLIGHT = 64;
export class TermLoopControlClient {
  #counter = 0;
  #generation = 0;
  #socket: SocketLike | undefined;
  #connecting: Promise<SocketLike> | undefined;
  #pending = new Map<string, PendingControlCall>();
  constructor(readonly url: string, readonly token: string, readonly socketFactory: SocketFactory) {}
  async call<M extends Method>(method: M, ...args: CallArgs<M>): Promise<ResultFor<M>> {
    if (this.#pending.size >= MAX_CONTROL_IN_FLIGHT) {
      throw new TermLoopControlError("too many control requests are already in flight", "serviceBusy", undefined);
    }
    const id = String(++this.#counter);
    const params = (args[0] ?? {}) as ParamsFor<M>;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        this.#cancelTimedOutRequest(id, method);
        reject(new Error("request timeout"));
      }, controlRequestTimeoutMs(method));
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      void Promise.resolve().then(() => this.#connected()).then((socket) => {
        if (!this.#pending.has(id)) return;
        try {
          socket.send(JSON.stringify({ id, protocolVersion: CONTRACT_IDENTITY, token: this.token, method, params } satisfies ControlRequest));
        } catch {
          socket.close();
          this.#disconnect(this.#generation, new Error("connection failed"));
        }
      }).catch(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(new Error("connection failed"));
      });
    });
  }
  close(): void {
    const socket = this.#socket;
    this.#generation += 1;
    this.#socket = undefined;
    this.#connecting = undefined;
    this.#rejectPending(new Error("connection closed"));
    socket?.close();
  }
  #connected(): Promise<SocketLike> {
    if (this.#socket) return Promise.resolve(this.#socket);
    if (this.#connecting) return this.#connecting;
    const generation = ++this.#generation;
    const socket = this.socketFactory(this.url);
    const connecting = new Promise<SocketLike>((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        if (generation !== this.#generation) {
          socket.close();
          reject(new Error("connection superseded"));
          return;
        }
        opened = true;
        this.#socket = socket;
        this.#connecting = undefined;
        resolve(socket);
      }, { once: true });
      socket.addEventListener("message", (event) => this.#receive(generation, event));
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("connection failed"));
        this.#disconnect(generation, new Error("connection failed"));
        socket.close();
      }, { once: true });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("connection closed"));
        this.#disconnect(generation, new Error("connection closed"));
      }, { once: true });
    });
    this.#connecting = connecting;
    return connecting;
  }
  #receive(generation: number, event: any): void {
    if (generation !== this.#generation) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      const socket = this.#socket;
      this.#disconnect(generation, new Error("invalid control response"));
      socket?.close();
      return;
    }
    if (!isJsonObject(decoded)) {
      const socket = this.#socket;
      this.#disconnect(generation, new Error("invalid control response"));
      socket?.close();
      return;
    }
    // Subscription events share the connection but have no request id. They
    // belong to the dedicated subscriber and are intentionally ignored here.
    if (typeof decoded["id"] !== "string") return;
    const response = decoded as unknown as ControlResponse;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (!response.ok) pending.reject(new TermLoopControlError(response.error?.message ?? "request failed", response.error?.code, response.error?.details));
    else if (!validateMethodResult(pending.method, response.result)) pending.reject(new Error("invalid response"));
    else pending.resolve(response.result);
  }
  #cancelTimedOutRequest(requestId: string, method: Method): void {
    if (method === "control.cancel" || !this.#socket) return;
    try {
      this.#socket.send(JSON.stringify({
        id: "cancel-" + String(++this.#counter),
        protocolVersion: CONTRACT_IDENTITY,
        token: this.token,
        method: "control.cancel",
        params: { requestId },
      } satisfies ControlRequest));
    } catch {
      const socket = this.#socket;
      this.#disconnect(this.#generation, new Error("connection failed"));
      socket?.close();
    }
  }
  #disconnect(generation: number, error: Error): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#socket = undefined;
    this.#connecting = undefined;
    this.#rejectPending(error);
  }
  #rejectPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
  version() { return this.call("system.version"); }
  capabilities() { return this.call("system.capabilities"); }
  ping() { return this.call("system.ping"); }
}
`;

const outputs = [
  [path.join(root, "contract/generated/rust/src/lib.rs"), "// @generated by tools/codegen/generate.mjs; do not edit.\npub mod current;\n"],
  [path.join(root, "contract/generated/rust/src/current.rs"), rust],
  [path.join(root, "contract/generated/typescript/src/current.ts"), ts],
];
let drift = false;
for (const [output, content] of outputs) {
  let existing = "";
  try {
    existing = await readFile(output, "utf8");
  } catch {}
  if (process.argv.includes("--check")) {
    if (existing !== content) {
      console.error(`generated drift: ${path.relative(root, output)}`);
      drift = true;
    }
  } else if (existing !== content) {
    // Only write on a real change. Rewriting byte-identical output still moves
    // the file's mtime, and these outputs sit at the base of the crate graph, so
    // an unconditional write makes Cargo rebuild the entire workspace after
    // every codegen run.
    await writeFile(output, content);
  }
}
if (drift) process.exit(1);

function renderRustDefinition(key, definition) {
  const name = definitionName(key);
  if (definition["x-codegen-tagged-union"]) {
    const tag = definition["x-codegen-tagged-union"];
    const variants = definition.oneOf.map((variant) => {
      const tagValue = variant.properties?.[tag]?.const;
      if (typeof tagValue !== "string") throw new Error(`tagged union ${key} variant is missing ${tag} const`);
      const required = new Set(variant.required ?? []);
      const fields = Object.entries(variant.properties ?? {})
        .filter(([field]) => field !== tag)
        .map(([field, property]) => {
          const optional = !required.has(field);
          const fieldName = rustFieldName(field);
          const annotation = fieldName === field ? "" : `            #[serde(rename = ${JSON.stringify(field)})]\n`;
          const valueType = rustType(property);
          return `${annotation}            ${fieldName}: ${optional ? `Option<${valueType}>` : valueType},`;
        })
        .join("\n");
      return `    #[serde(rename = ${JSON.stringify(tagValue)})]\n    ${typeName(tagValue)} {\n${fields}\n    },`;
    }).join("\n");
    return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(tag = ${JSON.stringify(tag)}, deny_unknown_fields)]\npub enum ${name} {\n${variants}\n}`;
  }
  if (definition.type === "string" && definition.enum) {
    const variants = definition.enum.map((value) => `    #[serde(rename = ${JSON.stringify(value)})]\n    ${typeName(value)},`).join("\n");
    return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]\npub enum ${name} {\n${variants}\n}`;
  }
  if (definition.type !== "object") throw new Error(`unsupported generated Rust definition: ${key}`);
  const required = new Set(definition.required ?? []);
  const fields = Object.entries(definition.properties ?? {}).map(([field, property]) => {
    const optional = !required.has(field);
    const fieldName = rustFieldName(field);
    const annotations = [];
    if (fieldName !== field) annotations.push(`rename = ${JSON.stringify(field)}`);
    if (optional) annotations.push('skip_serializing_if = "Option::is_none"');
    if (!optional && isNullable(property)) annotations.push('deserialize_with = "deserialize_required_nullable"');
    const annotation = annotations.length ? `    #[serde(${annotations.join(", ")})]\n` : "";
    const valueType = rustType(property);
    return `${annotation}    pub ${fieldName}: ${optional && !valueType.startsWith("Option<") ? `Option<${valueType}>` : valueType},`;
  }).join("\n");
  return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(deny_unknown_fields)]\npub struct ${name} {\n${fields}\n}`;
}

function isNullable(node) {
  return (Array.isArray(node.type) && node.type.includes("null")) || Boolean(nullableUnionInner(node));
}

function renderTypeScriptDefinition(key, definition) {
  const name = definitionName(key);
  if (definition["x-codegen-tagged-union"]) {
    const variants = definition.oneOf.map((variant) => {
      const required = new Set(variant.required ?? []);
      const fields = Object.entries(variant.properties ?? {}).map(([field, property]) =>
        `${safeTypeScriptProperty(field)}${required.has(field) ? "" : "?"}: ${typeScriptType(property)}`,
      );
      return `{ ${fields.join("; ")} }`;
    });
    return `export type ${name} = ${variants.join(" | ")};`;
  }
  if (definition.type === "string" && definition.enum) {
    return `export type ${name} = ${definition.enum.map(JSON.stringify).join(" | ")};`;
  }
  if (definition.type !== "object") throw new Error(`unsupported generated TypeScript definition: ${key}`);
  if (definition.additionalProperties === false && Object.keys(definition.properties ?? {}).length === 0) {
    return `export type ${name} = Record<string, never>;`;
  }
  const required = new Set(definition.required ?? []);
  const fields = Object.entries(definition.properties ?? {}).map(([field, property]) =>
    `  ${safeTypeScriptProperty(field)}${required.has(field) ? "" : "?"}: ${typeScriptType(property)};`,
  ).join("\n");
  return `export interface ${name} {\n${fields}\n}`;
}

function rustType(node) {
  const nullableInner = nullableUnionInner(node);
  if (nullableInner) return `Option<${rustType(nullableInner)}>`;
  if (Array.isArray(node.type)) {
    const nullable = node.type.includes("null");
    const values = node.type.filter((value) => value !== "null");
    if (values.length !== 1) throw new Error(`unsupported Rust union: ${JSON.stringify(node.type)}`);
    const inner = rustType({ ...node, type: values[0] });
    return nullable ? `Option<${inner}>` : inner;
  }
  if (node["x-rust-type"]) return node["x-rust-type"];
  if (node.$ref) {
    const key = referenceKey(node.$ref);
    return key === "method" ? "String" : definitionName(key);
  }
  if (Object.hasOwn(node, "const")) {
    if (typeof node.const === "boolean") return "bool";
    if (typeof node.const === "number") return Number.isInteger(node.const) ? "i64" : "f64";
    return "String";
  }
  if (node.type === "string") return "String";
  if (node.type === "integer") return node["x-rust-type"] ?? "u64";
  if (node.type === "number") return "f64";
  if (node.type === "boolean") return "bool";
  if (node.type === "array") return `Vec<${rustType(node.items)}>`;
  return "serde_json::Value";
}

function typeScriptType(node) {
  const nullableInner = nullableUnionInner(node);
  if (nullableInner) return `${typeScriptType(nullableInner)} | null`;
  if (node["x-typescript-type"]) return node["x-typescript-type"];
  if (node["x-contract-identity"]) return JSON.stringify(identity);
  if (node["x-access-protocol-identity"]) return JSON.stringify(accessIdentity);
  if (node.$ref) return definitionName(referenceKey(node.$ref));
  if (Array.isArray(node.type)) {
    return node.type.map((value) => value === "null" ? "null" : typeScriptType({ ...node, type: value })).join(" | ");
  }
  if (Object.hasOwn(node, "const")) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map(JSON.stringify).join(" | ");
  if (node.type === "string") return "string";
  if (node.type === "integer" || node.type === "number") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "array") {
    const inner = typeScriptType(node.items);
    return `${inner.includes(" | ") ? `(${inner})` : inner}[]`;
  }
  if (node.type === "object") return "Record<string, unknown>";
  return "unknown";
}

function nullableUnionInner(node) {
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2) return undefined;
  const nonNull = node.anyOf.filter((value) => value.type !== "null");
  const nulls = node.anyOf.filter((value) => value.type === "null");
  return nonNull.length === 1 && nulls.length === 1 ? nonNull[0] : undefined;
}

function rustConstraint(node, value) {
  if (node.$ref) return `validate_${rustFieldName(referenceKey(node.$ref))}(${value})`;
  return rustConstraintInline(node, value);
}

function rustConstraintInline(node, value) {
  if (Array.isArray(node.allOf)) {
    const base = { ...node };
    delete base.allOf;
    return `(${rustConstraintInline(base, value)} && ${node.allOf.map((variant) => rustConstraint(variant, value)).join(" && ")})`;
  }
  if (node.if) {
    const condition = rustConstraint(node.if, value);
    const whenTrue = node.then ? rustConstraint(node.then, value) : "true";
    if (!node.else) return `(!(${condition}) || (${whenTrue}))`;
    const whenFalse = rustConstraint(node.else, value);
    return `((!(${condition}) || (${whenTrue})) && ((${condition}) || (${whenFalse})))`;
  }
  if (Array.isArray(node.anyOf)) {
    return `(${node.anyOf.map((variant) => rustConstraint(variant, value)).join(" || ")})`;
  }
  if (Array.isArray(node.oneOf)) {
    return `(${node.oneOf.map((variant) => rustConstraint(variant, value)).join(" || ")})`;
  }
  if (node["x-contract-identity"]) {
    return `${value} == &serde_json::json!(CONTRACT_IDENTITY)`;
  }
  if (node["x-access-protocol-identity"]) {
    return `${value} == &serde_json::json!(ACCESS_PROTOCOL_IDENTITY)`;
  }
  if (Object.hasOwn(node, "const")) {
    return `${value} == &serde_json::json!(${JSON.stringify(node.const)})`;
  }
  if (Array.isArray(node.type)) {
    return `(${node.type.map((type) => rustConstraint({ ...node, type }, value)).join(" || ")})`;
  }
  if (node.type === "null") return `${value}.is_null()`;
  if (node.type === "boolean") return `${value}.is_boolean()`;
  if (node.type === "integer") {
    const checks = [`number.as_i64().is_some() || number.as_u64().is_some()`];
    if (node.minimum !== undefined) {
      checks.push(node.minimum >= 0
        ? `number.as_u64().is_some_and(|number| number >= ${BigInt(node.minimum)}_u64)`
        : `number.as_i64().is_some_and(|number| number >= ${BigInt(node.minimum)}_i64)`);
    }
    if (node.maximum !== undefined) {
      checks.push(node.maximum >= 0
        ? `number.as_u64().is_some_and(|number| number <= ${BigInt(node.maximum)}_u64)`
        : `number.as_i64().is_some_and(|number| number <= ${BigInt(node.maximum)}_i64)`);
    }
    return `${value}.as_number().is_some_and(|number| ${checks.map((check) => `(${check})`).join(" && ")})`;
  }
  if (node.type === "number") return `${value}.is_number()`;
  if (node.type === "string" || node.pattern !== undefined) {
    const checks = [];
    if (node.minLength !== undefined) checks.push(`text.chars().count() >= ${node.minLength}`);
    if (node.maxLength !== undefined) checks.push(`text.chars().count() <= ${node.maxLength}`);
    if (node["x-utf8-max-bytes"] !== undefined) checks.push(`text.len() <= ${node["x-utf8-max-bytes"]}`);
    if (node.enum) checks.push(`[${node.enum.map((entry) => JSON.stringify(entry)).join(", ")}].contains(&text)`);
    if (node.pattern) checks.push(`contract_pattern_matches(${JSON.stringify(node.pattern)}, text)`);
    return `${value}.as_str().is_some_and(|text| ${checks.length ? checks.join(" && ") : "true"})`;
  }
  if (node.type === "array") {
    const checks = [];
    if (node.minItems !== undefined) checks.push(`items.len() >= ${node.minItems}`);
    if (node.maxItems !== undefined) checks.push(`items.len() <= ${node.maxItems}`);
    if (node.uniqueItems) checks.push("json_array_unique(items)");
    if (node.items) checks.push(`items.iter().all(|item| ${rustConstraint(node.items, "item")})`);
    return `${value}.as_array().is_some_and(|items| ${checks.length ? checks.join(" && ") : "true"})`;
  }
  if (node.type === "object" || node.properties || node.required || node.additionalProperties !== undefined) {
    const required = new Set(node.required ?? []);
    const properties = Object.entries(node.properties ?? {});
    const checks = properties.map(([field, property]) => {
      const constraint = rustConstraint(property, "field");
      return required.has(field)
        ? `object.get(${JSON.stringify(field)}).is_some_and(|field| ${constraint})`
        : `object.get(${JSON.stringify(field)}).is_none_or(|field| ${constraint})`;
    });
    if (node.additionalProperties === false) {
      const names = properties.map(([field]) => JSON.stringify(field));
      checks.push(names.length
        ? `object.keys().all(|key| [${names.join(", ")}].contains(&key.as_str()))`
        : "object.is_empty()");
    }
    return `${value}.as_object().is_some_and(|object| ${checks.length ? checks.join(" && ") : "true"})`;
  }
  return "true";
}

function typeScriptConstraint(node, value) {
  if (node.$ref) return typeScriptConstraint(definitions[referenceKey(node.$ref)], value);
  if (Array.isArray(node.allOf)) {
    const base = { ...node };
    delete base.allOf;
    return `(${typeScriptConstraint(base, value)} && ${node.allOf.map((variant) => typeScriptConstraint(variant, value)).join(" && ")})`;
  }
  if (node.if) {
    const condition = typeScriptConstraint(node.if, value);
    const whenTrue = node.then ? typeScriptConstraint(node.then, value) : "true";
    if (!node.else) return `(!(${condition}) || (${whenTrue}))`;
    const whenFalse = typeScriptConstraint(node.else, value);
    return `((!(${condition}) || (${whenTrue})) && ((${condition}) || (${whenFalse})))`;
  }
  if (Array.isArray(node.anyOf)) {
    return `(${node.anyOf.map((variant) => typeScriptConstraint(variant, value)).join(" || ")})`;
  }
  if (Array.isArray(node.oneOf)) {
    return `(${node.oneOf.map((variant) => typeScriptConstraint(variant, value)).join(" || ")})`;
  }
  if (node["x-contract-identity"]) return `${value} === CONTRACT_IDENTITY`;
  if (node["x-access-protocol-identity"]) return `${value} === ACCESS_PROTOCOL_IDENTITY`;
  if (Object.hasOwn(node, "const")) return `${value} === ${JSON.stringify(node.const)}`;
  if (Array.isArray(node.type)) {
    return `(${node.type.map((type) => typeScriptConstraint({ ...node, type }, value)).join(" || ")})`;
  }
  if (node.type === "null") return `${value} === null`;
  if (node.type === "boolean") return `typeof ${value} === "boolean"`;
  if (node.type === "integer") {
    const checks = [`typeof ${value} === "number"`, `Number.isInteger(${value})`];
    if (node.minimum !== undefined) checks.push(`${value} >= ${node.minimum}`);
    if (node.maximum !== undefined) checks.push(`${value} <= ${node.maximum}`);
    return `(${checks.join(" && ")})`;
  }
  if (node.type === "number") return `typeof ${value} === "number" && Number.isFinite(${value})`;
  if (node.type === "string" || node.pattern !== undefined) {
    const checks = [`typeof ${value} === "string"`];
    if (node.minLength !== undefined) checks.push(`[...${value}].length >= ${node.minLength}`);
    if (node.maxLength !== undefined) checks.push(`[...${value}].length <= ${node.maxLength}`);
    if (node["x-utf8-max-bytes"] !== undefined) checks.push(`new TextEncoder().encode(${value}).byteLength <= ${node["x-utf8-max-bytes"]}`);
    if (node.enum) checks.push(`${JSON.stringify(node.enum)}.includes(${value})`);
    if (node.pattern) checks.push(`CONTRACT_PATTERNS.get(${JSON.stringify(node.pattern)})?.test(${value}) === true`);
    return `(${checks.join(" && ")})`;
  }
  if (node.type === "array") {
    const checks = [`Array.isArray(${value})`];
    if (node.minItems !== undefined) checks.push(`${value}.length >= ${node.minItems}`);
    if (node.maxItems !== undefined) checks.push(`${value}.length <= ${node.maxItems}`);
    if (node.uniqueItems) checks.push(`jsonArrayUnique(${value})`);
    if (node.items) checks.push(`${value}.every((item) => ${typeScriptConstraint(node.items, "item")})`);
    return `(${checks.join(" && ")})`;
  }
  if (node.type === "object" || node.properties || node.required || node.additionalProperties !== undefined) {
    const required = new Set(node.required ?? []);
    const properties = Object.entries(node.properties ?? {});
    const checks = [`isJsonObject(${value})`];
    for (const [field, property] of properties) {
      const fieldValue = `${value}[${JSON.stringify(field)}]`;
      const constraint = typeScriptConstraint(property, fieldValue);
      checks.push(required.has(field)
        ? `(Object.hasOwn(${value}, ${JSON.stringify(field)}) && ${constraint})`
        : `(!Object.hasOwn(${value}, ${JSON.stringify(field)}) || ${constraint})`);
    }
    if (node.additionalProperties === false) {
      const names = JSON.stringify(properties.map(([field]) => field));
      checks.push(`Object.keys(${value}).every((key) => ${names}.includes(key))`);
    }
    return `(${checks.join(" && ")})`;
  }
  return "true";
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

function dereferenceLocalSchema(node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((value) => dereferenceLocalSchema(value, seen));
  if (!node || typeof node !== "object") return node;
  if (node.$ref) {
    const key = referenceKey(node.$ref);
    if (seen.has(key)) throw new Error(`recursive MCP input schema ref is unsupported: ${key}`);
    return dereferenceLocalSchema(definitions[key], new Set([...seen, key]));
  }
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !key.startsWith("x-codegen"))
      .map(([key, value]) => [key, dereferenceLocalSchema(value, seen)]),
  );
}

function definitionName(key) {
  const definition = definitions[key];
  if (!definition) throw new Error(`unknown schema definition: ${key}`);
  return definition["x-codegen-name"] ?? typeName(key);
}

function referenceKey(reference) {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) throw new Error(`external refs are unsupported: ${reference}`);
  return reference.slice(prefix.length);
}

function typeName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function rustFieldName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toLowerCase();
}

function safeTypeScriptProperty(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function formatRust(source) {
  const result = spawnSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], {
    input: source,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`rustfmt failed while generating the Rust contract: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
