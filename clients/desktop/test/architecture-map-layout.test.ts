import { describe, expect, it } from "vitest";
import type { ProjectArchitectureNodeDto } from "@termloop/contract/current";

import { architectureMapLayout, architectureRiskTone } from "../src/renderer/architecture-map-layout.js";

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

  it("classifies risk at stable UI thresholds", () => {
    expect([architectureRiskTone(80), architectureRiskTone(60), architectureRiskTone(30), architectureRiskTone(5)])
      .toEqual(["critical", "high", "medium", "low"]);
  });
});
