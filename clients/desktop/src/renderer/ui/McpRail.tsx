import { useMemo, useState } from "react";

import type { McpToolName, McpToolSettingsResult } from "@termloop/contract/current";
import { MCP_TOOL_ROLES, mcpToolRoleLabel } from "../mcp-settings.js";
import { Icon } from "./Icon.js";
import { RailGroup, RailRow } from "./RailGroup.js";
import { useRailGroups } from "./rail-groups.js";

/// Sidebar list of every app-managed MCP tool, grouped by the launch profile it
/// reaches. A tool visible to several profiles appears under each of them,
/// because that membership is the fact the user came here to check.
export function McpRail({ settings, error, loading, selectedTool, openTool, improveTool, reload }: {
  settings: McpToolSettingsResult | undefined;
  error: string | undefined;
  loading: boolean;
  selectedTool: McpToolName | undefined;
  openTool(tool: McpToolName): void;
  /// Absent while no Project is open: the improver runs in a checkout.
  improveTool?: ((tool: McpToolName, title: string) => void) | undefined;
  reload(): void;
}) {
  const [query, setQuery] = useState("");
  const groups = useRailGroups();

  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleTools = useMemo(() => (settings?.tools ?? []).filter((tool) => !normalizedQuery
    || [tool.title, tool.name, tool.effectiveDescription].join("\n").toLocaleLowerCase("en-US").includes(normalizedQuery)),
  [settings?.tools, normalizedQuery]);

  return (
    <nav className="settings-rail" aria-label="MCP tools">
      <div className="settings-rail-toolbar">
        <label className="rail-search"><Icon name="search" /><input value={query} aria-label="Search MCP tools" placeholder="Search tools" onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="icon-button quiet" type="button" title={loading ? "Loading…" : "Reload MCP tools"} aria-label="Reload MCP tools" disabled={loading} onClick={reload}><Icon name="restart" /></button>
      </div>
      <p className="settings-rail-note"><Icon name="mcp" /><span>App-managed for TermLoop Sessions · <code>termloop_next</code></span></p>
      {error ? <p className="settings-rail-error" role="alert">Could not load MCP tools: {error}</p> : null}

      {MCP_TOOL_ROLES.map((role) => {
        const tools = visibleTools.filter((tool) => tool.roles.includes(role));
        if (!tools.length) return null;
        // Interactive is the profile of the Session the user is looking at, so
        // it opens; the other profiles stay one click away.
        const collapsed = !normalizedQuery && groups.collapsed(role, role !== "interactive");
        return <RailGroup
          key={role}
          label={mcpToolRoleLabel(role)}
          count={tools.length}
          collapsed={collapsed}
          toggle={() => groups.toggle(role)}
        >
          {tools.map((tool) => <RailRow
            key={tool.name}
            label={tool.title}
            detail={tool.effectiveDescription}
            mark={tool.customized ? "Customized" : undefined}
            selected={tool.name === selectedTool}
            open={() => openTool(tool.name)}
            improve={improveTool ? () => improveTool(tool.name, tool.title) : undefined}
          />)}
        </RailGroup>;
      })}
      {!settings && !error ? <span className="settings-rail-empty">Loading MCP tools…</span> : null}
      {settings && !visibleTools.length ? <span className="settings-rail-empty">No tool matches this search.</span> : null}
    </nav>
  );
}
