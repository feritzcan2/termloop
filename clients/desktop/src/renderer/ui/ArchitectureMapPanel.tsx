import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectArchitectureGraphParams,
  ProjectArchitectureGraphResult,
  ProjectArchitectureNodeDto,
  ProjectArchitectureNodeParams,
  ProjectArchitectureNodeResult,
  ProjectArchitectureSummaryDto,
} from "@termloop/contract/current";

import { architectureMapLayout, architectureRiskTone } from "../architecture-map-layout.js";
import { Icon } from "./Icon.js";
import "./architecture-map.css";

export type ArchitectureMapActions = {
  loadSummary(projectId: string): Promise<ProjectArchitectureSummaryDto>;
  loadGraph(params: ProjectArchitectureGraphParams): Promise<ProjectArchitectureGraphResult>;
  loadNode(params: ProjectArchitectureNodeParams): Promise<ProjectArchitectureNodeResult>;
  refresh(projectId: string): Promise<ProjectArchitectureSummaryDto>;
};

type MapScope = "overview" | "hotspots";

function statusLabel(status: ProjectArchitectureSummaryDto["status"]): string {
  switch (status) {
    case "ready": return "Current";
    case "stale": return "Refresh recommended";
    case "missing": return "Not indexed";
    case "unavailable": return "Graphify unavailable";
    case "invalid": return "Index damaged";
    case "failed": return "Refresh failed";
  }
}

function nodeSubtitle(node: ProjectArchitectureNodeDto): string {
  return node.source_file ?? node.kind;
}

function communityKey(node: ProjectArchitectureNodeDto): string {
  return node.community === null ? "unassigned" : String(node.community);
}

export function ArchitectureMapPanel({ projectId, projectName, actions }: {
  projectId: string;
  projectName: string;
  actions: ArchitectureMapActions;
}) {
  const [graph, setGraph] = useState<ProjectArchitectureGraphResult>();
  const [selected, setSelected] = useState<ProjectArchitectureNodeResult>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [scope, setScope] = useState<MapScope>("overview");
  const [community, setCommunity] = useState<string>();
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const graphRequest = useRef(0);
  const nodeRequest = useRef(0);

  const loadGraph = useCallback(async (centerNodeId?: string) => {
    const request = ++graphRequest.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await actions.loadGraph({
        projectId,
        limit: centerNodeId ? 220 : 360,
        ...(centerNodeId ? { centerNodeId, depth: 2 } : {}),
      });
      if (request !== graphRequest.current) return;
      setGraph(next);
    } catch {
      if (request === graphRequest.current) setError("Architecture data could not be loaded.");
    } finally {
      if (request === graphRequest.current) setLoading(false);
    }
  }, [actions, projectId]);

  useEffect(() => {
    setGraph(undefined);
    setSelected(undefined);
    setSelectedNodeId(undefined);
    setScope("overview");
    setCommunity(undefined);
    setQuery("");
    setZoom(1);
    void loadGraph();
    return () => { graphRequest.current += 1; nodeRequest.current += 1; };
  }, [loadGraph, projectId]);

  const selectNode = useCallback(async (nodeId: string) => {
    setSelectedNodeId(nodeId);
    const request = ++nodeRequest.current;
    try {
      const result = await actions.loadNode({ projectId, nodeId });
      if (request === nodeRequest.current) setSelected(result);
    } catch {
      if (request === nodeRequest.current) setSelected(undefined);
    }
  }, [actions, projectId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      const refreshed = await actions.refresh(projectId);
      if (refreshed.status === "failed" || refreshed.status === "unavailable" || refreshed.status === "invalid") {
        setGraph((current) => current
          ? { ...current, summary: refreshed }
          : { summary: refreshed, nodes: [], edges: [], truncated: false });
        return;
      }
      await loadGraph();
    } catch {
      setError("Graphify could not refresh this Project.");
    } finally {
      setRefreshing(false);
    }
  }, [actions, loadGraph, projectId]);

  const hotspotIds = useMemo(
    () => new Set(graph?.summary.hotspots.map((node) => node.id) ?? []),
    [graph?.summary.hotspots],
  );
  const visibleNodes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (graph?.nodes ?? []).filter((node) => {
      if (scope === "hotspots" && !hotspotIds.has(node.id)) return false;
      if (community !== undefined && communityKey(node) !== community) return false;
      return !normalizedQuery
        || node.label.toLocaleLowerCase().includes(normalizedQuery)
        || node.source_file?.toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [community, graph?.nodes, hotspotIds, query, scope]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [graph?.edges, visibleIds],
  );
  const layout = useMemo(() => architectureMapLayout(visibleNodes), [visibleNodes]);
  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph?.nodes],
  );
  const selectedDetail = selected?.node.id === selectedNodeId ? selected : undefined;
  const selectedNode = selectedDetail?.node ?? (selectedNodeId ? nodeById.get(selectedNodeId) : undefined);
  const communities = useMemo(() => {
    const found = new Map<string, string>();
    for (const node of graph?.nodes ?? []) {
      const key = communityKey(node);
      found.set(key, node.community_name ?? (key === "unassigned" ? "Unassigned" : `Community ${key}`));
    }
    return [...found.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [graph?.nodes]);
  const summary = graph?.summary;

  return (
    <div className="architecture-map" aria-label={`${projectName} architecture map`}>
      <aside className="architecture-map-browser">
        <div className="architecture-map-title">
          <span>Architecture</span>
          {summary ? <small>{summary.node_count} nodes · {summary.edge_count} links</small> : null}
        </div>
        <label className="architecture-search">
          <Icon name="search" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find symbol or file" />
        </label>
        <div className="architecture-scope" role="group" aria-label="Map scope">
          <button className={scope === "overview" && community === undefined ? "selected" : undefined} onClick={() => { setScope("overview"); setCommunity(undefined); }} type="button">Overview</button>
          <button className={scope === "hotspots" ? "selected" : undefined} onClick={() => { setScope("hotspots"); setCommunity(undefined); }} type="button">God nodes</button>
        </div>
        <section className="architecture-community-list">
          <h3>Communities <span>{communities.length}</span></h3>
          {communities.map(([key, label]) => (
            <button className={community === key ? "selected" : undefined} type="button" key={key} onClick={() => { setScope("overview"); setCommunity((current) => current === key ? undefined : key); }}>
              <i style={{ "--community-index": String(communities.findIndex(([candidate]) => candidate === key) % 8) } as React.CSSProperties} />
              <span>{label}</span>
            </button>
          ))}
        </section>
        <section className="architecture-hotspot-list">
          <h3>Highest risk <span>{summary?.hotspots.length ?? 0}</span></h3>
          {summary?.hotspots.slice(0, 12).map((node, index) => (
            <button type="button" key={node.id} className={selectedNodeId === node.id ? "selected" : undefined} onClick={() => void selectNode(node.id)}>
              <b>{index + 1}</b><span><strong>{node.label}</strong><small>{node.fan_in} in · {node.fan_out} out</small></span><em>{Math.round(node.risk_score)}</em>
            </button>
          ))}
        </section>
      </aside>

      <section className="architecture-map-canvas">
        <header>
          <div><strong>{projectName}</strong><span>Dependency topology</span></div>
          <div className="architecture-map-toolbar">
            {summary ? <span className={`architecture-status ${summary.status}`}>{statusLabel(summary.status)}</span> : null}
            <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(.55, value - .15))}>−</button>
            <button type="button" title="Reset zoom" aria-label="Reset zoom" onClick={() => setZoom(1)}><Icon name="focus" /></button>
            <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.8, value + .15))}>+</button>
            <button className="architecture-refresh" type="button" disabled={refreshing} onClick={() => void refresh()}><Icon name="restart" />{refreshing ? "Indexing…" : summary?.node_count ? "Refresh" : "Build map"}</button>
          </div>
        </header>
        {summary?.warning ? <div className="architecture-warning">{summary.warning}</div> : null}
        {error ? <div className="architecture-warning error">{error}</div> : null}
        <div className="architecture-map-surface">
          {loading && !graph ? <div className="architecture-empty"><span className="architecture-spinner" /><strong>Loading architecture…</strong></div> : null}
          {!loading && error && !graph ? <div className="architecture-empty"><Icon name="branch" /><strong>Architecture is unavailable</strong><p>Reconnect this Project or try loading the map again.</p><button type="button" onClick={() => void loadGraph()}>Try again</button></div> : null}
          {!loading && graph && graph.nodes.length === 0 ? <div className="architecture-empty">
            <Icon name="branch" />
            <strong>{summary?.status === "unavailable" ? "Graphify is not installed" : "Build the first architecture map"}</strong>
            <p>{summary?.status === "unavailable" ? <>Install the local extractor with <code>uv tool install graphifyy</code>, then try again.</> : "Graphify will parse the Project locally and cache only its generated graph in TermLoop state."}</p>
            <button type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Indexing…" : "Build map"}</button>
          </div> : null}
          {graph && graph.nodes.length > 0 ? <svg viewBox="0 0 1200 760" role="img" aria-label={`Architecture graph with ${visibleNodes.length} visible nodes`}>
            <g transform={`translate(600 380) scale(${zoom}) translate(-600 -380)`}>
              {layout.communityCenters.map((center, index) => <g className="architecture-community" key={center.key}>
                <circle cx={center.x} cy={center.y} r="138" style={{ "--community-index": String(index % 8) } as React.CSSProperties} />
                <text x={center.x} y={center.y - 146}>{center.label}</text>
              </g>)}
              <g className="architecture-edges">
                {visibleEdges.map((edge, index) => {
                  const source = layout.points.get(edge.source);
                  const target = layout.points.get(edge.target);
                  return source && target ? <line key={`${edge.source}:${edge.target}:${index}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} data-confidence={edge.confidence} /> : null;
                })}
              </g>
              <g className="architecture-nodes">
                {visibleNodes.map((node) => {
                  const point = layout.points.get(node.id);
                  if (!point) return null;
                  const selectedNode = node.id === selectedNodeId;
                  return <g key={node.id} className={`architecture-node ${architectureRiskTone(node.risk_score)}${selectedNode ? " selected" : ""}`} transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={`${node.label}, risk ${Math.round(node.risk_score)}`} onClick={() => void selectNode(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void selectNode(node.id); }}>
                    <circle r={point.radius} />
                    {(selectedNode || node.risk_score >= 58) ? <text y={point.radius + 15}>{node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label}</text> : null}
                  </g>;
                })}
              </g>
            </g>
          </svg> : null}
          {graph?.truncated ? <span className="architecture-truncated">Showing the highest-signal slice</span> : null}
        </div>
      </section>

      <aside className="architecture-inspector">
        {selectedNode ? <>
          <div className="architecture-inspector-heading"><span className={`risk-dot ${architectureRiskTone(selectedNode.risk_score)}`} /><div><small>{selectedNode.kind}</small><h2>{selectedNode.label}</h2></div></div>
          <div className="architecture-risk-score"><strong>{Math.round(selectedNode.risk_score)}</strong><span>risk score</span></div>
          <dl>
            <div><dt>Fan in</dt><dd>{selectedNode.fan_in}</dd></div>
            <div><dt>Fan out</dt><dd>{selectedNode.fan_out}</dd></div>
            <div><dt>Degree</dt><dd>{selectedNode.degree}</dd></div>
            <div><dt>Communities reached</dt><dd>{selectedNode.neighbor_community_count}</dd></div>
          </dl>
          <section><h3>Source</h3><code>{nodeSubtitle(selectedNode)}{selectedNode.source_location ? `:${selectedNode.source_location}` : ""}</code></section>
          <section className="architecture-connection-list"><h3>Connections <span>{selectedDetail?.connections.length ?? selectedNode.degree}</span></h3>
            {selectedDetail?.connections.slice(0, 18).map((edge, index) => {
              const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
              return <button type="button" key={`${edge.source}:${edge.target}:${index}`} onClick={() => void selectNode(otherId)}><span>{nodeById.get(otherId)?.label ?? otherId}</span><small>{edge.relation}</small></button>;
            })}
          </section>
          <button className="architecture-impact" type="button" onClick={() => void loadGraph(selectedNode.id)}><Icon name="focus" />Show impact radius</button>
          <button className="architecture-overview" type="button" onClick={() => void loadGraph()}>Back to overview</button>
        </> : <div className="architecture-inspector-empty"><Icon name="branch" /><strong>Select a node</strong><p>Inspect dependency direction, reach and source location.</p></div>}
      </aside>
    </div>
  );
}
