import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MobileRuntime } from "../src/application/ports";
import type { ChangeReview } from "../src/features/changes/use-change-review";
import { createMockRuntime } from "../src/adapters/mock/mock-runtime";
import { fixtureSessions, fixtureTasks, fixtureTaskWorktreeChanges } from "../src/fixtures/mobile-overview";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;
const patch = "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,4 @@\n context\n-old\n+new\n+added\n tail\n";

describe("line feedback interaction", () => {
  it("keeps line numbers out of the diff while whole-row presses retain exact feedback addresses", async () => {
    const ui = await diffHarness();
    const onSelectLine = vi.fn();
    const tree = expand(ui.WorktreeDiff({ state: "patch", patch, review: { notedLines: new Set(["new:4"]), onSelectLine } }));
    byLabel(tree, "Comment on old line 3").props.onPress();
    byLabel(tree, "Edit feedback on new line 4").props.onPress();
    byLabel(tree, "Comment on new line 5").props.onPress();
    expect(onSelectLine.mock.calls).toEqual([
      [{ lineSide: "old", lineNumber: 3 }], [{ lineSide: "new", lineNumber: 4 }], [{ lineSide: "new", lineNumber: 5 }],
    ]);
    const texts = nodes(tree).filter((node) => node.type === "Text").map((node) => node.props.children);
    expect(texts).toContain("context");
    expect(texts).not.toContain(2);
    expect(texts).not.toContain(3);
    expect(texts).not.toContain(4);
    expect(texts).not.toContain(5);
    expect(texts.some((text) => typeof text === "string" && text.startsWith("@@"))).toBe(false);
    const row = byLabel(tree, "Comment on old line 3");
    expect(nodes(row).some((node) => node.type === "Text" && node.props.children === "old")).toBe(true);
  });

  it("shows section context without Git's line-range header", async () => {
    const ui = await diffHarness();
    const contextualPatch = patch.replace("@@ -2,3 +2,4 @@", "@@ -2,3 +2,4 @@ public record SessionData(");
    const tree = expand(ui.WorktreeDiff({ state: "patch", patch: contextualPatch }));
    const texts = nodes(tree).filter((node) => node.type === "Text").map((node) => node.props.children);
    expect(texts).toContain("public record SessionData(");
    expect(texts.some((text) => typeof text === "string" && text.includes("@@"))).toBe(false);
  });

  it("comments on unchanged full-file lines and keeps new numbers after deletions and chunk boundaries", async () => {
    const ui = await diffHarness();
    const onSelectLine = vi.fn();
    const source = ["first", "context", "old", "tail", ...Array.from({ length: 130 }, (_, index) => `rest ${index}`)].join("\n");
    const tree = expand(ui.WorktreeDiff({ state: "patch", patch, mode: "fullFile",
      preImage: { task_id: "task", entry_id: "entry", observation_id: "snapshot", state: "content", content: source, revision: "head" },
      review: { notedLines: new Set(["new:4"]), onSelectLine },
    }));
    byLabel(tree, "Comment on new line 1").props.onPress();
    byLabel(tree, "Edit feedback on new line 4").props.onPress();
    byLabel(tree, "Comment on new line 135").props.onPress();
    expect(onSelectLine.mock.calls).toEqual([
      [{ lineSide: "new", lineNumber: 1 }], [{ lineSide: "new", lineNumber: 4 }], [{ lineSide: "new", lineNumber: 135 }],
    ]);
    expect(nodes(tree).filter((node) => node.props.accessibilityLabel?.startsWith("Comment on old"))).toHaveLength(0);
    expect(byLabel(tree, "Comment on new line 1").props.children.join("")).toBe("+ first\n");
    expect(byLabel(tree, "Comment on new line 135").props.children.join("")).toBe("+ rest 129\n");
  });

  it("offers no line actions for unavailable or unparseable patches", async () => {
    const ui = await diffHarness();
    for (const props of [{ state: "binary", patch: null }, { state: "patch", patch: "not a patch" }] as const) {
      const tree = expand(ui.WorktreeDiff({ ...props, review: { notedLines: new Set(), onSelectLine: vi.fn() } }));
      expect(nodes(tree).filter((node) => node.props.onPress)).toHaveLength(0);
    }
  });
});

it("gives the Changes modal its own safe-area root and a compact file subtitle", async () => {
  const hooks = hookState();
  const runtime = createMockRuntime();
  const task = fixtureTasks[0]!;
  const connection = (await runtime.connections.list())[0]!;
  const route = await load<typeof import("../src/app/task/[taskId]/changes")>("../src/app/task/[taskId]/changes.tsx", {
    react: hooks.react,
    "expo-router": { useLocalSearchParams: () => ({ taskId: task.id, connectionId: connection.id }) },
    "react-native-safe-area-context": { SafeAreaProvider: "SafeAreaProvider" },
    "@/components/screen": { Screen: "Screen", ScreenHeader: "ScreenHeader" },
    "@/components/worktree-diff": { WorktreeDiff: "WorktreeDiff" },
    "@/components/change-review": { ChangeReviewEditor: "ChangeReviewEditor", ChangeReviewPanel: "ChangeReviewPanel" },
    "@/composition/runtime-context": { useMobileRuntime: () => runtime },
    "@/features/connection/connection-store": { useConnections: () => ({ selected: connection, selectedId: connection.id, select: vi.fn() }) },
    "@/features/overview/overview-store": { useOverview: () => ({ overview: { tasks: [task], sessions: fixtureSessions } }) },
  });
  const render = () => {
    hooks.begin();
    const screen = route.default();
    return (screen.type as (props: Props) => ReactNode)(screen.props);
  };
  render();
  await vi.waitFor(() => expect(nodes(render()).some((node) => node.props.entry?.entry_id === fixtureTaskWorktreeChanges.entries[0]!.entry_id)).toBe(true));
  const row = nodes(render()).find((node) => node.props.entry && node.props.onSelect)!;
  row.props.onSelect();
  const sheet = nodes(render()).find((node) => node.props.onFullFileChange)!;
  const modal = (sheet.type as (props: Props) => ReactElement<Props>)(sheet.props);
  expect(modal.type).toBe("Modal");
  expect(modal.props.children.type).toBe("SafeAreaProvider");
  expect(modal.props.children.props.children.type).toBe("Screen");
  const header = nodes(modal).find((node) => node.type === "ScreenHeader")!;
  expect(header.props.subtitle).toBe("[taskId].tsx");
  expect(nodes(modal).some((node) => node.props.selectable && node.props.children === row.props.entry.display_path)).toBe(true);
  hooks.unmount();
});

describe("feedback batch state", () => {
  it("retains edits across files and snapshots without moving a comment to new content", async () => {
    const h = await hookHarness();
    const entry = fixtureTaskWorktreeChanges.entries[0]!;
    h.render().openLine("snapshot-a", entry, { lineSide: "new", lineNumber: 12 });
    h.render().updateDraft("First file");
    h.render().finishDraft();
    h.render().openLine("snapshot-a", fixtureTaskWorktreeChanges.entries[1]!, { lineSide: "old", lineNumber: 3 });
    h.render().updateDraft("Second file");
    h.render().finishDraft();
    h.render().openLine("snapshot-b", entry, { lineSide: "new", lineNumber: 12 });
    expect(h.render().draft?.body).toBe("");
    expect(h.render().notes.map((note) => note.body)).toEqual(["First file", "Second file"]);
    h.render().openLine("snapshot-a", entry, { lineSide: "new", lineNumber: 12 });
    expect(h.render().draft?.body).toBe("First file");
    h.render().updateDraft("Edited");
    expect(h.render().notes.map((note) => note.body)).toEqual(["Edited", "Second file"]);
    h.render().remove(h.render().notes[0]!.key);
    expect(h.render().draft).toBeUndefined();
    expect(h.render().notes.map((note) => note.body)).toEqual(["Second file"]);
  });

  it("locks duplicate submissions and edits, retains failed batches, and clears only on success", async () => {
    const h = await hookHarness();
    h.render().openLine("snapshot-a", fixtureTaskWorktreeChanges.entries[0]!, { lineSide: "new", lineNumber: 12 });
    h.render().updateDraft("Please change this");
    let reject!: (error: Error) => void;
    h.submit.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const first = h.render().send();
    await h.render().send();
    h.render().remove(h.render().notes[0]!.key);
    expect(h.submit).toHaveBeenCalledOnce();
    expect(h.render().notes).toHaveLength(1);
    reject(new Error("Offline"));
    await first;
    expect(h.render().notes).toHaveLength(1);
    expect(h.render().error).toContain("Offline");
    await h.render().send();
    expect(h.render().notes).toHaveLength(0);
    expect(h.render().sent).toBe(true);
    expect(h.render().sending).toBe(false);
    expect(h.submit.mock.calls[0]![4]).toContain("Please change this");
  });

  it("requires a choice for multiple agents and aborts delivery when the Task screen unmounts", async () => {
    const h = await hookHarness(true);
    h.render().openLine("snapshot", fixtureTaskWorktreeChanges.entries[0]!, { lineSide: "new", lineNumber: 1 });
    h.render().updateDraft("Feedback");
    await h.render().send();
    expect(h.submit).not.toHaveBeenCalled();
    h.render().setTargetId("another-agent");
    let finish!: () => void;
    h.submit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const sending = h.render().send();
    expect(h.submit.mock.calls[0]![3].id).toBe("another-agent");
    h.unmount();
    expect(h.submit.mock.calls[0]![5].aborted).toBe(true);
    finish();
    await sending;
    expect(h.render().notes).toHaveLength(1);
  });
});

async function diffHarness() {
  return await load<typeof import("../src/components/worktree-diff")>("../src/components/worktree-diff.tsx", {
    react: { ...require("react"), useMemo: (factory: () => unknown) => factory() },
    "react-native-diff-view": require("react-native-diff-view/dist/utils/parse"),
  });
}

async function hookHarness(multipleAgents = false) {
  const hooks = hookState();
  const submit = vi.fn<typeof import("../src/features/changes/submit-change-review").submitChangeReview>().mockResolvedValue(undefined);
  const module = await load<typeof import("../src/features/changes/use-change-review")>("../src/features/changes/use-change-review.ts", {
    react: hooks.react, "./submit-change-review": { submitChangeReview: submit },
  });
  const runtime: MobileRuntime = createMockRuntime();
  const task = structuredClone(fixtureTasks[0]!);
  const sessions = [...fixtureSessions];
  if (multipleAgents) {
    sessions.push({ ...sessions[0]!, id: "another-agent" });
    task.worktree_presence!.attached_sessions.push({ session_id: "another-agent", kind: "Agent" });
  }
  return { submit, unmount: hooks.unmount, render: (): ChangeReview => {
    hooks.begin();
    return module.useChangeReview(runtime, "mac-a", task, sessions);
  } };
}

function hookState() {
  const slots: any[] = [];
  const cleanups: Array<() => void> = [];
  let cursor = 0;
  return { begin: () => { cursor = 0; }, unmount: () => cleanups.forEach((cleanup) => cleanup()), react: {
    ...require("react"),
    useCallback: (callback: unknown) => callback,
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (next: any) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef: (initial: any) => slots[cursor++] ??= { current: initial },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => (() => void) | undefined) => {
      const index = cursor++;
      if (slots[index]) return;
      slots[index] = true;
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    },
  } };
}

async function load<T>(path: string, overrides: Record<string, unknown>): Promise<T> {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", ...Object.keys(overrides)] });
  const native = { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", Modal: "Modal", KeyboardAvoidingView: "KeyboardAvoidingView", ActivityIndicator: "ActivityIndicator", RefreshControl: "RefreshControl",
    Platform: { OS: "ios", select: (values: Props) => values.ios ?? values.default },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 } };
  const module = { exports: {} as T };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (name: string) => overrides[name] ?? (name === "react-native" ? native : require(name)), module, module.exports,
  );
  return module.exports;
}

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement<Props>(node)) return node;
  if (typeof node.type === "function") return expand((node.type as (props: Props) => ReactNode)(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

function nodes(node: ReactNode): Array<ReactElement<Props>> {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}

function byLabel(tree: ReactNode, label: string): ReactElement<Props> {
  const found = nodes(tree).find((node) => node.props.accessibilityLabel === label);
  expect(found, label).toBeDefined();
  return found!;
}
