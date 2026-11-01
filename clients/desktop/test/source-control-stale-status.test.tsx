// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceControlStatusResult, TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import { SourceControlStatus, type SourceControlApi, type SourceControlSubject } from "../src/renderer/source-control-status.js";
import { SourceControlSidebar } from "../src/renderer/ui/SourceControlSidebar.js";
import { useSourceControl } from "../src/renderer/ui/use-source-control.js";

const PROJECT: SourceControlSubject = { projectId: "project", taskId: null };
const TIMEOUT = "Error invoking remote method 'termloop:source-control-status': TermLoopControlError: Git did not finish in time";
const entry: TaskWorktreeChangeEntryDto = {
  entry_id: "e1", display_path: "src/a.ts", original_display_path: null, path_encoding: "utf8", side: "unstaged", kind: "modified", render_state: "available",
};
const result: SourceControlStatusResult = {
  project_id: "project", task_id: null, observation_id: "obs-1", entries: [entry], truncated: false,
  branch: { name: "develop", head_state: "attached", upstream: "origin/develop", upstream_gone: false, ahead: 0, behind: 0 },
};
const mockApi = () => ({
  status: vi.fn(async (_params: unknown) => result),
  stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), commit: vi.fn(), push: vi.fn(), pull: vi.fn(), fetch: vi.fn(),
});

describe("Source Control status refresh failures", () => {
  it("keeps the last good status and drops Electron's IPC wrapper from the message", async () => {
    const api = mockApi();
    const model = new SourceControlStatus(PROJECT, () => api as unknown as SourceControlApi);
    model.start();
    await vi.waitFor(() => expect(model.getSnapshot().result).toBe(result));
    api.status.mockRejectedValueOnce(new Error(TIMEOUT));
    await model.refresh();
    expect(model.getSnapshot().result).toBe(result);
    expect(model.getSnapshot().error).toBe("Git did not finish in time");
    await model.refresh();
    expect(model.getSnapshot().error).toBeUndefined();
  });

  describe("sidebar", () => {
    let container: HTMLDivElement;
    let root: Root;
    let api: ReturnType<typeof mockApi>;
    function Harness({ signal }: { signal: string }) {
      const { status: model, snapshot } = useSourceControl(PROJECT, signal, api as unknown as SourceControlApi);
      return <SourceControlSidebar subject={PROJECT} projectName="Project" tasks={[]} selectedTaskId={null}
        snapshot={snapshot} actions={model} autoPull={false} setAutoPull={() => {}} selectRoot={() => {}}
        openChange={() => {}} openAll={() => {}} close={() => {}} unavailable={false} />;
    }
    beforeEach(() => {
      api = mockApi();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it("shows a failed refresh as a stale note over the kept changes, not an error alert", async () => {
      await act(async () => root.render(<Harness signal="1" />));
      api.status.mockRejectedValueOnce(new Error(TIMEOUT));
      await act(async () => root.render(<Harness signal="2" />));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Showing the last status. Refresh failed: Git did not finish in time");
      expect(container.textContent).toContain("a.ts");
    });
  });
});
