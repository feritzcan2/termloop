import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalJson, contractIdentity, contractRevision } from "../../../../tools/codegen/contract-identity.mjs";

test("contract identity is canonical and semantic", () => {
  const left = { type: "object", properties: { name: { type: "string" } } };
  const reordered = { properties: { name: { type: "string" } }, type: "object" };
  const changed = { properties: { name: { type: "string", maxLength: 80 } }, type: "object" };

  assert.equal(canonicalJson(left), canonicalJson(reordered));
  assert.equal(contractIdentity(left), contractIdentity(reordered));
  assert.notEqual(contractIdentity(left), contractIdentity(changed));
  assert.match(contractIdentity(left), /^sha256:[0-9a-f]{64}$/);
});

test("the control identity follows the major while the revision tracks every edit", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schema/control.current.schema.json", import.meta.url), "utf8"));
  const reordered = Object.fromEntries(Object.entries(schema).reverse());
  const changed = structuredClone(schema);
  changed.$defs.projectCreateParams.properties.name.maxLength += 1;
  const nextMajor = structuredClone(schema);
  nextMajor["x-contract-major"] += 1;

  assert.equal(contractIdentity(schema), contractIdentity(reordered));
  assert.equal(contractIdentity(schema), contractIdentity(changed));
  assert.notEqual(contractRevision(schema), contractRevision(changed));
  assert.notEqual(contractIdentity(schema), contractIdentity(nextMajor));
});
