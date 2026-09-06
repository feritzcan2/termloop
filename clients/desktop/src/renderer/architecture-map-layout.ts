import type { ProjectArchitectureNodeDto } from "@termloop/contract/current";

export type ArchitectureMapPoint = {
  x: number;
  y: number;
  radius: number;
  communityKey: string;
};

export type ArchitectureMapLayout = {
  points: ReadonlyMap<string, ArchitectureMapPoint>;
  communityCenters: readonly { key: string; label: string; x: number; y: number; radius: number }[];
};

export function architectureCommunityKey(node: ProjectArchitectureNodeDto): string {
  if (typeof node.community === "number") return `n:${node.community}`;
  if (typeof node.community === "string") return `s:${node.community}`;
  return "z:";
}

export function architectureAreaLabel(node: ProjectArchitectureNodeDto): string {
  if (node.community_name) return node.community_name;
  const parts = node.source_file?.split(/[\\/]/).filter(Boolean) ?? [];
  const file = parts.at(-1);
  if (file) {
    const generic = new Set(["src", "source", "lib", "app"]);
    let parent: string | undefined;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const candidate = parts[index];
      if (candidate && !generic.has(candidate.toLocaleLowerCase())) {
        parent = candidate;
        break;
      }
    }
    return parent ? `${parent} / ${file}` : file;
  }
  return node.label;
}

export function architectureMapLayout(
  nodes: readonly ProjectArchitectureNodeDto[],
  width = 1200,
  height = 760,
  focusCommunityKey?: string,
): ArchitectureMapLayout {
  const groups = new Map<string, ProjectArchitectureNodeDto[]>();
  for (const node of nodes) {
    const key = architectureCommunityKey(node);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  const entries = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const points = new Map<string, ArchitectureMapPoint>();
  if (focusCommunityKey && groups.has(focusCommunityKey)) {
    const focusNodes = [...groups.get(focusCommunityKey)!].sort((left, right) =>
      right.risk_score - left.risk_score || right.degree - left.degree || left.label.localeCompare(right.label));
    const boundaryNodes = nodes
      .filter((node) => architectureCommunityKey(node) !== focusCommunityKey)
      .sort((left, right) => right.risk_score - left.risk_score || left.label.localeCompare(right.label));
    const centerX = width / 2;
    const centerY = height / 2;
    for (const [index, node] of focusNodes.entries()) {
      const angle = index * 2.399963229728653;
      const distance = Math.min(230, 18 * Math.sqrt(index));
      points.set(node.id, {
        x: centerX + Math.cos(angle) * distance,
        y: centerY + Math.sin(angle) * distance,
        radius: nodeRadius(node, 5, 14),
        communityKey: focusCommunityKey,
      });
    }
    for (const [index, node] of boundaryNodes.entries()) {
      const angle = Math.PI * 2 * index / Math.max(1, boundaryNodes.length) - Math.PI / 2;
      points.set(node.id, {
        x: centerX + Math.cos(angle) * width * .43,
        y: centerY + Math.sin(angle) * height * .42,
        radius: nodeRadius(node, 5, 12),
        communityKey: architectureCommunityKey(node),
      });
    }
    return {
      points,
      communityCenters: [{
        key: focusCommunityKey,
        label: architectureAreaLabel(focusNodes[0]!),
        x: centerX,
        y: centerY,
        radius: 255,
      }],
    };
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length * width / height)));
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const communityCenters = entries.map(([key, group], groupIndex) => {
    const x = (groupIndex % columns + .5) * cellWidth;
    const y = (Math.floor(groupIndex / columns) + .5) * cellHeight;
    const sorted = [...group].sort((left, right) =>
      right.risk_score - left.risk_score || right.degree - left.degree || left.label.localeCompare(right.label));
    const orbit = Math.max(0, Math.min(cellWidth, cellHeight) * .34);
    for (const [nodeIndex, node] of sorted.entries()) {
      const nodeAngle = nodeIndex * 2.399963229728653 + groupIndex * .37;
      const ring = sorted.length <= 1 ? 0 : Math.min(orbit, 9 * Math.sqrt(nodeIndex));
      points.set(node.id, {
        x: x + Math.cos(nodeAngle) * ring,
        y: y + Math.sin(nodeAngle) * ring,
        radius: nodeRadius(node, 4, Math.min(14, Math.max(7, orbit / 2))),
        communityKey: key,
      });
    }
    return { key, label: architectureAreaLabel(sorted[0]!), x, y, radius: Math.max(10, orbit + 5) };
  });
  return { points, communityCenters };
}

function nodeRadius(node: ProjectArchitectureNodeDto, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, minimum + node.risk_score / 11));
}

export function architectureRiskTone(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}
