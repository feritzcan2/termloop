import { definitionName, nullableUnionInner, referenceKey, typeName } from "./model.mjs";

// TypeScript emission for one contract model: DTO types, method maps,
// runtime result validators, and the generated WebSocket control client.
export function typeScriptEmitter(model) {
  const name = (key) => definitionName(model, key);

  function renderDefinition(key, definition) {
    const definitionTypeName = name(key);
    if (definition["x-codegen-tagged-union"]) {
      const variants = definition.oneOf.map((variant) => {
        const required = new Set(variant.required ?? []);
        const fields = Object.entries(variant.properties ?? {}).map(([field, property]) =>
          `${safeProperty(field)}${required.has(field) ? "" : "?"}: ${typeScriptType(property)}`,
        );
        return `{ ${fields.join("; ")} }`;
      });
      return `export type ${definitionTypeName} = ${variants.join(" | ")};`;
    }
    if (definition.type === "string" && definition.enum) {
      return `export type ${definitionTypeName} = ${definition.enum.map(JSON.stringify).join(" | ")};`;
    }
    if (definition.type !== "object") throw new Error(`unsupported generated TypeScript definition: ${key}`);
    if (definition.additionalProperties === false && Object.keys(definition.properties ?? {}).length === 0) {
      return `export type ${definitionTypeName} = Record<string, never>;`;
    }
    const required = new Set(definition.required ?? []);
    const fields = Object.entries(definition.properties ?? {}).map(([field, property]) =>
      `  ${safeProperty(field)}${required.has(field) ? "" : "?"}: ${typeScriptType(property)};`,
    ).join("\n");
    return `export interface ${definitionTypeName} {\n${fields}\n}`;
  }

  function typeScriptType(node) {
    const nullableInner = nullableUnionInner(node);
    if (nullableInner) return `${typeScriptType(nullableInner)} | null`;
    if (node["x-typescript-type"]) return node["x-typescript-type"];
    if (node["x-contract-identity"]) return JSON.stringify(model.identity);
    if (node["x-access-protocol-identity"]) return JSON.stringify(requireAccessIdentity());
    if (node.$ref) return name(referenceKey(node.$ref));
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

  function requireAccessIdentity() {
    if (!model.accessIdentity) throw new Error("x-access-protocol-identity needs an access companion schema");
    return model.accessIdentity;
  }

  function constraint(node, value) {
    if (node.$ref) return constraint(model.definitions[referenceKey(node.$ref)], value);
    if (Array.isArray(node.allOf)) {
      const base = { ...node };
      delete base.allOf;
      return `(${constraint(base, value)} && ${node.allOf.map((variant) => constraint(variant, value)).join(" && ")})`;
    }
    if (node.if) {
      const condition = constraint(node.if, value);
      const whenTrue = node.then ? constraint(node.then, value) : "true";
      if (!node.else) return `(!(${condition}) || (${whenTrue}))`;
      const whenFalse = constraint(node.else, value);
      return `((!(${condition}) || (${whenTrue})) && ((${condition}) || (${whenFalse})))`;
    }
    if (Array.isArray(node.anyOf)) {
      return `(${node.anyOf.map((variant) => constraint(variant, value)).join(" || ")})`;
    }
    if (Array.isArray(node.oneOf)) {
      return `(${node.oneOf.map((variant) => constraint(variant, value)).join(" || ")})`;
    }
    if (node["x-contract-identity"]) return `${value} === CONTRACT_IDENTITY`;
    if (node["x-access-protocol-identity"]) return `${value} === ACCESS_PROTOCOL_IDENTITY`;
    if (Object.hasOwn(node, "const")) return `${value} === ${JSON.stringify(node.const)}`;
    if (Array.isArray(node.type)) {
      return `(${node.type.map((type) => constraint({ ...node, type }, value)).join(" || ")})`;
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
      if (node.items) checks.push(`${value}.every((item) => ${constraint(node.items, "item")})`);
      return `(${checks.join(" && ")})`;
    }
    if (node.type === "object" || node.properties || node.required || node.additionalProperties !== undefined) {
      const required = new Set(node.required ?? []);
      const properties = Object.entries(node.properties ?? {});
      const checks = [`isJsonObject(${value})`];
      for (const [field, property] of properties) {
        const fieldValue = `${value}[${JSON.stringify(field)}]`;
        const fieldConstraint = constraint(property, fieldValue);
        checks.push(required.has(field)
          ? `(Object.hasOwn(${value}, ${JSON.stringify(field)}) && ${fieldConstraint})`
          : `(!Object.hasOwn(${value}, ${JSON.stringify(field)}) || ${fieldConstraint})`);
      }
      if (node.additionalProperties === false) {
        const names = JSON.stringify(properties.map(([field]) => field));
        checks.push(`Object.keys(${value}).every((key) => ${names}.includes(key))`);
      }
      return `(${checks.join(" && ")})`;
    }
    return "true";
  }

  const { methods, methodShapes, events, eventShapes } = model;
  return {
    constraint,
    definitions: () => model.generatedDefinitions.map(([key, definition]) => renderDefinition(key, definition)).join("\n\n"),
    methodAliases: () => methods.flatMap((method) => {
      const stem = typeName(method);
      return [
        [`${stem}Params`, typeScriptType(methodShapes[method].params)],
        [`${stem}Result`, typeScriptType(methodShapes[method].result)],
      ]
        .filter(([alias, target]) => alias !== target)
        .map(([alias, target]) => `export type ${alias} = ${target};`);
    }).join("\n"),
    // MethodParams/MethodResults and the call-argument helper types.
    methodMaps: () => `export interface MethodParams {
${methods.map((method) => `  ${JSON.stringify(method)}: ${typeName(method)}Params;`).join("\n")}
}
export interface MethodResults {
${methods.map((method) => `  ${JSON.stringify(method)}: ${typeName(method)}Result;`).join("\n")}
}
export type ParamsFor<M extends Method> = MethodParams[M];
export type ResultFor<M extends Method> = MethodResults[M];
export type MethodsWithEmptyParams = ${model.emptyParamMethods.map(JSON.stringify).join(" | ")};
export type CallArgs<M extends Method> = M extends MethodsWithEmptyParams
  ? [params?: ParamsFor<M>]
  : [params: ParamsFor<M>];`,
    // JSON helpers, the pattern table, and the method-result and event validators.
    validators: () => `function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonArrayUnique(values: unknown[]): boolean {
  return values.every((value, index) =>
    !values.slice(index + 1).some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  );
}

const CONTRACT_PATTERNS = new Map<string, RegExp>([
${model.contractPatterns.map((pattern) => `  [${JSON.stringify(pattern)}, new RegExp(${JSON.stringify(pattern)}, "u")],`).join("\n")}
]);

export function validateMethodResult(method: string, result: unknown): boolean {
  switch (method) {
${methods.map((method) => `    case ${JSON.stringify(method)}: return ${constraint(methodShapes[method].result, "result")};`).join("\n")}
    default: return false;
  }
}

export function validateEventPayload(event: string, payload: unknown): boolean {
  switch (event) {
${events.map((event) => `    case ${JSON.stringify(event)}: return ${constraint(eventShapes[event].payload, "payload")};`).join("\n")}
    default: return false;
  }
}`,
    client: typeScriptClient,
  };
}

// The multiplexed request/response client over one WebSocket. The schema must
// define ControlRequest, ControlResponse, ErrorCode, ProtocolErrorDetails, and
// the cancel method; `timeoutFunction` names the target's per-method timeout.
function typeScriptClient({ clientName, errorName, timeoutFunction, cancelMethod, conveniences }) {
  return `export interface SocketLike { addEventListener(type: "open" | "message" | "error" | "close", listener: (event: any) => void, options?: { once?: boolean }): void; send(data: string): void; close(): void; }
export type SocketFactory = (url: string) => SocketLike;
export class ${errorName} extends Error {
  constructor(message: string, readonly code: ErrorCode | undefined, readonly details: ProtocolErrorDetails | undefined) {
    super(message);
    this.name = ${JSON.stringify(errorName)};
  }
}
type PendingControlCall = {
  readonly method: Method;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
type ConnectingControlSocket = {
  readonly socket: SocketLike;
  readonly promise: Promise<SocketLike>;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
const MAX_CONTROL_IN_FLIGHT = 64;
const CONTROL_CONNECTION_TIMEOUT_MS = 12_000;
export class ${clientName} {
  #counter = 0;
  #generation = 0;
  #socket: SocketLike | undefined;
  #connecting: ConnectingControlSocket | undefined;
  #pending = new Map<string, PendingControlCall>();
  constructor(readonly url: string, readonly token: string, readonly socketFactory: SocketFactory) {}
  async call<M extends Method>(method: M, ...args: CallArgs<M>): Promise<ResultFor<M>> {
    if (this.#pending.size >= MAX_CONTROL_IN_FLIGHT) {
      throw new ${errorName}("too many control requests are already in flight", "serviceBusy", undefined);
    }
    const id = String(++this.#counter);
    const params = (args[0] ?? {}) as ParamsFor<M>;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error("request timeout"));
        if (this.#connecting) this.#disconnect(this.#generation, new Error("connection timeout"));
        else this.#cancelTimedOutRequest(id, method);
      }, ${timeoutFunction}(method));
      this.#pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      void Promise.resolve().then(() => this.#pending.has(id) ? this.#connected() : undefined).then((socket) => {
        if (!socket || !this.#pending.has(id)) return;
        try {
          socket.send(JSON.stringify({ id, protocolVersion: CONTRACT_IDENTITY, token: this.token, method, params } satisfies ControlRequest));
        } catch {
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
    this.#disconnect(this.#generation, new Error("connection closed"));
  }
  #connected(): Promise<SocketLike> {
    if (this.#socket) return Promise.resolve(this.#socket);
    if (this.#connecting) return this.#connecting.promise;
    const generation = ++this.#generation;
    const socket = this.socketFactory(this.url);
    let resolveConnection!: (socket: SocketLike) => void;
    let rejectConnection!: (error: Error) => void;
    const promise = new Promise<SocketLike>((resolve, reject) => {
      resolveConnection = resolve;
      rejectConnection = reject;
    });
    const timeout = setTimeout(() => {
      this.#disconnect(generation, new Error("connection timeout"));
    }, CONTROL_CONNECTION_TIMEOUT_MS);
    this.#connecting = { socket, promise, reject: rejectConnection, timeout };
    socket.addEventListener("open", () => {
      if (generation !== this.#generation) {
        socket.close();
        return;
      }
      clearTimeout(timeout);
      this.#socket = socket;
      this.#connecting = undefined;
      resolveConnection(socket);
    }, { once: true });
    socket.addEventListener("message", (event) => this.#receive(generation, event));
    socket.addEventListener("error", () => {
      this.#disconnect(generation, new Error("connection failed"));
    }, { once: true });
    socket.addEventListener("close", () => {
      this.#disconnect(generation, new Error("connection closed"));
    }, { once: true });
    return promise;
  }
  #receive(generation: number, event: any): void {
    if (generation !== this.#generation) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      this.#disconnect(generation, new Error("invalid control response"));
      return;
    }
    if (!isJsonObject(decoded)) {
      this.#disconnect(generation, new Error("invalid control response"));
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
    if (!response.ok) pending.reject(new ${errorName}(response.error?.message ?? "request failed", response.error?.code, response.error?.details));
    else if (!validateMethodResult(pending.method, response.result)) pending.reject(new Error("invalid response"));
    else pending.resolve(response.result);
  }
  #cancelTimedOutRequest(requestId: string, method: Method): void {
    if (method === ${JSON.stringify(cancelMethod)} || !this.#socket) return;
    try {
      this.#socket.send(JSON.stringify({
        id: "cancel-" + String(++this.#counter),
        protocolVersion: CONTRACT_IDENTITY,
        token: this.token,
        method: ${JSON.stringify(cancelMethod)},
        params: { requestId },
      } satisfies ControlRequest));
    } catch {
      this.#disconnect(this.#generation, new Error("connection failed"));
    }
  }
  #disconnect(generation: number, error: Error): void {
    if (generation !== this.#generation) return;
    const connecting = this.#connecting;
    const socket = this.#socket ?? connecting?.socket;
    this.#generation += 1;
    this.#socket = undefined;
    this.#connecting = undefined;
    if (connecting) {
      clearTimeout(connecting.timeout);
      connecting.reject(error);
    }
    this.#rejectPending(error);
    socket?.close();
  }
  #rejectPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
${conveniences.map(([method, call]) => `  ${method}() { return this.call(${JSON.stringify(call)}); }`).join("\n")}
}
`;
}

function safeProperty(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}
