// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectModeResult, ProjectModeSetParams } from "@termloop/contract/current";

import { PROFILED_DESKTOP_OPERATIONS, isProfiledIpcChannel } from "../src/source-operations.js";
import { takeLegacyProjectManagerModeFlag } from "../src/renderer/project-manager-mode-flag.js";
import {
  ProjectModeMenuItems,
  useProjectManagerSwitch,
  type ProjectManagerSwitchActions,
  type ProjectModeActions,
} from "../src/renderer/ui/ProjectModeMenuItems.js";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [["termloop.experimental.projectManagerMode.v1", initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
}

/// A daemon double: reads return the stored mode at the current revision, and
/// a write against any other revision is refused as the core would.
function daemon(initial: ProjectModeResult["mode"] = "developer") {
  let mode = initial;
  let revision = 7;
  const saves: ProjectModeSetParams[] = [];
  const actions: ProjectModeActions = {
    load: async (projectId) => ({ projectId, mode, stateRevision: revision }),
    save: async (params) => {
      saves.push(params);
      if (params.expectedRevision !== revision) throw new Error("conflict");
      mode = params.mode;
      revision += 1;
      return { projectId: params.projectId, mode, stateRevision: revision };
    },
  };
  return { actions, saves, bump: () => { revision += 1; } };
}

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')];

describe("Project Manager mode switch", () => {
  it("hands an old client-local switch that was on to the daemon once", () => {
    expect(takeLegacyProjectManagerModeFlag(memoryStorage())).toBe(false);
    expect(takeLegacyProjectManagerModeFlag(memoryStorage("off"))).toBe(false);
    const storage = memoryStorage("on");
    expect(takeLegacyProjectManagerModeFlag(storage)).toBe(true);
    expect(takeLegacyProjectManagerModeFlag(storage)).toBe(false);
    expect(takeLegacyProjectManagerModeFlag({ getItem: () => { throw new Error("blocked"); }, removeItem: () => undefined })).toBe(false);
  });

  it("allowlists the switch operations as source-targeted channels", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerModeGet).toBe("termloop:project-manager-mode-get");
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerModeSet).toBe("termloop:project-manager-mode-set");
    expect(isProfiledIpcChannel("termloop:project-manager-mode-set")).toBe(true);
  });

  it("shows the daemon's switch, stays off until it answers, and reports a refused write", async () => {
    let enabled = false;
    let answer: () => void = () => undefined;
    let refuse = false;
    const actions: ProjectManagerSwitchActions = {
      load: () => new Promise((resolve) => { answer = () => resolve({ enabled, stateRevision: 1 }); }),
      save: async (next) => {
        if (refuse) throw new Error("capabilityDenied");
        enabled = next;
        return { enabled, stateRevision: 2 };
      },
      refreshToken: 0,
    };
    let view: ReturnType<typeof useProjectManagerSwitch> | undefined;
    function Probe() { view = useProjectManagerSwitch(actions); return null; }
    await act(async () => root.render(<Probe />));
    expect(view).toMatchObject({ enabled: false, known: false });
    enabled = true;
    await act(async () => answer());
    expect(view).toMatchObject({ enabled: true, known: true });
    let failure: string | undefined;
    await act(async () => { failure = await view!.set(false); });
    expect(failure).toBeUndefined();
    expect(view!.enabled).toBe(false);
    refuse = true;
    await act(async () => { failure = await view!.set(true); });
    expect(failure).toBe("capabilityDenied");
    expect(view!.enabled).toBe(false);
  });
});

describe("Project mode menu", () => {
  it("allowlists the two Project mode operations as source-targeted channels", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.projectModeGet).toBe("termloop:project-mode-get");
    expect(PROFILED_DESKTOP_OPERATIONS.projectModeSet).toBe("termloop:project-mode-set");
    expect(isProfiledIpcChannel("termloop:project-mode-get")).toBe(true);
    expect(isProfiledIpcChannel("termloop:project-mode-set")).toBe(true);
  });

  it("shows the stored mode and switches against a freshly read revision", async () => {
    const { actions, saves, bump } = daemon();
    await act(async () => root.render(<ProjectModeMenuItems projectId="project-1" disabled={false} actions={actions} />));
    expect(radios().map((button) => [button.textContent, button.getAttribute("aria-checked")])).toEqual([
      ["Developer", "true"],
      ["Project Manager", "false"],
    ]);
    bump();
    await act(async () => radios()[1]!.click());
    expect(saves).toEqual([{ projectId: "project-1", mode: "projectManager", expectedRevision: 8 }]);
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not write when the current mode is chosen again and reports a refused write", async () => {
    const { actions, saves } = daemon("projectManager");
    const refusing: ProjectModeActions = { load: actions.load, save: async () => { throw new Error("Project not found"); } };
    await act(async () => root.render(<ProjectModeMenuItems projectId="project-1" disabled={false} actions={refusing} />));
    await act(async () => radios()[1]!.click());
    expect(saves).toEqual([]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => radios()[0]!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Project not found");
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
  });
});
