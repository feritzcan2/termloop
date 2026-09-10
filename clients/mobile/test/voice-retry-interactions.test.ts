import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProjects, fixtureTasks } from "../src/fixtures/mobile-overview";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

for (const kind of ["agent", "steward"] as const) describe(`${kind} voice retry controls`, () => {
  it("retains failed audio, retries without reopening the mic, and offers cancellation", async () => {
    const h = await harness(kind);
    h.transcribe.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValue("recovered transcript");
    await h.record(); await h.stop();
    const controls = h.retryControls()!;
    expect(controls.retryable).toBe(true);
    expect(controls.recordingSaved).toBe(true);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    await h.retry();
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(h.transcribe.mock.calls[1]![1]).toBe(h.transcribe.mock.calls[0]![1]);
    expect(h.stream.start).toHaveBeenCalledTimes(1);
    expect(h.transcript()).toBe("recovered transcript");
  });

  it("can cancel a failed recording and record a new one", async () => {
    const h = await harness(kind);
    h.transcribe.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValue("fresh transcript");
    await h.record(); await h.stop();
    h.cancel();
    expect(h.retryControls()?.retryable).not.toBe(true);
    await h.record(); await h.stop();
    expect(h.stream.start).toHaveBeenCalledTimes(2);
    expect(h.transcribe.mock.calls[1]![1]).not.toBe(h.transcribe.mock.calls[0]![1]);
    expect(h.transcript()).toBe("fresh transcript");
  });

  it("cancels an in-flight request and ignores its eventual reply", async () => {
    const h = await harness(kind);
    let resolve!: (value: string) => void;
    h.transcribe.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
    await h.record(); await h.stop();
    h.cancel();
    expect((h.transcribe.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
    resolve("old reply"); await tick(); h.render();
    expect(h.transcript()).toBeUndefined();
  });

  it("offers restart for a transient microphone failure but not for denied permission", async () => {
    const h = await harness(kind);
    h.stream.start.mockRejectedValueOnce(new Error("AVAudioSession !pri"));
    await h.record();
    expect(h.retryControls()).toMatchObject({ retryable: true, recordingSaved: false });
    await h.retry();
    expect(h.stream.start).toHaveBeenCalledTimes(2);
    await h.stop();
    h.cancel();
    h.permission.mockResolvedValue({ granted: false });
    await h.record();
    expect(h.retryControls()?.retryable).toBe(false);
    expect(h.stream.start).toHaveBeenCalledTimes(2);
  });
});

describe("Agent voice scope and connection", () => {
  it("preserves the recording when the terminal disconnects, allows stop and retry, and cancels on a new session", async () => {
    const h = await harness("agent");
    h.transcribe.mockRejectedValue(new TypeError("Network request failed"));
    await h.record();
    h.props.disabled = true; h.render();
    expect(h.mic().props.disabled).toBe(false); // Stopping remains possible offline.
    await h.stop();
    expect(h.retryControls()?.retryable).toBe(true);
    await h.retry();
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    h.props.sessionScope = "mac-a:another-session:1"; h.render();
    expect(h.retryControls()?.retryable).not.toBe(true);
  });
});

async function harness(kind: "agent" | "steward") {
  const hooks = hookHost(); cleanups.push(hooks.unmount);
  const transcribe = vi.fn().mockResolvedValue("transcript"), onTranscript = vi.fn();
  const permission = vi.fn().mockResolvedValue({ granted: true });
  let onBuffer: (buffer: unknown) => void = () => {};
  const stream = {
    isStreaming: false,
    start: vi.fn(async () => {
      stream.isStreaming = true;
      onBuffer({ data: new Float32Array(48_000).fill(0.25).buffer, sampleRate: 48_000, channels: 1 });
    }),
    stop: vi.fn(() => { stream.isStreaming = false; }),
  };
  const overview = { projects: fixtureProjects, tasks: fixtureTasks, sessions: [], agentStatuses: [], stewardEnabledProjectIds: [fixtureProjects[0]!.id], stewardExecutorSessionIds: {}, agentGroupsByProject: {} };
  const props = { connectionId: "mac-a", sessionScope: "mac-a:session-a:1", disabled: false, onBusyChange: vi.fn(), onTranscript };
  const overrides: Props = {
    react: hooks.react,
    "expo-audio": { AudioModule: { requestRecordingPermissionsAsync: permission }, setAudioModeAsync: vi.fn().mockResolvedValue(undefined), useAudioStream: (options: Props) => { onBuffer = options.onBuffer; return { stream }; } },
    "expo-router": { useGlobalSearchParams: () => ({}) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    "@/composition/runtime-context": { useMobileRuntime: () => ({ steward: { transcribeVoice: transcribe, commitVoice: vi.fn() } }) },
    "@/features/connection/connection-store": { useConnections: () => ({ connections: [{ id: "mac-a", name: "Mac" }], selectedId: "mac-a" }) },
    "@/features/overview/overview-store": { useOverview: () => ({ byConnection: new Map([["mac-a", { overview }]]) }) },
    "@/platform/steward-live-activity": { stewardLiveActivity: { end: async () => {} } },
  };
  const entry = kind === "agent" ? "features/terminal/agent-voice-button.tsx" : "components/steward-voice-dock.tsx";
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react-native", "react/jsx-runtime", ...Object.keys(overrides)] });
  const module = { exports: {} as Props };
  const native = { Text: "Text", View: "View", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator", KeyboardAvoidingView: "KeyboardAvoidingView", StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 }, Platform: { OS: "ios", select: (values: Props) => values.ios ?? values.default } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => overrides[name] ?? (name === "react-native" ? native : require(name)), module, module.exports);
  let tree: ReactNode;
  const render = () => {
    for (let pass = 0; pass < 10; pass += 1) {
      hooks.begin();
      tree = kind === "agent" ? module.exports.AgentVoiceButton(props) : module.exports.StewardVoiceDock();
      hooks.effects();
      if (!hooks.dirty()) return tree;
    }
    throw new Error("Voice component did not settle");
  };
  const controls = () => find(tree, (props) => typeof props.onToggleRecording === "function")!.props;
  const mic = () => find(tree, (props) => ["Kaydı bitir", "Agent mesajını sesle yaz"].includes(props.accessibilityLabel))!;
  const retryControls = () => kind === "agent" ? find(tree, (props) => typeof props.onRetry === "function")?.props : controls();
  render();
  if (kind === "steward") { controls().onStart(); render(); }
  const record = async () => { if (kind === "agent") mic().props.onPress(); else controls().onToggleRecording(); await tick(); render(); };
  const stop = record;
  const retry = async () => { retryControls()!.onRetry(); await tick(); render(); };
  const cancel = () => { if (kind === "agent") retryControls()?.onCancel(); else controls().onCancelRecording(); render(); };
  const transcript = () => kind === "agent" ? onTranscript.mock.calls.at(-1)?.[0] : (controls().draft || undefined);
  return { props, render, record, stop, retry, cancel, mic, retryControls, transcript, transcribe, stream, permission };
}

function hookHost() {
  const slots: any[] = [];
  let cursor = 0, changed = false;
  let effects: Array<() => void> = [];
  const same = (a: unknown[] | undefined, b: unknown[] | undefined) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: unknown[]) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  return {
    begin: () => { cursor = 0; changed = false; effects = []; },
    effects: () => effects.forEach((effect) => effect()), dirty: () => changed,
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
    react: {
      ...require("react"),
      useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
      useMemo: memo, useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
      useState: (initial: any) => {
        const index = cursor++;
        slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
        return [slots[index].value, (next: any) => { const value = typeof next === "function" ? next(slots[index].value) : next; if (!Object.is(value, slots[index].value)) { slots[index].value = value; changed = true; } }];
      },
      useEffect: (effect: () => (() => void) | undefined, deps?: unknown[]) => {
        const index = cursor++;
        if (slots[index] && same(slots[index].deps, deps)) return;
        effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      },
    },
  };
}

function find(node: ReactNode, predicate: (props: Props) => boolean): ReactElement<Props> | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } }
  if (!isValidElement<Props>(node)) return undefined;
  return predicate(node.props) ? node : find(node.props.children, predicate);
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
