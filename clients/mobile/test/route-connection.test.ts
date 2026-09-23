import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { useRouteConnection } from "../src/features/connection/use-route-connection";

describe("route connection ownership", () => {
  it("does not let a retained route take selection back from another computer", async () => {
    const selected = { id: "mac-a" };
    const select = vi.fn((id: string) => { selected.id = id; });
    const project = await harness(select);
    const session = await harness(select);
    project.render("mac-a", true);
    project.render("mac-a", false);
    session.render("mac-b", true);
    for (let i = 0; i < 60; i++) {
      project.render("mac-a", false);
      session.render("mac-b", true);
    }
    expect(selected.id).toBe("mac-b");
    expect(select.mock.calls).toEqual([["mac-a"], ["mac-b"]]);
    session.render("mac-b", false);
    project.render("mac-a", true);
    expect(selected.id).toBe("mac-a");
  });

  it("allows a notification to select its destination before the old route blurs", async () => {
    const selected = { id: "mac-a" };
    const select = vi.fn((id: string) => { selected.id = id; });
    const route = await harness(select);
    route.render("mac-a", true);
    select("mac-b");
    route.render("mac-a", true);
    expect(selected.id).toBe("mac-b");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("waits for focus and a resolved scope, then follows parameter changes", async () => {
    const select = vi.fn();
    const route = await harness(select);
    route.render(undefined, true);
    route.render("mac-a", false);
    route.render("mac-b", false);
    expect(select).not.toHaveBeenCalled();
    route.render("mac-b", true);
    route.render("mac-c", true);
    expect(select.mock.calls).toEqual([["mac-b"], ["mac-c"]]);
  });
});

async function harness(select: (connectionId: string) => void) {
  let memo: { deps: readonly unknown[]; callback: () => void } | undefined;
  let previousEffect: (() => void) | undefined;
  let focused = false;
  let previouslyFocused = false;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/features/connection/use-route-connection.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "expo-router"],
  });
  const module = { exports: {} as { useRouteConnection: typeof useRouteConnection } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return {
      useCallback(callback: () => void, deps: readonly unknown[]) {
        if (!memo || deps.length !== memo.deps.length || deps.some((value, index) => !Object.is(value, memo!.deps[index]))) {
          memo = { deps, callback };
        }
        return memo.callback;
      },
    };
    if (name === "expo-router") return {
      useFocusEffect(effect: () => void) {
        if (focused && (!previouslyFocused || effect !== previousEffect)) effect();
        previousEffect = effect;
        previouslyFocused = focused;
      },
    };
    throw new Error(`Unexpected import: ${name}`);
  }, module, module.exports);
  return { render(connectionId: string | undefined, isFocused: boolean) {
    focused = isFocused;
    module.exports.useRouteConnection(connectionId, select);
  } };
}
