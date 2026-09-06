import type { ProjectArchitectureNodeDto } from "@termloop/contract/current";

export type ArchitectureMapPoint = {
  x: number;
  y: number;
  radius: number;
  communityKey: string;
};

export type ArchitectureMapLayout = {
  points: ReadonlyMap<string, ArchitectureMapPoint>;
  communityCenters: readonly { key: string; label: string; x: number; y: number }[];
};

function communityKey(node: ProjectArchitectureNodeDto): string {
  return node.community === null ? "unassigned" : String(node.community);
}

export function architectureMapLayout(
  nodes: readonly ProjectArchitectureNodeDto[],
  width = 1200,
  height = 760,
): ArchitectureMapLayout {
  const groups = new Map<string, ProjectArchitectureNodeDto[]>();
  for (const node of nodes) {
    const key = communityKey(node);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  const entries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const points = new Map<string, ArchitectureMapPoint>();
  const centerRadius = Math.min(width, height) * (entries.length <= 1 ? 0 : 0.28);
  const communityCenters = entries.map(([key, group], groupIndex) => {
    const angle = entries.length <= 1 ? 0 : (Math.PI * 2 * groupIndex / entries.length) - Math.PI / 2;
    const x = width / 2 + Math.cos(angle) * centerRadius;
    const y = height / 2 + Math.sin(angle) * centerRadius;
    const sorted = [...group].sort((left, right) =>
      right.risk_score - left.risk_score || right.degree - left.degree || left.label.localeCompare(right.label));
    const orbit = Math.min(120, 42 + Math.sqrt(sorted.length) * 13);
    for (const [nodeIndex, node] of sorted.entries()) {
      const nodeAngle = (Math.PI * 2 * nodeIndex / Math.max(1, sorted.length)) + (groupIndex * 0.37);
      const ring = sorted.length <= 1 ? 0 : orbit * (0.48 + 0.52 * ((nodeIndex % 3) / 2));
      points.set(node.id, {
        x: x + Math.cos(nodeAngle) * ring,
        y: y + Math.sin(nodeAngle) * ring,
        radius: Math.max(6, Math.min(19, 6 + node.risk_score / 9)),
        communityKey: key,
      });
    }
    const name = group.find((node) => node.community_name)?.community_name;
    return { key, label: name ?? (key === "unassigned" ? "Unassigned" : `Community ${key}`), x, y };
  });
  return { points, communityCenters };
}

export function architectureRiskTone(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}
