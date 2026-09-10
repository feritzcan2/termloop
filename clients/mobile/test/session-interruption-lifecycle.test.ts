import type { AgentStatusDto } from "@termloop/contract/current";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });
const interrupted: AgentStatusDto = { sessionId: "agent-a", status: "interrupted", source: "hook", observedAtEpochMs: 10 };

describe("inspecting an interrupted mobile Session", () => {
  it("keeps Interrupted visible while open and acknowledges when a retained route loses focus", async () => {
    const h = await harness();
    h.render();
    expect(h.acknowledge).not.toHaveBeenCalled();
    h.render({ status: { ...interrupted, observedAtEpochMs: 11 } });
    expect(h.acknowledge).not.toHaveBeenCalled();
    h.render({ focused: false });
    expect(h.acknowledge).toHaveBeenCalledExactlyOnceWith("mac-a", "agent-a", 11);
    h.render({ status: { ...interrupted, observedAtEpochMs: 12 } });
    h.unmount();
    expect(h.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("acknowledges on native-stack removal and can inspect a new interruption after refocus", async () => {
    const h = await harness();
    h.render(); h.render({ focused: false });
    h.render({ status: { ...interrupted, observedAtEpochMs: 12 } });
    h.render({ focused: true }); h.unmount();
    expect(h.acknowledge.mock.calls).toEqual([["mac-a", "agent-a", 10], ["mac-a", "agent-a", 12]]);
  });

  it("does not acknowledge a screen that has never been focused", async () => {
    const h = await harness();
    h.render({ focused: false }); h.unmount();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges the original Mac when switching scope even if Session IDs match", async () => {
    const h = await harness();
    h.render();
    h.render({ connectionId: "mac-b", status: { ...interrupted, observedAtEpochMs: 20 } });
    expect(h.acknowledge).toHaveBeenCalledExactlyOnceWith("mac-a", "agent-a", 10);
    h.unmount();
    expect(h.acknowledge).toHaveBeenLastCalledWith("mac-b", "agent-a", 20);
  });

  it("never acknowledges a different Session's status while route selection catches up", async () => {
    const h = await harness();
    h.render({ sessionId: "agent-b" }); h.unmount();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it("stops tracking Interrupted when the observed agent starts working again", async () => {
    const h = await harness();
    h.render(); h.render({ status: { ...interrupted, status: "working", observedAtEpochMs: 11 } });
    h.unmount();
    expect(h.acknowledge).not.toHaveBeenCalled();
  });
});

async function harness() {
  type Slot = { deps: readonly unknown[]; value?: unknown; cleanup?: (() => void) | undefined };
  const slots: Slot[] = [];
  let cursor = 0, pending: Array<() => void> = [], retiring: Array<() => void> = [];
  const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useMemo: (create: () => unknown, deps: readonly unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !same(slots[index]!.deps, deps)) slots[index] = { deps, value: create() };
      return slots[index]!.value;
    },
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => {
      const index = cursor++;
      if (slots[index] && same(slots[index]!.deps, deps)) return;
      if (slots[index]?.cleanup) retiring.push(slots[index]!.cleanup!);
      slots[index] = { deps };
      pending.push(() => { slots[index]!.cleanup = effect() ?? undefined; });
    },
  };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/overview/use-session-interruption-acknowledgement.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", external: ["react"] });
  type Hook = typeof import("../src/features/overview/use-session-interruption-acknowledgement").useSessionInterruptionAcknowledgement;
  const module = { exports: {} as { useSessionInterruptionAcknowledgement: Hook } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(() => react, module, module.exports);
  const acknowledge = vi.fn();
  const props = { focused: true, connectionId: "mac-a", sessionId: "agent-a", status: interrupted };
  const unmount = () => { slots.forEach((slot) => slot.cleanup?.()); slots.length = 0; };
  cleanups.push(unmount);
  return {
    acknowledge, unmount,
    render: (next: Partial<typeof props> = {}) => {
      Object.assign(props, next); cursor = 0; pending = []; retiring = [];
      module.exports.useSessionInterruptionAcknowledgement(props.focused, props.connectionId, props.sessionId, props.status, acknowledge);
      // React runs all passive cleanups before setting up the changed effects.
      retiring.forEach((cleanup) => cleanup()); pending.forEach((effect) => effect());
    },
  };
}
