import { useEffect, useState } from "react";
import type { PmTool, PmToolKind, PmToolState, PmToolsReadResult } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { relativeTime } from "./format.js";

const GROUPS: { kind: PmToolKind; label: string; note?: string }[] = [
  { kind: "source", label: "Project sources" },
  { kind: "cli", label: "Command-line tools" },
  { kind: "mcp", label: "MCP servers" },
  {
    kind: "connector",
    label: "Claude account connectors",
    note: "These live in your Claude account. An agent shows whether one works when it uses it.",
  },
];

const MARKS: Record<PmToolState, { mark: string; label: string }> = {
  ready: { mark: "✓", label: "Ready" },
  needsSetup: { mark: "!", label: "Needs setup" },
  missing: { mark: "–", label: "Missing" },
  unknown: { mark: "?", label: "Unknown" },
};

/**
 * What the project and this machine have for skills and agents to read
 * through, as a checklist: the PM's sources, the allowlisted CLIs, the
 * configured MCP servers, and the Claude account's connectors. It reads
 * the cached checklist when first shown; Check again reads the machine anew.
 */
export function ToolsChecklist(props: {
  tools: PmToolsReadResult | undefined;
  now: number;
  onRead(refresh: boolean): Promise<void>;
}) {
  const [reading, setReading] = useState(false);
  const read = async (refresh: boolean) => {
    setReading(true);
    await props.onRead(refresh);
    setReading(false);
  };
  useEffect(() => {
    if (props.tools === undefined) void read(false);
  }, [props.tools === undefined]);
  if (props.tools === undefined) return <p className="hint">{reading ? "Checking this machine…" : "Not checked yet."}</p>;
  const tools = props.tools.tools;
  return (
    <div className="tools-checklist">
      {GROUPS.map((group) => {
        const items = tools.filter((tool) => tool.kind === group.kind);
        if (items.length === 0) return null;
        return (
          <section key={group.kind} className="tool-group" aria-label={group.label}>
            <span className="sec-label">{group.label}</span>
            {group.note && <p className="hint">{group.note}</p>}
            <ul>{items.map((tool) => <ToolRow key={`${tool.kind}:${tool.name}`} tool={tool} />)}</ul>
          </section>
        );
      })}
      <div className="tools-foot">
        <span className="meta">Checked {relativeTime(props.tools.readAtEpochMs, props.now)}</span>
        <span className="sp" />
        <button type="button" className="btn sm ghost" disabled={reading} onClick={() => void read(true)}>
          <Icon name="refresh" />{reading ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  );
}

function ToolRow({ tool }: { tool: PmTool }) {
  const { mark, label } = MARKS[tool.state];
  return (
    <li className={`tool-row ${tool.state}`}>
      <span className="tool-mark" role="img" aria-label={label} title={label}>{mark}</span>
      <span className="tool-name">{tool.name}</span>
      <span className="tool-detail">{tool.detail}</span>
    </li>
  );
}
