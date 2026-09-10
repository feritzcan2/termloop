import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fixtureProjects, fixtureTasks } from "../src/fixtures/mobile-overview";
import { fixtureWorkflowProgress } from "../src/fixtures/workflow-progress";
import * as overviewPresentation from "../src/presentation/attention-overview";
import * as workflowPresentation from "../src/presentation/workflow-agent-groups";
import * as connectionPresentation from "../src/presentation/connection-presentation";
import * as connectionRoute from "../src/features/connection/connection-route";
import * as relativeTime from "../src/presentation/relative-time";
import * as tokens from "../src/theme/tokens";

const require = createRequire(import.meta.url);
type NodeProps = Record<string, any>;

describe("Project Agents workflow integration", () => {
  it("shows the exact task title and Jira link on ordinary and workflow Agents without hiding either navigation", async () => {
    const h = await harness();
    const url = "https://example.atlassian.net/browse/KAN-321";
    h.store.overview.tasks[0]!.jira_url = url;
    const list = find(h.render(), (props) => typeof props.renderCluster === "function")!;
    const memberships = workflowPresentation.workflowAgentMemberships([h.execution], h.sessions, h.store.overview.tasks, h.projectId);
    const tree = expand(list.props.renderCluster(list.props.clusters[0], memberships, false));
    const frame = find(tree, (props) => props.group?.executionId === h.execution.id)!;
    expect(frame.props.group).toMatchObject({ taskTitle: fixtureTasks[0]!.title, jiraUrl: url });
    expect(find(frame, (props) => props.task !== undefined)).toBeUndefined();
    expect(find(tree, (props) => props.title === "Reviewer · Claude")).toBeDefined();
    const peer = find(tree, (props) => props.row?.title === "Peer")!;
    expect(peer.props.task).toMatchObject({ title: fixtureTasks[0]!.title, jira_url: url });
    expect(find(frame, (props) => props.row?.title === "Peer")).toBeUndefined();
    peer.props.onPress();
    expect(h.router.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/session/[sessionId]", params: { connectionId: "mac-a", sessionId: "peer" } });
    peer.props.onLongPress();
    expect(find(h.render(), (props) => props.visible === true && typeof props.onClose === "function")?.props.session.id).toBe("peer");
    h.store.overview.tasks = [];
    const withoutTask = expand(list.props.renderCluster(list.props.clusters[0], memberships, false));
    expect(find(withoutTask, (props) => props.task !== undefined)).toBeUndefined();
    expect(find(withoutTask, (props) => props.title === "Peer")).toBeDefined();
  });
  it("frames exact members inside a manual group and preserves each Agent's original navigation and actions", async () => {
    const h = await harness();
    const list = find(h.render(), (props) => typeof props.renderCluster === "function")!;
    expect(list.key).toBe(`mac-a:${h.projectId}`);
    const memberships = workflowPresentation.workflowAgentMemberships([h.execution], h.sessions, fixtureTasks, h.projectId);
    const tree = expand(list.props.renderCluster(list.props.clusters[0], memberships, false));
    const frame = find(tree, (props) => props.group?.executionId === h.execution.id)!;
    expect(frame).toBeDefined();
    expect(frame.props.stale).toBe(false);
    expect(find(tree, (props) => props.children === "Review crew")).toBeDefined();
    expect(find(frame, (props) => props.title === "Ordinary helper")).toBeUndefined();
    const helper = find(frame, (props) => props.title === "Reviewer · Claude")!;
    expect(helper.props.accessibleName).toContain(`Workflow ${h.execution.workflowName}`);
    helper.props.onPress();
    expect(h.dismissReview).toHaveBeenCalledExactlyOnceWith(h.sessions[1]!.id);
    expect(h.router.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/session/[sessionId]", params: { connectionId: "mac-a", sessionId: h.sessions[1]!.id } });
    helper.props.onLongPress();
    expect(find(h.render(), (props) => props.visible === true && typeof props.onClose === "function")?.props.session.id).toBe(h.sessions[1]!.id);
  });

  it("rekeys the workflow snapshot reader across Mac/Project changes and hides the previous Mac while selection catches up", async () => {
    const h = await harness();
    h.params.connectionId = "mac-b";
    expect(find(h.render(), (props) => typeof props.renderCluster === "function")).toBeUndefined();
    h.connections.selectedId = "mac-b";
    expect(find(h.render(), (props) => typeof props.renderCluster === "function")?.key).toBe(`mac-b:${h.projectId}`);
    h.params.projectId = "another-project";
    // An unknown Project has no agents, so it must not retain the previous reader.
    expect(find(h.render(), (props) => typeof props.renderCluster === "function")).toBeUndefined();
  });

  it("keeps stopped workflow Agents on the existing recovery path, never launches or resumes automatically", async () => {
    const h = await harness();
    h.sessions[1] = { ...h.sessions[1]!, lifecycle_state: "stale", retryable: true };
    const list = find(h.render(), (props) => typeof props.renderCluster === "function")!;
    const memberships = workflowPresentation.workflowAgentMemberships([h.execution], h.sessions, fixtureTasks, h.projectId);
    const tree = expand(list.props.renderCluster(list.props.clusters[0], memberships, true));
    expect(find(tree, (props) => props.group?.executionId)?.props.stale).toBe(true);
    find(tree, (props) => props.title === "Reviewer · Claude")!.props.onPress();
    expect(h.router.push).not.toHaveBeenCalled();
    expect(find(h.render(), (props) => props.visible === true && typeof props.onClose === "function")?.props.session.id).toBe(h.sessions[1]!.id);
  });
});

async function harness() {
  const fixture = fixtureWorkflowProgress(1_700_000_000_000);
  const projectId = fixture.execution.projectId;
  const sessions = fixture.sessions.map((session, index) => ({ ...session, name: index === 0 ? fixture.execution.workflowName : index === 1 ? "Claude" : "Codex", ask_to_source_session_id: index === 0 ? null : fixture.execution.coordinatorSessionId }));
  sessions.push({ ...sessions[1]!, id: "ordinary", name: "Ordinary helper" }, { ...sessions[0]!, id: "peer", name: "Peer" });
  const params: { projectId: string; connectionId?: string } = { projectId, connectionId: "mac-a" };
  const connections = { selectedId: "mac-a", selected: { name: "Mac", availability: "online" }, select: vi.fn() };
  const dismissReview = vi.fn(), router = { push: vi.fn(), replace: vi.fn() };
  const tasks = fixtureTasks.map((task) => ({ ...task, ...(task.worktree_presence ? { worktree_presence: { ...task.worktree_presence, attached_sessions: [...task.worktree_presence.attached_sessions, { session_id: "peer", kind: "Agent" as const }], total_count: 2, agent_count: 2 } } : {}) }));
  const store = { overview: { projects: fixtureProjects, tasks, sessions, agentStatuses: fixture.statuses, stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: { [projectId]: [{ name: "Review crew", sessionIds: [sessions[0]!.id, "peer"] }] } }, reviewReadySessionIds: new Set(), dismissReview, refresh: vi.fn() };
  const slots: any[] = []; let cursor = 0;
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/app/project/[projectId].tsx", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", "expo-router", "@/*"] });
  const module = { exports: {} as { default(): ReactNode } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return { ...require("react"), useMemo: (create: () => unknown) => create(), useEffect: () => {}, useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: unknown) => { slots[index] = value; }]; } };
    if (name === "react-native") return { ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", Text: "Text", View: "View", StyleSheet: { create: (value: unknown) => value, hairlineWidth: 0.5 } };
    if (name === "expo-router") return { useLocalSearchParams: () => params, useRouter: () => router };
    if (name === "@/features/connection/connection-store") return { useConnections: () => connections };
    if (name === "@/features/overview/overview-store") return { useOverview: () => store };
    if (name === "@/composition/runtime-context") return { useMobileRuntime: () => ({ workflowTemplates: {}, control: {} }) };
    if (name === "@/presentation/attention-overview") return overviewPresentation;
    if (name === "@/presentation/workflow-agent-groups") return workflowPresentation;
    if (name === "@/presentation/connection-presentation") return connectionPresentation;
    if (name === "@/features/connection/connection-route") return connectionRoute;
    if (name === "@/presentation/relative-time") return relativeTime;
    if (name === "@/theme/tokens") return tokens;
    if (name === "@/theme/typography") return { fontFamily: { mono: "Menlo" } };
    if (name.startsWith("@/components/") || name.startsWith("@/features/")) return new Proxy({}, { get: (_target, property) => property });
    return require(name);
  }, module, module.exports);
  return { execution: fixture.execution, sessions, store, projectId, params, connections, router, dismissReview, render: () => { cursor = 0; return module.exports.default(); } };
}

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<NodeProps>(node)) return node;
  if (typeof node.type === "function") return expand((node.type as Function)(node.props));
  return cloneElement(node, undefined, expand(node.props.children));
}

function find(node: ReactNode, predicate: (props: NodeProps) => boolean): ReactElement<NodeProps> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (predicate(node.props)) return node;
  return find(node.props.children, predicate);
}
