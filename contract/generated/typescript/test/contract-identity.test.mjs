import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, contractIdentity } from "../../../../tools/codegen/contract-identity.mjs";

test("contract identity is canonical and semantic", () => {
  const left = { type: "object", properties: { name: { type: "string" } } };
  const reordered = { properties: { name: { type: "string" } }, type: "object" };
  const changed = { properties: { name: { type: "string", maxLength: 80 } }, type: "object" };

  assert.equal(canonicalJson(left), canonicalJson(reordered));
  assert.equal(contractIdentity(left), contractIdentity(reordered));
  assert.notEqual(contractIdentity(left), contractIdentity(changed));
  assert.match(contractIdentity(left), /^sha256:[0-9a-f]{64}$/);
});

test("a semantic change to the canonical schema changes identity", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schema/control.current.schema.json", import.meta.url), "utf8"));
  const reordered = Object.fromEntries(Object.entries(schema).reverse());
  const changed = structuredClone(schema);
  changed.$defs.projectCreateParams.properties.name.maxLength += 1;

  assert.equal(contractIdentity(schema), contractIdentity(reordered));
  assert.notEqual(contractIdentity(schema), contractIdentity(changed));
});
