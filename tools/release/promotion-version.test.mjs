import assert from "node:assert/strict";
import test from "node:test";
import { promotionVersion } from "./promotion-version.mjs";

test("promotion reserves a new patch above main and existing stable tags", () => {
  assert.equal(promotionVersion("2.0.3", "2.0.3", []), "2.0.4");
  assert.equal(promotionVersion("2.0.3", "2.0.3", ["v2.0.3", "v2.0.4"]), "2.0.5");
  assert.equal(promotionVersion("2.0.4", "2.0.3", ["v2.0.4"]), "2.0.5");
  assert.equal(promotionVersion("2.0.3", "2.0.9", []), "2.0.10");
});

test("retries and manually prepared versions retain their unpublished version", () => {
  assert.equal(promotionVersion("2.0.4", "2.0.3", ["v2.0.3"]), "2.0.4");
  assert.equal(promotionVersion("2.1.0", "2.0.3", ["v2.0.3"]), "2.1.0");
  assert.equal(promotionVersion("2.0.4", "2.0.4", ["v2.0.3"]), "2.0.5");
});

test("unrelated tags and prereleases do not reserve stable versions", () => {
  assert.equal(promotionVersion("2.0.3", "2.0.3", ["v3.0.0-rc.1", "mobile-9.0.0", "v01.0.0"]), "2.0.4");
});

test("invalid or overflowing release versions fail before changing files", () => {
  assert.throws(() => promotionVersion("2.0.3-beta", "2.0.3", []));
  assert.throws(() => promotionVersion("2.0.3", "not-a-version", []));
  assert.throws(() => promotionVersion("2.0.3", "2.0.9007199254740991", []));
});
