import { spawnSync } from "node:child_process";
import { definitionName, nullableUnionInner, referenceKey, rustFieldName, typeName } from "./model.mjs";

// Rust emission for one contract model: DTO definitions, type mapping,
// generated constraint validators, and the shared crate preamble.
export function rustEmitter(model) {
  const name = (key) => definitionName(model, key);

  function renderDefinition(key, definition) {
    const definitionTypeName = name(key);
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
      return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(tag = ${JSON.stringify(tag)}, deny_unknown_fields)]\npub enum ${definitionTypeName} {\n${variants}\n}`;
    }
    if (definition.type === "string" && definition.enum) {
      const variants = definition.enum.map((value) => `    #[serde(rename = ${JSON.stringify(value)})]\n    ${typeName(value)},`).join("\n");
      return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]\npub enum ${definitionTypeName} {\n${variants}\n}`;
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
    return `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]\n#[serde(deny_unknown_fields)]\npub struct ${definitionTypeName} {\n${fields}\n}`;
  }

  function isNullable(node) {
    return (Array.isArray(node.type) && node.type.includes("null")) || Boolean(nullableUnionInner(node));
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
      return key === "method" ? "String" : name(key);
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

  function constraint(node, value) {
    if (node.$ref) return `validate_${rustFieldName(referenceKey(node.$ref))}(${value})`;
    return constraintInline(node, value);
  }

  function constraintInline(node, value) {
    if (Array.isArray(node.allOf)) {
      const base = { ...node };
      delete base.allOf;
      return `(${constraintInline(base, value)} && ${node.allOf.map((variant) => constraint(variant, value)).join(" && ")})`;
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
      return `(${node.type.map((type) => constraint({ ...node, type }, value)).join(" || ")})`;
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
      if (node.items) checks.push(`items.iter().all(|item| ${constraint(node.items, "item")})`);
      return `${value}.as_array().is_some_and(|items| ${checks.length ? checks.join(" && ") : "true"})`;
    }
    if (node.type === "object" || node.properties || node.required || node.additionalProperties !== undefined) {
      const required = new Set(node.required ?? []);
      const properties = Object.entries(node.properties ?? {});
      const checks = properties.map(([field, property]) => {
        const fieldConstraint = constraint(property, "field");
        return required.has(field)
          ? `object.get(${JSON.stringify(field)}).is_some_and(|field| ${fieldConstraint})`
          : `object.get(${JSON.stringify(field)}).is_none_or(|field| ${fieldConstraint})`;
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

  const { methods, methodShapes, events, eventShapes } = model;
  return {
    rustType,
    constraint,
    stringList: (items) => items.map((item) => `    ${JSON.stringify(item)},`).join("\n"),
    // Serde helpers and the compiled pattern table every generated crate needs.
    prelude: () => `use serde::{Deserialize, Deserializer, Serialize};
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

${model.contractPatterns.map((pattern, index) =>
  `static CONTRACT_PATTERN_${index}: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(${JSON.stringify(pattern)}).expect("generated contract pattern"));`,
).join("\n")}

fn contract_pattern_matches(pattern: &str, text: &str) -> bool {
    match pattern {
${model.contractPatterns.map((pattern, index) => `        ${JSON.stringify(pattern)} => CONTRACT_PATTERN_${index}.is_match(text),`).join("\n")}
        _ => false,
    }
}`,
    definitions: () => model.generatedDefinitions.map(([key, definition]) => renderDefinition(key, definition)).join("\n\n"),
    methodAliases: () => methods.flatMap((method) => {
      const stem = typeName(method);
      return [
        [`${stem}Params`, rustType(methodShapes[method].params)],
        [`${stem}Result`, rustType(methodShapes[method].result)],
      ]
        .filter(([alias, target]) => alias !== target)
        .map(([alias, target]) => `pub type ${alias} = ${target};`);
    }).join("\n"),
    constraintHelpers: () => Object.entries(model.definitions)
      .map(([key, definition]) => `#[allow(\n    dead_code,\n    unused_comparisons,\n    unused_parens,\n    unused_variables,\n    clippy::absurd_extreme_comparisons,\n    clippy::len_zero,\n    clippy::redundant_closure,\n)]\nfn validate_${rustFieldName(key)}(value: &Value) -> bool {\n    ${constraintInline(definition, "value")}\n}`)
      .join("\n\n"),
    // validate_method_params, validate_method_result, and validate_event_payload.
    methodAndEventValidators: () => `#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_method_params(method: &str, params: &Value) -> bool {
    match method {
${methods.map((method) => `        ${JSON.stringify(method)} => serde_json::from_value::<${typeName(method)}Params>(params.clone()).is_ok() && ${constraint(methodShapes[method].params, "params")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_method_result(method: &str, result: &Value) -> bool {
    match method {
${methods.map((method) => `        ${JSON.stringify(method)} => serde_json::from_value::<${typeName(method)}Result>(result.clone()).is_ok() && ${constraint(methodShapes[method].result, "result")},`).join("\n")}
        _ => false,
    }
}

#[allow(clippy::absurd_extreme_comparisons, clippy::len_zero, clippy::redundant_closure)]
pub fn validate_event_payload(event: &str, payload: &Value) -> bool {
    match event {
${events.map((event) => `        ${JSON.stringify(event)} => serde_json::from_value::<${typeName(event)}Payload>(payload.clone()).is_ok() && ${constraint(eventShapes[event].payload, "payload")},`).join("\n")}
        _ => false,
    }
}`,
  };
}

function rustfmtOnce(source) {
  const result = spawnSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], {
    input: source,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`rustfmt failed while generating the Rust contract: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// One rustfmt pass is not always a fixed point for long generated closure
// chains; format until stable so `cargo fmt --check` agrees with drift.
export function formatRust(source) {
  let formatted = source;
  for (let pass = 0; pass < 4; pass += 1) {
    const again = rustfmtOnce(formatted);
    if (again === formatted) return formatted;
    formatted = again;
  }
  throw new Error("rustfmt did not reach a stable format for the Rust contract");
}
