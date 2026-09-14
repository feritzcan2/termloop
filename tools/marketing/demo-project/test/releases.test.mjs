import { test } from "node:test";
import assert from "node:assert/strict";
import { progress, releases } from "../src/releases.mjs";

test("empty checklist starts at zero", () => assert.equal(progress(0, 0), 0));
test("completed work is bounded", () => assert.equal(progress(9, 5), 100));
test("partial progress is rounded", () => assert.equal(progress(2, 3), 67));
test("negative progress stays at zero", () => assert.equal(progress(-1, 5), 0));
test("sample releases have owners", () => assert.ok(releases.every(r => r.owner)));
