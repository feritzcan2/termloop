// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectArchitectureCommunityDto,
  ProjectArchitectureGraphResult,
  ProjectArchitectureNodeDto,
  ProjectArchitectureSummaryDto,
} from "@termloop/contract/current";

import { ArchitectureMapPanel } from "../src/renderer/ui/ArchitectureMapPanel.js";

function node(index: number): ProjectArchitectureNodeDto {
  return {
    id: `node-${index}`,
    label: index === 15 ? "Shell.tsx" : `Area${index}.ts`,
    kind: "file",
    file_type: "typescript",
    source_file: `clients/desktop/src/renderer/ui/${index === 15 ? "Shell.tsx" : `Area${index}.ts`}`,
    source_location: null,
    community: 100 + index,
    community_name: null,
    fan_in: index,
    fan_out: index,
    degree: index * 2,
    risk_score: index === 15 ? 100 : index,
    neighbor_community_count: 1,
  };
}

const summary: ProjectArchitectureSummaryDto = {
  project_id: "project-1",
  status: "ready",
  engine_available: true,
  built_at_commit: "abc",
  current_commit: "abc",
  node_count: 30_060,
  edge_count: 65_860,
  community_count: 360,
  communities: Array.from({ length: 16 }, (_, index): ProjectArchitectureCommunityDto => ({
    key: `n:${100 + index}`,
    name: index === 15 ? "ui / Shell.tsx" : `ui / Area${index}.ts`,
    node_count: index + 1,
    risk_score: index === 15 ? 100 : index,
  })).sort((left, right) => right.risk_score - left.risk_score),
  community_catalog_truncated: false,
  hotspots: [],
  warning: null,
};

describe("ArchitectureMapPanel community drill-down", () => {
  it("shows a short risk-ranked area list and requests the selected community", async () => {
    const graph: ProjectArchitectureGraphResult = {
      summary,
      nodes: Array.from({ length: 16 }, (_, index) => node(index)),
      edges: [],
      truncated: true,
    };
    const loadGraph = vi.fn(async () => graph);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(createElement(ArchitectureMapPanel, {
        projectId: "project-1",
        projectName: "TermLoopMini",
        actions: {
          loadSummary: async () => summary,
          loadGraph,
          loadNode: async () => { throw new Error("not used"); },
          refresh: async () => summary,
        },
      }));
      await Promise.resolve();
    });

    const areaButtons = host.querySelectorAll<HTMLButtonElement>(
      ".architecture-community-list button:not(.architecture-area-toggle)",
    );
    expect(areaButtons).toHaveLength(14);
    expect(areaButtons[0]?.textContent).toContain("ui / Shell.tsx");
    expect(host.querySelector(".architecture-community-list > p")?.textContent).toBe("Top areas · search 360 total");

    await act(async () => areaButtons[0]!.click());
    expect(loadGraph).toHaveBeenLastCalledWith({
      projectId: "project-1",
      communityKey: "n:115",
      limit: 180,
    });

    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
