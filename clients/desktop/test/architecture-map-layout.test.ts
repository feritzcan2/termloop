import { describe, expect, it } from "vitest";
import type { ProjectArchitectureNodeDto } from "@termloop/contract/current";

import {
  architectureAreaLabel,
  architectureCommunityKey,
  architectureMapLayout,
  architectureRiskTone,
} from "../src/renderer/architecture-map-layout.js";

function node(id: string, community: number, risk: number): ProjectArchitectureNodeDto {
  return {
    id,
    label: id,
    kind: "symbol",
    file_type: null,
    source_file: null,
    source_location: null,
    community,
    community_name: null,
    fan_in: 0,
    fan_out: 0,
    degree: 0,
    risk_score: risk,
    neighbor_community_count: 0,
  };
}

describe("architecture map layout", () => {
  it("places every node deterministically and separates communities", () => {
    const nodes = [node("a", 1, 80), node("b", 1, 20), node("c", 2, 50)];
    const first = architectureMapLayout(nodes);
    const second = architectureMapLayout(nodes);

    expect([...first.points.entries()]).toEqual([...second.points.entries()]);
    expect(first.points.size).toBe(3);
    expect(first.communityCenters).toHaveLength(2);
    expect(first.points.get("a")?.radius).toBeGreaterThan(first.points.get("b")?.radius ?? 0);
  });

  it("keeps a selected area central and moves its boundary context outside", () => {
    const nodes = [node("a", 1, 80), node("b", 1, 20), node("boundary", 2, 50)];
    const layout = architectureMapLayout(nodes, 1200, 760, "n:1");

    expect(layout.communityCenters).toHaveLength(1);
    expect(layout.communityCenters[0]?.key).toBe("n:1");
    const focus = layout.points.get("a")!;
    const boundary = layout.points.get("boundary")!;
    expect(Math.hypot(focus.x - 600, focus.y - 380)).toBeLessThan(255);
    expect(Math.hypot(boundary.x - 600, boundary.y - 380)).toBeGreaterThan(255);
  });

  it("classifies risk at stable UI thresholds", () => {
    expect([architectureRiskTone(80), architectureRiskTone(60), architectureRiskTone(30), architectureRiskTone(5)])
      .toEqual(["critical", "high", "medium", "low"]);
  });

  it("keeps raw community keys internal and derives a useful area label", () => {
    const item = node("shell", 106, 52);
    item.source_file = "clients/desktop/src/renderer/ui/Shell.tsx";

    expect(architectureCommunityKey(item)).toBe("n:106");
    expect(architectureAreaLabel(item)).toBe("ui / Shell.tsx");
  });
});
