import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowConfigurationDto } from "@termloop/contract/current";
import { fixtureAgentCapabilities } from "../src/fixtures/mobile-overview";
import { startingWorkflowSteps, workflowDraft } from "../src/presentation/workflow-template";
import { WorkflowMutationUnconfirmedError } from "../src/application/workflow-templates-port";

const require = createRequire(import.meta.url);
type Editor = typeof import("../src/features/workflows/workflow-editor").WorkflowEditor;
type Props = Parameters<Editor>[0];
type NodeProps = Record<string, any>;
const baseProps = (): Props => ({ configuration: undefined, currentConfiguration: undefined, online: true, catalog: { capabilities: fixtureAgentCapabilities, profiles: [] }, close: vi.fn(), save: vi.fn(async () => {}), remove: vi.fn(async () => {}) });
const saved = (): WorkflowConfigurationDto => ({ ...workflowDraft(), name: "Desktop review", steps: startingWorkflowSteps("discussed"), id: "workflow-1", projectId: "project-1", generation: 1, updatedAtEpochMs: 1 });

describe("workflow editor interactions", () => {
  it("blocks another mutation after an unconfirmed response while keeping the draft", async () => {
    const harness = await editorHarness();
    const props = baseProps();
    props.save = vi.fn(async () => { throw new WorkflowMutationUnconfirmedError(); });
    find(harness.render(props), (item) => item.accessibilityLabel === "Start simple")!.onPress();
    find(harness.render(props), (item) => item.label === "Template name")!.change("Keep this draft");
    find(harness.render(props), (item) => item.label === "Create template")!.onPress();
    await vi.waitFor(() => expect(find(harness.render(props), (item) => item.message?.includes("did not confirm"))).toBeDefined());
    expect(find(harness.render(props), (item) => item.label === "Create template")!.disabled).toBe(true);
    find(harness.render(props), (item) => item.label === "Create template")!.onPress();
    expect(props.save).toHaveBeenCalledOnce();
    expect(find(harness.render(props), (item) => item.label === "Template name")!.value).toBe("Keep this draft");
  });

  it("opens each newly added step and gives its native modal a safe-area root", async () => {
    const harness = await editorHarness();
    const props = baseProps();
    const tree = harness.render(props);
    expect(tree.props.children.type).toBe("SafeAreaProvider");
    find(tree, (item) => item.accessibilityLabel === "Start simple")!.onPress();
    find(harness.render(props), (item) => item.label === "+ Discussion")!.onPress();
    expect(find(harness.render(props), (item) => item.accessibilityLabel === "Edit step 1: Discuss")!.accessibilityState.expanded).toBe(true);
  });
  it("separates new creation from saved editing and confirms unsaved close", async () => {
    const harness = await editorHarness();
    const props = baseProps();
    let tree = harness.render(props);
    expect(find(tree, (item) => item.title === "New template")).toBeDefined();
    expect(find(tree, (item) => item.label === "Template name")).toBeUndefined();
    find(tree, (item) => item.accessibilityLabel === "Build & review")!.onPress();
    tree = harness.render(props);
    expect(find(tree, (item) => item.label === "Template name")!.value).toBe("");
    expect(find(tree, (item) => item.label === "Create template")).toBeDefined();
    find(tree, (item) => item.label === "Close")!.onPress();
    tree = harness.render(props);
    expect(props.close).not.toHaveBeenCalled();
    find(tree, (item) => item.label === "Keep editing")!.onPress();
    tree = harness.render(props);
    expect(find(tree, (item) => item.label === "Discard changes")).toBeUndefined();
    find(tree, (item) => item.label === "Close")!.onPress();
    find(harness.render(props), (item) => item.label === "Discard changes")!.onPress();
    expect(props.close).toHaveBeenCalledOnce();
  });

  it("validates before saving, trims the name, and suppresses double taps", async () => {
    const harness = await editorHarness();
    const props = baseProps();
    let finish!: () => void;
    props.save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    find(harness.render(props), (item) => item.accessibilityLabel === "Start simple")!.onPress();
    find(harness.render(props), (item) => item.label === "Create template")!.onPress();
    expect(props.save).not.toHaveBeenCalled();
    expect(find(harness.render(props), (item) => item.message?.includes("name before saving"))).toBeDefined();
    find(harness.render(props), (item) => item.label === "Template name")!.change("  Phone workflow  ");
    const save = find(harness.render(props), (item) => item.label === "Create template")!.onPress;
    save(); save();
    expect(props.save).toHaveBeenCalledOnce();
    expect(props.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Phone workflow" }), undefined);
    expect(find(harness.render(props), (item) => item.label === "Saving…")!.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(props.close).toHaveBeenCalledOnce());
  });

  it("preserves offline and failed drafts and requires an explicit stale-version reload", async () => {
    const harness = await editorHarness();
    const configuration = saved();
    const props = { ...baseProps(), configuration, currentConfiguration: configuration };
    find(harness.render(props), (item) => item.label === "Template name")!.change("My local edit");
    expect(find(harness.render({ ...props, online: false }), (item) => item.label === "Save changes")!.disabled).toBe(true);
    props.save = vi.fn(async () => { throw new Error("connection failed"); });
    find(harness.render(props), (item) => item.label === "Save changes")!.onPress();
    await vi.waitFor(() => expect(find(harness.render(props), (item) => item.message === "connection failed")).toBeDefined());
    expect(find(harness.render(props), (item) => item.label === "Template name")!.value).toBe("My local edit");
    expect(props.close).not.toHaveBeenCalled();
    const changed = { ...props, currentConfiguration: { ...configuration, name: "Changed on Mac", generation: 2 } };
    expect(find(harness.render(changed), (item) => item.label === "Save changes")!.disabled).toBe(true);
    find(harness.render(changed), (item) => item.label === "Load saved version")!.onPress();
    expect(find(harness.render(changed), (item) => item.label === "Template name")!.value).toBe("Changed on Mac");
    expect(find(harness.render({ ...props, currentConfiguration: undefined }), (item) => item.label === "Save changes")!.disabled).toBe(true);
  });

  it("deletes only after confirmation and keeps implementation mandatory", async () => {
    const harness = await editorHarness();
    const configuration = saved();
    const props = { ...baseProps(), configuration, currentConfiguration: configuration };
    const implementation = configuration.steps.find((step) => step.kind === "implement")!;
    find(harness.render(props), (item) => item.accessibilityLabel === `Edit step 2: ${implementation.title}`)!.onPress();
    expect(find(harness.render(props), (item) => item.label === "Remove step")).toBeUndefined();
    find(harness.render(props), (item) => item.label === "Delete template…")!.onPress();
    expect(props.remove).not.toHaveBeenCalled();
    find(harness.render(props), (item) => item.label === "Delete template")!.onPress();
    expect(props.remove).toHaveBeenCalledWith(1);
    await vi.waitFor(() => expect(props.close).toHaveBeenCalledOnce());
  });
});

// Exercise native component callbacks with persistent hook state. Native layout
// is verified separately in the simulator; this harness does not emulate Fabric.
async function editorHarness() {
  const slots: unknown[] = [];
  let cursor = 0;
  const react = {
    ...require("react"),
    useRef: (value: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index]; },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
  };
  const native = { KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (value: unknown) => value }, Platform: { OS: "ios", select: (values: { ios: unknown }) => values.ios } };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/features/workflows/workflow-editor.tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-native", "react/jsx-runtime", "react-native-safe-area-context", "../../components/screen", "../../components/primitives", "../../application/workflow-templates-port"],
  });
  const module = { exports: {} as { WorkflowEditor: Editor } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return native;
    if (name === "react-native-safe-area-context") return { SafeAreaProvider: "SafeAreaProvider" };
    if (name.endsWith("/workflow-templates-port")) return { WorkflowMutationUnconfirmedError };
    if (name.endsWith("/screen")) return { Screen: "Screen", ScreenHeader: "ScreenHeader" };
    if (name.endsWith("/primitives")) return { Banner: "Banner", PrimaryButton: "PrimaryButton" };
    return require(name);
  }, module, module.exports);
  return { render: (props: Props) => { cursor = 0; return module.exports.WorkflowEditor(props); } };
}

function find(node: ReactNode, predicate: (props: NodeProps) => boolean): NodeProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  }
  if (!isValidElement<NodeProps>(node)) return undefined;
  if (predicate(node.props)) return node.props;
  return find(node.props.children, predicate) ?? find(node.props.right, predicate);
}
