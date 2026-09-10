import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fixtureAgentStatuses, fixtureProjects, fixtureSessions, fixtureTasks } from "../src/fixtures/mobile-overview";
import { buildProjectOverview } from "../src/presentation/attention-overview";
import { emptyTerminalBuffer } from "../src/presentation/terminal-buffer";
import { DEFAULT_TERMINAL_STYLE } from "../src/presentation/terminal-screen";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;
const url = "https://example.atlassian.net/browse/KAN-321?focusedCommentId=42#comment-42";

describe("external link controls", () => {
  it("opens the original Jira URL and handles a browser failure without an unhandled rejection", async () => {
    const h = await harness("components/external-link.tsx");
    const link = h.module.JiraIssueLink({ url });
    expect(link.props.accessibilityLabel).toBe("Open KAN-321 in Jira");
    link.props.onPress();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(h.module.JiraIssueLink({ url: null })).toBeNull();
    h.openURL.mockRejectedValueOnce(new Error("Unavailable"));
    await h.module.openExternalLink(url);
    expect(h.alert).toHaveBeenCalledOnce();
    h.openURL.mockClear();
    await h.module.openExternalLink("file:///tmp/file");
    expect(h.openURL).not.toHaveBeenCalled();
  });

  it("makes a task's key independently reachable without opening its details or agent", async () => {
    const h = await harness("features/tasks/task-browser.tsx");
    const tasks = [{ ...fixtureTasks[0]!, jira_url: url }];
    const model = buildProjectOverview({ projects: fixtureProjects, tasks, sessions: fixtureSessions, agentStatuses: fixtureAgentStatuses, stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {} }, tasks[0]!.project_id);
    const openTask = vi.fn(), openAgent = vi.fn();
    const list = h.module.TaskBrowser({ rows: model.tasks, tasks, agents: model.agents, refreshing: false, refresh: vi.fn(), openTask, openAgent, openChanges: vi.fn(), openTemplates: vi.fn(), openSteward: vi.fn() });
    const card = expand(list.props.renderItem({ item: list.props.data[0] }));
    const nodes = all(card);
    const link = nodes.find((node) => node.props.accessibilityRole === "link")!;
    const details = nodes.find((node) => node.props.accessibilityHint === "Open task details")!;
    expect(nodes.some((node) => node.props.children === tasks[0]!.title)).toBe(true);
    expect(all(details).some((node) => node.props.accessibilityRole === "link")).toBe(false);
    link.props.onPress();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(openTask).not.toHaveBeenCalled();
    expect(openAgent).not.toHaveBeenCalled();
    details.props.onPress();
    expect(openTask).toHaveBeenCalledExactlyOnceWith(tasks[0]!.id);
  });

  it("keeps the redesigned task agent's Jira link independent from agent navigation and actions", async () => {
    const h = await harness("features/tasks/task-agent-row.tsx");
    const model = buildProjectOverview({ projects: fixtureProjects, tasks: fixtureTasks, sessions: fixtureSessions, agentStatuses: fixtureAgentStatuses, stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {} }, fixtureTasks[0]!.project_id);
    const row = model.agents.find((agent) => agent.taskId === fixtureTasks[0]!.id)!;
    const onPress = vi.fn(), onLongPress = vi.fn();
    const tree = expand(h.module.TaskAgentRow({ row, task: { ...fixtureTasks[0]!, jira_url: url }, age: "2m", onPress, onLongPress }));
    const nodes = all(tree);
    expect(nodes.some((node) => node.props.children === fixtureTasks[0]!.title)).toBe(true);
    expect(nodes.some((node) => node.props.children === row.title)).toBe(true);
    expect(nodes.some((node) => node.props.children === row.stateLabel)).toBe(true);
    const button = nodes.find((node) => node.props.accessibilityRole === "button")!;
    expect(all(button).some((node) => node.props.accessibilityRole === "link")).toBe(false);
    nodes.find((node) => node.props.accessibilityRole === "link")!.props.onPress();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(onPress).not.toHaveBeenCalled();
    button.props.onPress(); button.props.onLongPress();
    expect(onPress).toHaveBeenCalledOnce(); expect(onLongPress).toHaveBeenCalledOnce();
  });

  it.each(["stream", "pending", "screen"])("opens links in %s output only on tap", async (kind) => {
    const h = await harness("components/terminal-view.tsx");
    const buffer = { ...emptyTerminalBuffer(), ready: true };
    if (kind === "screen") buffer.screen = [{ id: 1, spans: [{ text: "Review", style: { ...DEFAULT_TERMINAL_STYLE, hyperlink: url } }] }];
    else if (kind === "pending") buffer.pending = `Open ${url}`;
    else buffer.lines = [{ id: 1, kind: "output", text: `Open ${url}` }];
    const tree = expand(h.module.TerminalView({ buffer, fontSizeIndex: 1, capNotice: undefined }));
    const link = all(tree).find((node) => node.props.accessibilityRole === "link")!;
    expect(link).toBeDefined();
    expect(h.openURL).not.toHaveBeenCalled();
    link.props.onPress();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
  });
});

async function harness(entry: string) {
  const openURL = vi.fn().mockResolvedValue(undefined), alert = vi.fn();
  const react = {
    ...require("react"), memo: (component: unknown) => component,
    useMemo: (create: () => unknown) => create(), useCallback: (callback: unknown) => callback,
    useEffect: () => {}, useLayoutEffect: () => {}, useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  };
  const native = {
    ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", FlatList: "FlatList", Text: "Text", TextInput: "TextInput", View: "View",
    Linking: { openURL }, Alert: { alert },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    Platform: { OS: "ios", select: (options: Props) => options.ios ?? options.default },
  };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime"] });
  const module = { exports: {} as Props };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => name === "react" ? react : name === "react-native" ? native : require(name), module, module.exports);
  return { module: module.exports, openURL, alert };
}

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Props>(node)) return node;
  if (typeof node.type === "function") return expand((node.type as Function)(node.props));
  return cloneElement(node, undefined, expand(node.props.children));
}

function all(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...all(node.props.children)];
}
