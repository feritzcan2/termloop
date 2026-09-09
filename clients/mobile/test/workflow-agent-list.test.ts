import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../src/adapters/mock/mock-runtime";
import { fixtureProjects, fixtureTasks } from "../src/fixtures/mobile-overview";
import { fixtureWorkflowProgress } from "../src/fixtures/workflow-progress";
import { buildProjectOverview } from "../src/presentation/attention-overview";

const require = createRequire(import.meta.url);
type Components = typeof import("../src/features/workflows/workflow-agent-list");
type Props = Parameters<Components["WorkflowAgentList"]>[0];
type Snapshot = ReturnType<typeof import("../src/features/workflows/use-workflow-snapshot").useWorkflowSnapshot>;
type NodeProps = Record<string, any>;

describe("mobile workflow group presentation", () => {
  it("reads only the selected Mac and Project and keeps the supplied cluster order", async () => {
    const h = await harness();
    const tree = h.render();
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.props.templates, h.props.control, "mac-a", h.props.projectId, true);
    expect(h.props.renderCluster).toHaveBeenCalledTimes(h.props.clusters.length);
    expect(vi.mocked(h.props.renderCluster).mock.calls.map(([cluster]) => cluster.key)).toEqual(h.props.clusters.map((cluster) => cluster.key));
    const membership = vi.mocked(h.props.renderCluster).mock.calls[0]![1];
    expect(membership.size).toBe(3);
    expect(find(tree, (props) => props.message)).toBeUndefined();
  });

  it.each(["offline", "overviewStale", "readFailed"])("keeps workflow identity but marks %s data as last known", async (cause) => {
    const h = await harness();
    if (cause === "offline") h.props.online = false;
    if (cause === "overviewStale") h.props.agentDataStale = true;
    if (cause === "readFailed") h.snapshot.error = "Disconnected";
    h.render();
    const [, memberships, stale] = vi.mocked(h.props.renderCluster).mock.calls[0]!;
    expect(stale).toBe(true);
    const group = [...memberships.values()][0]!.group;
    const frame = h.components.WorkflowAgentGroupFrame({ group, stale, children: "Agent rows" });
    expect(find(frame, (props) => props.accessibilityRole === "header")!.props.accessibilityLabel).toContain("Last known: Running");
    expect(find(frame, (props) => props.testID)?.props.children).toContain("Agent rows");
  });

  it("states Workflow, full name, task and review-limit outcome in an accessible header without hiding member controls", async () => {
    const h = await harness();
    const frame = h.components.WorkflowAgentGroupFrame({ group: { executionId: "run-a", name: "All", taskTitle: "Payments", status: "Review limit reached", tone: "attention" }, stale: false, children: "Independent member controls" });
    expect(find(frame, (props) => props.testID)?.props.accessible).toBeUndefined();
    const header = find(frame, (props) => props.accessibilityRole === "header")!;
    expect(header.props.accessibilityLabel).toBe("Workflow · All · Payments · Review limit reached");
    expect(find(header, (props) => props.children === "WORKFLOW")).toBeDefined();
    expect(find(header, (props) => props.children === "All")).toBeDefined();
    const status = find(header, (props) => props.children === "Review limit reached")!;
    expect(status.props.numberOfLines).toBeUndefined(); // Long outcomes may wrap on narrow phones / large text.
  });

  it("keeps ordinary Agents usable while labels load or fail, and retries only the workflow read", async () => {
    const h = await harness();
    h.snapshot.snapshot = undefined; h.snapshot.loading = true;
    expect(find(h.render(), (props) => props.children === "Loading workflow labels…")).toBeDefined();
    expect(vi.mocked(h.props.renderCluster).mock.calls[0]![1].size).toBe(0);
    h.snapshot.loading = false; h.snapshot.error = "Network error";
    const banner = find(h.render(), (props) => props.message === "Workflow labels could not be loaded.")!;
    banner.props.onAction();
    expect(h.snapshot.refresh).toHaveBeenCalledOnce();
    h.props.online = false;
    expect(find(h.render(), (props) => props.message)?.props.action).toBeUndefined();
  });
});

async function harness() {
  const fixture = fixtureWorkflowProgress(1_700_000_000_000);
  const runtime = createMockRuntime();
  const snapshot: Snapshot = { snapshot: { configurations: [], executions: [fixture.execution], stateRevision: 1 }, loading: false, error: undefined, checkedAt: 1, refresh: vi.fn() };
  const read = vi.fn(() => snapshot);
  const props: Props = {
    connectionId: "mac-a", projectId: fixture.execution.projectId, online: true, agentDataStale: false,
    templates: runtime.workflowTemplates, control: runtime.control, sessions: fixture.sessions, tasks: fixtureTasks,
    clusters: buildProjectOverview({ projects: fixtureProjects, tasks: fixtureTasks, sessions: fixture.sessions, agentStatuses: fixture.statuses, stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {} }, fixture.execution.projectId).agentClusters,
    renderCluster: vi.fn(() => null),
  };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/workflows/workflow-agent-list.tsx", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", "../../components/primitives", "./use-workflow-snapshot"] });
  const module = { exports: {} as Components };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return { ...require("react"), useMemo: (create: () => unknown) => create() };
    if (name === "react-native") return { Text: "Text", View: "View", Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios ?? options.default }, StyleSheet: { create: (value: unknown) => value, hairlineWidth: 0.5 } };
    if (name.endsWith("/primitives")) return { Banner: "Banner", Card: "Card", CardDivider: "CardDivider" };
    if (name.endsWith("/use-workflow-snapshot")) return { useWorkflowSnapshot: read };
    return require(name);
  }, module, module.exports);
  return { props, snapshot, read, components: module.exports, render: () => module.exports.WorkflowAgentList(props) };
}

function find(node: ReactNode, predicate: (props: NodeProps) => boolean): ReactElement<NodeProps> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (predicate(node.props)) return node;
  return find(node.props.children, predicate);
}
