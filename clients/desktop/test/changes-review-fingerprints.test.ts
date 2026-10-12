import { describe, expect, it } from "vitest";
import type { TaskWorktreeDiffResult } from "@termloop/contract/current";
import { changesReviewFingerprint, visitReviewEntries } from "../src/renderer/changes-review-fingerprints.js";

const diff: TaskWorktreeDiffResult = {
  task_id: "task", observation_id: "obs-1", entry_id: "entry-1", state: "patch", patch: "before\n+after\n",
};

describe("review content evidence", () => {
  it("hashes content without depending on observation or entry IDs", async () => {
    const fingerprint = await changesReviewFingerprint(diff);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await changesReviewFingerprint({ ...diff, observation_id: "obs-2", entry_id: "entry-8" })).toBe(fingerprint);
    expect(await changesReviewFingerprint({ ...diff, patch: "before\n+changed\n" })).not.toBe(fingerprint);
  });

  it.each(["binary", "notShown", "truncated", "nonUtf8"] as const)("does not treat %s as content evidence", async (state) => {
    expect(await changesReviewFingerprint({ ...diff, state, patch: null })).toBeNull();
  });

  it("limits concurrent review reads to two", async () => {
    let inFlight = 0;
    let peak = 0;
    const visited: string[] = [];
    await visitReviewEntries(["a", "b", "c", "d", "e"], async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      visited.push(id);
      inFlight -= 1;
    }, () => true);
    expect(peak).toBe(2);
    expect(visited.sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("does not dispatch queued reads after the editor closes", async () => {
    let active = true;
    const pending: (() => void)[] = [];
    const visited: string[] = [];
    const done = visitReviewEntries(["a", "b", "c", "d"], async (id) => {
      visited.push(id);
      await new Promise<void>((resolve) => pending.push(resolve));
    }, () => active);
    expect(visited).toEqual(["a", "b"]);
    active = false;
    for (const finish of pending) finish();
    await done;
    expect(visited).toEqual(["a", "b"]);
  });
});
