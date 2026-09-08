import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../src/adapters/mock/mock-runtime";
import type { AgentLaunchSelection } from "../src/application/ports";
import { fixtureProjects, fixtureTasks } from "../src/fixtures/mobile-overview";
import * as presentation from "../src/presentation/agent-launch-presentation";
import * as tokens from "../src/theme/tokens";

const require = createRequire(import.meta.url);
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
type NodeProps = Record<string, any>;
const saved: AgentLaunchSelection = {
  agentId: "codex", model: "gpt-6-astra", permission: "plan", reasoning: "high",
};

describe("Start agent", () => {
  it("opens with the last successful choices collapsed and expands only on Edit", async () => {
    const h = await harness();
    await h.ready();
    expect(find(h.render(), "Edit launch settings")?.accessibilityState.expanded).toBe(false);
    expect(find(h.render(), "Model")).toBeUndefined();
    expect(find(h.render(), "Preview launch details")).toBeUndefined();
    expect(find(h.render(), "Start agent")?.disabled).toBe(false);
    expect(h.preferences.write).not.toHaveBeenCalled();

    find(h.render(), "Edit launch settings")!.onPress();
    expect(find(h.render(), "Model")?.value).toBe(saved.model);
    expect(find(h.render(), "Permission")?.value).toBe(saved.permission);
    expect(find(h.render(), "Reasoning")?.value).toBe(saved.reasoning);
    find(h.render(), "Model")!.onChange("gpt-5.6-sol");
    expect(h.preferences.write).not.toHaveBeenCalled();
    find(h.render(), "Edit launch settings")!.onPress();
    expect(find(h.render(), "Model")).toBeUndefined();

    find(h.render(), "Start agent")!.onPress();
    await vi.waitFor(() => expect(h.router.replace).toHaveBeenCalledOnce());
    expect(h.preferences.write).toHaveBeenCalledWith({ ...saved, model: "gpt-5.6-sol" });
  });

  it.each([false, true])("previews the latest prompt then launches once, including on rapid taps (Project: %s)", async (project) => {
    const h = await harness(project);
    await h.ready();
    find(h.render(), "First message for the new agent")!.onChangeText("First draft");
    find(h.render(), "First message for the new agent")!.onChangeText("Final\nprompt");
    const preview = project ? h.runtime.agentLaunch.previewProject : h.runtime.agentLaunch.preview;
    const launch = project ? h.runtime.agentLaunch.launchProject : h.runtime.agentLaunch.launch;
    const start = find(h.render(), "Start and send")!.onPress;
    start(); start();
    await vi.waitFor(() => expect(h.router.replace).toHaveBeenCalledOnce());
    expect(preview).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledWith(
      "connection-local-mac", project ? fixtureProjects[0] : fixtureTasks[0]!.id, saved, "Final\nprompt",
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(vi.mocked(launch).mock.calls[0]?.at(-1)).toBe("Final\nprompt");
    expect(h.preferences.write).toHaveBeenCalledWith(saved);
    start();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("invalidates an inspected ticket when the first message changes", async () => {
    const h = await harness(true);
    await h.ready();
    find(h.render(), "First message for the new agent")!.onChangeText("Old prompt");
    find(h.render(), "Edit launch settings")!.onPress();
    find(h.render(), "Preview launch details")!.onPress();
    await vi.waitFor(() => expect(find(h.render(), "Start and send")?.disabled).toBe(false));
    expect(h.runtime.agentLaunch.previewProject).toHaveBeenCalledOnce();
    find(h.render(), "First message for the new agent")!.onChangeText("New prompt");
    find(h.render(), "Start and send")!.onPress();
    await vi.waitFor(() => expect(h.router.replace).toHaveBeenCalledOnce());
    expect(h.runtime.agentLaunch.previewProject).toHaveBeenCalledTimes(2);
    expect(h.runtime.agentLaunch.previewProject).toHaveBeenLastCalledWith(
      "connection-local-mac", fixtureProjects[0], saved, "New prompt",
    );
  });

  it("keeps the prompt and previous preferences when launch fails without automatically retrying", async () => {
    const h = await harness();
    vi.mocked(h.runtime.agentLaunch.launch).mockRejectedValue(new Error("Launch unconfirmed"));
    await h.ready();
    find(h.render(), "First message for the new agent")!.onChangeText("Keep this draft");
    find(h.render(), "Edit launch settings")!.onPress();
    find(h.render(), "Permission")!.onChange("acceptEdits");
    find(h.render(), "Start and send")!.onPress();
    await vi.waitFor(() => expect(find(h.render(), "Start and send")?.disabled).toBe(false));
    expect(h.runtime.agentLaunch.launch).toHaveBeenCalledOnce();
    expect(find(h.render(), "First message for the new agent")!.value).toBe("Keep this draft");
    expect(h.preferences.write).not.toHaveBeenCalled();
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("reserves a new ticket after editing a previously inspected model", async () => {
    const h = await harness();
    await h.ready();
    find(h.render(), "Edit launch settings")!.onPress();
    find(h.render(), "Preview launch details")!.onPress();
    await vi.waitFor(() => expect(find(h.render(), "Start agent")?.disabled).toBe(false));
    find(h.render(), "Model")!.onChange("gpt-5.6-sol");
    find(h.render(), "Start agent")!.onPress();
    await vi.waitFor(() => expect(h.router.replace).toHaveBeenCalledOnce());
    expect(h.runtime.agentLaunch.preview).toHaveBeenCalledTimes(2);
    expect(h.runtime.agentLaunch.preview).toHaveBeenLastCalledWith(
      "connection-local-mac", fixtureTasks[0]!.id, { ...saved, model: "gpt-5.6-sol" }, "",
    );
  });
});

// Exercise the route's actual callbacks and memoized dependencies with native
// presentation mocked. This does not emulate device layout or provider startup.
async function harness(project = false) {
  const runtime = createMockRuntime();
  vi.spyOn(runtime.agentLaunch, "preview");
  vi.spyOn(runtime.agentLaunch, "previewProject");
  vi.spyOn(runtime.agentLaunch, "launch");
  vi.spyOn(runtime.agentLaunch, "launchProject");
  const preferences = { read: vi.fn(async () => saved), write: vi.fn(async (_selection: AgentLaunchSelection) => {}) };
  const router = { replace: vi.fn(), back: vi.fn() };
  const connections = { selectedId: "connection-local-mac", selected: { id: "connection-local-mac" }, select: vi.fn() };
  const overview = { overview: { tasks: fixtureTasks, projects: fixtureProjects }, refresh: vi.fn(), load: "ready" };
  const slots: any[] = [];
  let cursor = 0;
  let queued: (() => void)[] = [];
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (create: () => unknown, deps: unknown[]) => {
    const index = cursor++;
    if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: create() };
    return slots[index].value;
  };
  const react = {
    ...require("react"),
    useRef(value: unknown) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useMemo: memo,
    useCallback(callback: unknown, deps: unknown[]) { return memo(() => callback, deps); },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) {
        slots[index]?.cleanup?.();
        slots[index] = { deps };
        queued.push(() => { slots[index].cleanup = effect(); });
      }
    },
  };
  const native = {
    ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView", Pressable: "Pressable",
    ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View",
    StyleSheet: { create: (value: unknown) => value }, Keyboard: { dismiss() {} }, Platform: { OS: "ios" },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/app/launch/[taskId].tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-native", "react/jsx-runtime", "expo-router", "@/*"],
  });
  const module = { exports: {} as { default: () => ReactNode } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return native;
    if (name === "expo-router") return {
      useRouter: () => router,
      useLocalSearchParams: () => ({ taskId: project ? "project:" + fixtureProjects[0]!.id : fixtureTasks[0]!.id }),
    };
    if (name === "@/components/primitives") return { Banner: "Banner", Card: "Card", CardDivider: "CardDivider", PrimaryButton: "PrimaryButton", SectionHeader: "SectionHeader" };
    if (name === "@/components/screen") return { Screen: "Screen", ScreenHeader: "ScreenHeader" };
    if (name === "@/composition/runtime-context") return { useMobileRuntime: () => runtime };
    if (name === "@/features/connection/connection-store") return { useConnections: () => connections };
    if (name === "@/features/overview/overview-store") return { useOverview: () => overview };
    if (name === "@/presentation/agent-launch-presentation") return presentation;
    if (name === "@/platform/agent-launch-preferences") return { agentLaunchPreferences: preferences };
    if (name === "@/platform/presentation") return { keyboardAvoidingBehavior: "padding" };
    if (name === "@/theme/tokens") return tokens;
    if (name === "@/theme/typography") return { fontFamily: { mono: "Menlo" }, text: { body: {}, muted: {} } };
    return require(name);
  }, module, module.exports);
  const render = () => {
    cursor = 0;
    const tree = module.exports.default();
    const effects = queued;
    queued = [];
    effects.forEach((effect) => effect());
    return tree;
  };
  cleanups.push(() => slots.forEach((slot) => slot?.cleanup?.()));
  return {
    runtime, preferences, router, render,
    ready: async () => { render(); await vi.waitFor(() => expect(find(render(), "Start agent")?.disabled).toBe(false)); },
  };
}

function find(node: ReactNode, label: string): NodeProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, label); if (found) return found; }
  }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (node.props.label === label || node.props.accessibilityLabel === label) return node.props;
  return find(node.props.children, label);
}
