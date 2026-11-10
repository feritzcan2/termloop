import assert from "node:assert/strict";
import test from "node:test";
import { compareContracts, evaluateCompatibility } from "./contract-compat.mjs";
import { contractIdentity, contractRevision } from "./contract-identity.mjs";

function schema(mutate) {
  const base = {
    $id: "https://termloop.dev/schema/control.current.schema.json",
    "x-contract-major": 1,
    "x-capability-scopes": { "control.readOnly": ["item.get"] },
    "x-methods": { "item.get": { params: { $ref: "#/$defs/itemGetParams" }, result: { $ref: "#/$defs/itemDto" } } },
    "x-events": { "item.changed": { payload: { $ref: "#/$defs/itemDto" } } },
    $defs: {
      method: { type: "string", enum: ["item.get"] },
      eventName: { type: "string", enum: ["item.changed"] },
      itemGetParams: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", pattern: "^i-" } } },
      itemState: { type: "string", enum: ["open", "closed"] },
      itemDto: {
        type: "object",
        additionalProperties: false,
        required: ["id", "state", "note"],
        properties: {
          id: { type: "string", maxLength: 10, description: "Item id." },
          state: { $ref: "#/$defs/itemState" },
          note: { type: ["string", "null"] },
        },
      },
    },
  };
  mutate?.(base);
  return base;
}

const mutate = schema;
const messages = (result) => result.breaking.map((change) => `${change.path}: ${change.message}`);

test("identical schemas are compatible", () => {
  const result = evaluateCompatibility(schema(), schema());
  assert.equal(result.ok, true);
  assert.deepEqual(result.breaking, []);
});

test("documentation and bound changes are not breaking", () => {
  const result = evaluateCompatibility(schema(), mutate((s) => {
    s.$defs.itemDto.properties.id.description = "Changed copy.";
    s.$defs.itemDto.properties.id.maxLength = 64;
    s.$defs.itemDto["x-codegen-name"] = "Renamed";
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.breaking, []);
});

test("new methods, events, enum values, and optional fields are additive", () => {
  const result = evaluateCompatibility(schema(), mutate((s) => {
    s.$defs.method.enum.push("item.delete");
    s["x-methods"]["item.delete"] = s["x-methods"]["item.get"];
    s.$defs.eventName.enum.push("item.deleted");
    s.$defs.itemState.enum.push("archived");
    s.$defs.itemDto.properties.color = { type: "string" };
    s.$defs.itemGetParams.properties.verbose = { type: "boolean" };
  }));
  assert.equal(result.ok, true);
  assert.equal(result.additive.length, 5);
});

test("a new required field breaks peers that predate it", () => {
  const result = evaluateCompatibility(schema(), mutate((s) => {
    s.$defs.itemDto.properties.color = { type: "string" };
    s.$defs.itemDto.required.push("color");
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(messages(result), ["$defs.itemDto.color: new required property (add it as optional instead)"]);
});

test("removals, type changes, requiredness changes, and pattern changes are breaking", () => {
  const result = compareContracts(schema(), mutate((s) => {
    delete s.$defs.itemDto.properties.note;
    s.$defs.itemDto.required = ["id", "state"];
    s.$defs.itemDto.properties.id.type = "integer";
    s.$defs.itemState.enum = ["open"];
    s.$defs.itemGetParams.properties.id.pattern = "^item-";
    s.$defs.method.enum = [];
    s["x-capability-scopes"]["control.readOnly"] = [];
  }));
  assert.deepEqual(messages(result).sort(), [
    "$defs.itemDto.id: type string → integer",
    "$defs.itemDto.note: property removed",
    "$defs.itemGetParams.id: pattern changed",
    "$defs.itemState: enum value \"closed\" removed",
    "methods: \"item.get\" removed",
    "scope control.readOnly: \"item.get\" removed",
  ]);
});

test("nullability change is breaking", () => {
  const result = compareContracts(schema(), mutate((s) => { s.$defs.itemDto.properties.note.type = "string"; }));
  assert.deepEqual(messages(result), ["$defs.itemDto.note: type null|string → string"]);
});

test("inlining a definition with the same shape is compatible", () => {
  const result = compareContracts(schema(), mutate((s) => {
    s.$defs.itemDto.properties.state = { type: "string", enum: ["open", "closed"] };
  }));
  assert.deepEqual(result.breaking, []);
});

test("a major bump accepts breaking changes and a decrease is rejected", () => {
  const breakingHead = mutate((s) => { s["x-contract-major"] = 2; s.$defs.method.enum = []; });
  assert.equal(evaluateCompatibility(schema(), breakingHead).ok, true);
  assert.equal(evaluateCompatibility(breakingHead, schema()).ok, false);
});

test("a schema without a major counts as major 0", () => {
  const legacy = mutate((s) => { delete s["x-contract-major"]; });
  const result = evaluateCompatibility(legacy, schema());
  assert.equal(result.ok, true);
  assert.equal(result.baseMajor, 0);
});

test("identity is stable across additive edits and changes with the major", () => {
  const edited = mutate((s) => { s.$defs.itemDto.properties.color = { type: "string" }; });
  assert.equal(contractIdentity(edited), contractIdentity(schema()));
  assert.notEqual(contractRevision(edited), contractRevision(schema()));
  assert.notEqual(contractIdentity(mutate((s) => { s["x-contract-major"] = 2; })), contractIdentity(schema()));
  assert.match(contractIdentity(schema()), /^sha256:[a-f0-9]{64}$/);
});

test("a schema without a major keeps the exact digest identity", () => {
  const access = { $id: "access", type: "object" };
  assert.equal(contractIdentity(access), contractRevision(access));
  assert.throws(() => contractIdentity({ "x-contract-major": 0 }));
});
