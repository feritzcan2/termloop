import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fixtureWorkflowProgress } from "../src/fixtures/workflow-progress";

const require = createRequire(import.meta.url);
type Component = typeof import("../src/features/workflows/workflow-execution-card").WorkflowExecutionCard;
type Props = Parameters<Component>[0];
type NodeProps = Record<string, any>;
function propsForCard(): Props {
  const fixture = fixtureWorkflowProgress(1_700_000_000_000);
  return { ...fixture, online: true, agentDataStale: false, checkedAt: 1_700_000_000_000, refreshing: false, error: undefined, refresh: vi.fn(), openSession: vi.fn() };
}

describe("workflow progress interactions", () => {
  it("expands active steps by default while keeping every other step inspectable", async () => {
    const h = await harness(), props = propsForCard();
    const active = find(h.render(props), (item) => item.accessibilityLabel?.startsWith("Step 3:"))!;
    expect(active.props.accessibilityState.expanded).toBe(true);
    const prior = find(h.render(props), (item) => item.accessibilityLabel?.startsWith("Step 1:"))!;
    expect(prior.props.accessibilityState.expanded).toBe(false);
    prior.props.onPress();
    expect(find(h.render(props), (item) => item.accessibilityLabel?.startsWith("Step 1:"))!.props.accessibilityState.expanded).toBe(true);
    active.props.onPress();
    expect(find(h.render(props), (item) => item.accessibilityLabel?.startsWith("Step 3:"))!.props.accessibilityState.expanded).toBe(false);
  });

  it("opens exact step conversations and exposes the currently working helper above the timeline", async () => {
    const h = await harness(), props = propsForCard();
    const element = find(h.render(props), (item) => item.agent?.id === "workflow-context" && item.label === "Claude")!;
    const link = (element.type as Function)(element.props);
    expect(link.props.disabled).toBe(false);
    link.props.onPress();
    expect(props.openSession).toHaveBeenCalledWith("workflow-context");
    find(h.render(props), (item) => item.label === "Open lead agent · Codex")!.props.onPress();
    expect(props.openSession).toHaveBeenLastCalledWith(props.execution.coordinatorSessionId);
  });

  it("keeps offline results readable, disables session navigation and refresh, and suppresses live attention claims", async () => {
    const h = await harness(), props = propsForCard(); props.online = false;
    props.statuses = props.statuses.map((status) => ({ ...status, status: "awaitingInput" }));
    const tree = h.render(props);
    expect(find(tree, (item) => item.message?.includes("Offline — showing saved progress"))).toBeDefined();
    expect(find(tree, (item) => item.children === "Needs your attention")).toBeUndefined();
    const agent = find(tree, (item) => item.agent?.id === "workflow-context" && item.label === "Claude")!;
    expect((agent.type as Function)(agent.props).props.disabled).toBe(true);
    expect(find(tree, (item) => item.label === "Refresh progress")!.props.disabled).toBe(true);
    find(tree, (item) => item.row?.index === 2 && typeof item.show === "function")!.props.show();
    expect(find(h.render(props), (item) => item.result?.reviewCycle === 1 && typeof item.close === "function")).toBeDefined();
  });

  it("pins an opened result while live updates replace that step’s outcome", async () => {
    const h = await harness(), props = propsForCard();
    const preview = find(h.render(props), (item) => item.row?.index === 2 && typeof item.show === "function")!;
    preview.props.show();
    props.execution = { ...props.execution, stepResults: props.execution.stepResults.map((result) => result.stepId === props.execution.steps[2]!.id ? { ...result, reviewCycle: 2, outcome: "approved", summary: "New result" } : result) };
    const sheet = find(h.render(props), (item) => typeof item.close === "function" && item.result)!;
    expect(sheet.props.result.reviewCycle).toBe(1);
    expect(sheet.props.result.summary).toContain("Two findings");
    const modal = (sheet.type as Function)(sheet.props);
    expect(modal.props.children.type).toBe("SafeAreaProvider");
    expect(find(modal, (item) => item.selectable === true)!.props.children).toContain("Two findings");
    modal.props.onRequestClose();
    expect(find(h.render(props), (item) => typeof item.close === "function" && item.result)).toBeUndefined();
  });

  it("keeps saved results on failed refresh and disables unavailable agent links", async () => {
    const h = await harness(), props = propsForCard();
    props.error = "network failed"; props.sessions = [];
    const tree = h.render(props);
    expect(find(tree, (item) => item.message?.includes("Updates are delayed"))).toBeDefined();
    expect(find(tree, (item) => item.row?.result)).toBeDefined();
    const agent = find(tree, (item) => item.agent?.id === "workflow-context" && item.label === "Lead agent")
      ?? find(tree, (item) => item.agent?.id === "workflow-context")!;
    expect((agent.type as Function)(agent.props).props.disabled).toBe(true);
    find(tree, (item) => item.label === "Refresh progress")!.props.onPress();
    expect(props.refresh).toHaveBeenCalledOnce();
  });
});

async function harness() {
  const slots: any[] = []; let cursor = 0;
  const react = { ...require("react"), useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; } };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/workflows/workflow-execution-card.tsx", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", "react-native-safe-area-context", "../../components/primitives", "../../components/screen"] });
  const module = { exports: {} as { WorkflowExecutionCard: Component } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return { Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value } };
    if (name === "react-native-safe-area-context") return { SafeAreaProvider: "SafeAreaProvider" };
    if (name.endsWith("/screen")) return { Screen: "Screen", ScreenHeader: "ScreenHeader" };
    if (name.endsWith("/primitives")) return { Banner: "Banner", StatePill: "StatePill" };
    return require(name);
  }, module, module.exports);
  return { render: (props: Props) => { cursor = 0; return module.exports.WorkflowExecutionCard(props); } };
}

function find(node: ReactNode, predicate: (props: NodeProps) => boolean): ReactElement<NodeProps> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (predicate(node.props)) return node;
  return find(node.props.children, predicate);
}
