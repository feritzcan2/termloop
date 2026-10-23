import { beforeEach, expect, it } from "vitest";

import {
  clearComposerMemoryForTests,
  composerMemoryKey,
  rememberDraft,
  rememberedDraft,
  rememberedInputMode,
  rememberInputMode,
} from "../src/features/terminal/composer-memory";

beforeEach(clearComposerMemoryForTests);

it("defaults shells to live typing and agents to a composed turn", () => {
  const key = composerMemoryKey("mac", "s1", 1);
  expect(rememberedInputMode(key, false)).toBe("live");
  expect(rememberedInputMode(key, true)).toBe("compose");
});

it("keeps the user's mode choice over the default", () => {
  const key = composerMemoryKey("mac", "s1", 1);
  rememberInputMode(key, "compose");
  expect(rememberedInputMode(key, false)).toBe("compose");
});

it("scopes a draft to one Session runtime", () => {
  rememberDraft(composerMemoryKey("mac", "s1", 1), "half a thought");
  expect(rememberedDraft(composerMemoryKey("mac", "s1", 1))).toBe("half a thought");
  expect(rememberedDraft(composerMemoryKey("mac", "s1", 2))).toBe("");
  expect(rememberedDraft(composerMemoryKey("mac", "s2", 1))).toBe("");
});

it("forgets an emptied draft and stays bounded", () => {
  const key = composerMemoryKey("mac", "s1", 1);
  rememberDraft(key, "x");
  rememberDraft(key, "");
  expect(rememberedDraft(key)).toBe("");
  for (let index = 0; index < 40; index += 1) rememberDraft(composerMemoryKey("mac", `n${index}`, 1), `d${index}`);
  expect(rememberedDraft(composerMemoryKey("mac", "n0", 1))).toBe("");
  expect(rememberedDraft(composerMemoryKey("mac", "n39", 1))).toBe("d39");
});
