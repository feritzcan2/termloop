export const allowedRust = new Map(Object.entries({
  "termloop-contract": [],
  "termloop-domain": [],
  "termloop-platform": [],
  "termloop-gitio": ["termloop-platform"],
  "termloop-providers": ["termloop-platform"],
  "termloop-agents": ["termloop-domain", "termloop-platform"],
  "termloop-store": ["termloop-domain", "termloop-platform"],
  "termloop-invocation": ["termloop-agents", "termloop-domain", "termloop-platform"],
  "termloop-terminal": ["termloop-platform"],
  "termloop-observability": ["termloop-gitio", "termloop-platform"],
  "termloop-llm": ["termloop-platform"],
  "termloop-core": ["termloop-agents", "termloop-domain", "termloop-gitio", "termloop-invocation", "termloop-llm", "termloop-observability", "termloop-platform", "termloop-providers", "termloop-store", "termloop-terminal"],
  "termloop-server": ["termloop-contract", "termloop-core", "termloop-platform", "termloop-terminal"],
  "termloop-companion": ["termloop-contract"],
  "termloop-r0-server": ["termloop-platform"]
}));

export function validateEdge(source, target) {
  if (!allowedRust.has(source)) return `DAG_UNKNOWN_MODULE: ${source}`;
  if (!allowedRust.has(target)) return undefined;
  if (!allowedRust.get(source).includes(target)) return `DAG_FORBIDDEN_EDGE: ${source} -> ${target}`;
  return undefined;
}

export function findCycle(graph) {
  const visiting = new Set(); const visited = new Set();
  function visit(node, path) {
    if (visiting.has(node)) return [...path.slice(path.indexOf(node)), node];
    if (visited.has(node)) return undefined;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) { const cycle = visit(dependency, [...path, node]); if (cycle) return cycle; }
    visiting.delete(node); visited.add(node); return undefined;
  }
  for (const node of graph.keys()) { const cycle = visit(node, []); if (cycle) return cycle; }
  return undefined;
}
