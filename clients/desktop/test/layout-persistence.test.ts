import { describe, expect, it, vi } from "vitest";
import { createProjectLayout } from "../src/layout/model.js";
import { createLayoutPersistence } from "../src/renderer/state/layout-persistence.js";

describe("layout persistence", () => {
  it("coalesces launch projection and selection updates into the latest valid document", async () => {
    const callbacks: Array<() => void> = [];
    const save = vi.fn(async () => undefined);
    const report = vi.fn();
    const persist = createLayoutPersistence(save, report, (callback) => callbacks.push(callback));
    persist({
      layoutLoaded: true,
      layoutRevision: 1,
      layoutDocument: () => ({ version: 2, profiles: { local: { projects: { project: {} as never }, sessionOrderByProject: {} } } }),
    });
    const document = {
      version: 2 as const,
      profiles: { local: {
        projects: { project: createProjectLayout("session", () => "pane") },
        sessionOrderByProject: { project: ["session"] },
      } },
    };
    persist({ layoutLoaded: true, layoutRevision: 2, layoutDocument: () => document });

    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(document);
    expect(report).not.toHaveBeenCalled();
  });

  it("waits through promise continuations used between projection refresh and session selection", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const report = vi.fn();
      const persist = createLayoutPersistence(save, report);
      persist({
        layoutLoaded: true,
        layoutRevision: 1,
        layoutDocument: () => ({ version: 2, profiles: { local: { projects: { project: {} as never }, sessionOrderByProject: {} } } }),
      });
      await Promise.resolve();
      const document = {
        version: 2 as const,
        profiles: { local: {
          projects: { project: createProjectLayout("session", () => "pane") },
          sessionOrderByProject: { project: ["session"] },
        } },
      };
      persist({ layoutLoaded: true, layoutRevision: 2, layoutDocument: () => document });

      expect(save).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(save).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith(document);
      expect(report).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends an invalid latest document to the privileged file store", () => {
    const callbacks: Array<() => void> = [];
    const save = vi.fn(async () => undefined);
    const report = vi.fn();
    const persist = createLayoutPersistence(save, report, (callback) => callbacks.push(callback));
    persist({
      layoutLoaded: true,
      layoutRevision: 1,
      layoutDocument: () => ({ version: 2, profiles: { local: { projects: { broken: {} as never }, sessionOrderByProject: {} } } }),
    });
    callbacks[0]?.();
    expect(save).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
  });
});
