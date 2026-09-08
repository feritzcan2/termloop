import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../src/adapters/mock/mock-runtime";
import { WorkflowLaunchUnconfirmedError } from "../src/application/workflow-launch-port";
import { fixtureTasks, fixtureSessions } from "../src/fixtures/mobile-overview";
import { startingWorkflowSteps, workflowDraft } from "../src/presentation/workflow-template";

const require = createRequire(import.meta.url);
type Component = typeof import("../src/features/workflows/task-workflow-launcher").TaskWorkflowLauncher;
type Props = Parameters<Component>[0];
type NodeProps = Record<string, any>;
async function propsForTask(): Promise<Props> {
  const runtime = createMockRuntime();
  const task = { ...fixtureTasks[0]!, brief: "Implement the Task description" };
  await runtime.workflowTemplates.create("connection-local-mac", { ...workflowDraft(), name: "Build & review", steps: startingWorkflowSteps("reviewed"), projectId: task.project_id, expectedRevision: 1 });
  return { task, connectionId: "connection-local-mac", online: true, templates: runtime.workflowTemplates, launch: { start: vi.fn(async () => fixtureSessions[0]!) }, control: runtime.control, openTemplates: vi.fn(), openSession: vi.fn() };
}

describe("Task workflow quick launch", () => {
  it("prefills the description, auto-selects a template, and starts with one tap without duplicate commands", async () => {
    const h = await harness(), props = await propsForTask();
    await h.ready(props);
    expect(find(h.render(props), "Workflow goal")!.value).toBe(props.task.brief);
    expect(find(h.render(props), "Workflow template")!.value).toBe("mock-workflow-1");
    const start = find(h.render(props), "Start workflow")!.onPress;
    start(); start();
    expect(props.launch.start).toHaveBeenCalledOnce();
    expect(props.launch.start).toHaveBeenCalledWith(props.connectionId, { taskId: props.task.id, workflowId: "mock-workflow-1", goal: props.task.brief }, expect.objectContaining({ name: "Build & review" }));
    await vi.waitFor(() => expect(props.openSession).toHaveBeenCalledWith(fixtureSessions[0]!.id));
    expect(find(h.render(props), "Start workflow")).toBeUndefined();
    expect(find(h.render(props), "Open workflow agent")).toBeDefined();
  });

  it("uses the title until a description arrives and never overwrites an edited goal on refresh", async () => {
    const h = await harness(), props = await propsForTask();
    props.task = { ...props.task, brief: null };
    await h.ready(props);
    expect(find(h.render(props), "Workflow goal")!.value).toBe(props.task.title);
    props.task = { ...props.task, brief: "Late description" };
    expect(find(h.render(props), "Workflow goal")!.value).toBe("Late description");
    find(h.render(props), "Workflow goal")!.change("My custom goal");
    props.task = { ...props.task, brief: "Changed on Mac" };
    expect(find(h.render(props), "Workflow goal")!.value).toBe("My custom goal");
    find(h.render(props), "Workflow goal")!.change("");
    expect(find(h.render(props), "Start workflow")!.disabled).toBe(true);
    expect(find(h.render(props), "Workflow goal")!.value).toBe("");
  });

  it("keeps the goal offline and blocks closed or unready Tasks", async () => {
    const h = await harness(), props = await propsForTask();
    await h.ready(props);
    for (const next of [{ ...props, online: false }, { ...props, task: { ...props.task, status: "closed" as const } }, { ...props, task: { ...props.task, worktree: null } }]) {
      const button = find(h.render(next), "Start workflow")!;
      expect(button.disabled).toBe(true); button.onPress();
      expect(find(h.render(next), "Workflow goal")!.value).toBe(props.task.brief);
    }
    expect(props.launch.start).not.toHaveBeenCalled();
  });

  it("retains an ambiguous launch and never resubmits it when refreshing or tapping again", async () => {
    const h = await harness(), props = await propsForTask();
    props.launch.start = vi.fn(async () => { throw new WorkflowLaunchUnconfirmedError(); });
    await h.ready(props);
    find(h.render(props), "Start workflow")!.onPress();
    await vi.waitFor(() => expect(find(h.render(props), "Refresh workflows")).toBeDefined());
    find(h.render(props), "Refresh workflows")!.onPress();
    await h.ready(props);
    const button = find(h.render(props), "Start workflow")!;
    expect(button.disabled).toBe(true); button.onPress();
    expect(props.launch.start).toHaveBeenCalledOnce();
    expect(props.openSession).not.toHaveBeenCalled();
    expect(find(h.render(props), "Workflow goal")!.value).toBe(props.task.brief);
  });

  it("offers template creation when empty and reloads after returning from the editor", async () => {
    const h = await harness(), props = await propsForTask();
    const saved = await props.templates.list(props.connectionId, props.task.project_id);
    await props.templates.remove(props.connectionId, { workflowId: saved.configurations[0]!.id, expectedRevision: saved.stateRevision });
    await h.ready(props);
    find(h.render(props), "Create workflow template")!.onPress();
    expect(props.openTemplates).toHaveBeenCalledOnce();
    expect(find(h.render(props), "Start workflow")).toBeUndefined();
    await props.templates.create(props.connectionId, { ...workflowDraft(), name: "New phone template", steps: startingWorkflowSteps("simple"), projectId: props.task.project_id, expectedRevision: 3 });
    h.refocus(); await h.ready(props);
    expect(find(h.render(props), "Start workflow")!.disabled).toBe(false);
  });

  it("opens an existing running or paused workflow instead of starting another", async () => {
    for (const status of ["running", "paused"] as const) {
      const h = await harness(), props = await propsForTask();
      const snapshot = await props.templates.list(props.connectionId, props.task.project_id);
      props.templates.list = vi.fn(async () => ({ ...snapshot, executions: [{ id: "execution-a", projectId: props.task.project_id, taskId: props.task.id, workflowId: "mock-workflow-1", workflowGeneration: 1, goal: "Task goal", status, coordinatorSessionId: "existing-lead", workflowName: "Existing workflow", phase: "awaitingStepCompletion" as const, currentStepIndex: 0, reviewCycle: 0, maxReviewCycles: 2, completionOutcome: null, steps: snapshot.configurations[0]!.steps, participants: [], activeReviewStepIds: [], pendingReviewStepIds: [], stepResults: [], startedAtEpochMs: 1, updatedAtEpochMs: 1 }] }));
      await h.ready(props);
      expect(find(h.render(props), "Start workflow")).toBeUndefined();
      find(h.render(props), "Open workflow agent")!.onPress();
      expect(props.openSession).toHaveBeenCalledWith("existing-lead");
      expect(props.launch.start).not.toHaveBeenCalled();
    }
  });
});

// Native callbacks and effect cleanup with persistent hook state; device layout
// is checked separately in Simulator, not emulated by this test harness.
async function harness() {
  const slots: any[] = [];
  let cursor = 0, focusEffect: (() => void | (() => void)) | undefined, focusCleanup: void | (() => void);
  let queued: (() => void)[] = [];
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    ...require("react"),
    useRef(value: unknown) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }]; },
    useCallback(callback: unknown, deps: unknown[]) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback }; return slots[index].callback; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const index = cursor++; if (!same(slots[index]?.deps, deps)) { slots[index]?.cleanup?.(); slots[index] = { deps }; queued.push(() => { slots[index].cleanup = effect(); }); } },
  };
  const native = { ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value } };
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../src/features/workflows/task-workflow-launcher.tsx", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", "expo-router", "../../components/primitives", "../../application/workflow-launch-port", "../../platform/app-lifecycle"] });
  const module = { exports: {} as { TaskWorkflowLauncher: Component } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return native;
    if (name === "expo-router") return { useFocusEffect: (effect: () => void | (() => void)) => { if (focusEffect !== effect) { focusCleanup?.(); focusEffect = effect; queued.push(() => { focusCleanup = effect(); }); } } };
    if (name.endsWith("/app-lifecycle")) return { useAppLifecycle: () => ({ active: true, foregroundRevision: 0 }) };
    if (name.endsWith("/workflow-launch-port")) return { WorkflowLaunchUnconfirmedError };
    if (name.endsWith("/primitives")) return { Banner: "Banner", PrimaryButton: "PrimaryButton" };
    return require(name);
  }, module, module.exports);
  const render = (props: Props) => { cursor = 0; const tree = module.exports.TaskWorkflowLauncher(props); const effects = queued; queued = []; effects.forEach((effect) => effect()); return tree; };
  return { render, ready: async (props: Props) => { render(props); await new Promise((resolve) => setTimeout(resolve, 0)); render(props); }, refocus: () => { focusCleanup?.(); focusEffect = undefined; } };
}

function find(node: ReactNode, label: string): NodeProps | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, label); if (found) return found; } }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (node.props.label === label) return node.props;
  return find(node.props.children, label);
}
