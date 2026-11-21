import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createMockRuntime } from "../src/adapters/mock/mock-runtime";
import type { BranchChanges } from "../src/features/changes/use-branch-changes";
import { fixtureTaskBranchCommits, fixtureTaskCommitEntries } from "../src/fixtures/mobile-overview";

const require = createRequire(import.meta.url);

describe("committed branch changes", () => {
  it("opens on all branch changes, then reads one commit and one patch by the same observation", async () => {
    const runtime = createMockRuntime();
    const connectionId = (await runtime.connections.list())[0]!.id;
    const listCommitChanges = vi.spyOn(runtime.worktreeChanges, "listCommitChanges");
    const diffCommit = vi.spyOn(runtime.worktreeChanges, "diffCommit");
    const h = await harness((useBranchChanges) => useBranchChanges(runtime.worktreeChanges, connectionId, fixtureTaskBranchCommits.task_id, true));

    await vi.waitFor(() => expect(h.render().changes?.commit_id).toBe("all"));
    expect(h.render().commits?.commits.map((commit) => commit.short_oid)).toEqual(fixtureTaskBranchCommits.commits.map((commit) => commit.short_oid));
    expect(h.render().changes?.entries.map((entry) => entry.entry_id)).toEqual(fixtureTaskCommitEntries.all!.map((entry) => entry.entry_id));

    const commit = fixtureTaskBranchCommits.commits[1]!;
    h.render().selectCommit(commit.commit_id);
    await vi.waitFor(() => expect(h.render().changes?.commit_id).toBe(commit.commit_id));
    expect(listCommitChanges).toHaveBeenLastCalledWith(connectionId, fixtureTaskBranchCommits.task_id, fixtureTaskBranchCommits.observation_id, commit.commit_id);

    const entry = h.render().changes!.entries[0]!;
    h.render().selectEntry(entry.entry_id);
    await vi.waitFor(() => expect(h.render().diff?.state).toBe("patch"));
    expect(diffCommit).toHaveBeenLastCalledWith(connectionId, fixtureTaskBranchCommits.task_id, fixtureTaskBranchCommits.observation_id, commit.commit_id, entry.entry_id);

    h.render().setFullFile(true);
    await vi.waitFor(() => expect(h.render().preImage?.entry_id).toBe(entry.entry_id));
    h.unmount();
  });

  it("reads the commit list but no files until the branch scope is shown", async () => {
    const runtime = createMockRuntime();
    const connectionId = (await runtime.connections.list())[0]!.id;
    const listCommitChanges = vi.spyOn(runtime.worktreeChanges, "listCommitChanges");
    const h = await harness((useBranchChanges) => useBranchChanges(runtime.worktreeChanges, connectionId, fixtureTaskBranchCommits.task_id, false));

    await vi.waitFor(() => expect(h.render().commits?.observation_id).toBe(fixtureTaskBranchCommits.observation_id));
    expect(h.render().changes).toBeUndefined();
    expect(listCommitChanges).not.toHaveBeenCalled();
    h.unmount();
  });
});

type UseBranchChanges = typeof import("../src/features/changes/use-branch-changes").useBranchChanges;

/// A minimal hook runner whose effects honour their dependency lists, so a
/// selection change re-reads exactly what the real component would.
async function harness(use: (hook: UseBranchChanges) => BranchChanges) {
  const slots: any[] = [];
  const cleanups = new Map<number, () => void>();
  let cursor = 0;
  const react = {
    ...require("react"),
    useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useMemo: (factory: () => unknown, deps: unknown[]) => memo(factory, deps),
    useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const index = cursor++;
      const previous = slots[index] as unknown[] | undefined;
      if (previous && previous.length === deps.length && previous.every((value, i) => Object.is(value, deps[i]))) return;
      slots[index] = deps;
      cleanups.get(index)?.();
      const cleanup = effect();
      if (cleanup) cleanups.set(index, cleanup); else cleanups.delete(index);
    },
  };
  function memo(factory: () => unknown, deps: unknown[]) {
    const index = cursor++;
    const previous = slots[index] as { deps: unknown[]; value: unknown } | undefined;
    if (previous && previous.deps.every((value, i) => Object.is(value, deps[i]))) return previous.value;
    const value = factory();
    slots[index] = { deps, value };
    return value;
  }
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/features/changes/use-branch-changes.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react"],
  });
  const module = { exports: {} as typeof import("../src/features/changes/use-branch-changes") };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (name: string) => name === "react" ? react : require(name), module, module.exports,
  );
  return {
    render: (): BranchChanges => {
      cursor = 0;
      return use(module.exports.useBranchChanges);
    },
    unmount: () => cleanups.forEach((cleanup) => cleanup()),
  };
}
