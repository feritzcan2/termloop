import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import * as audioSession from "../src/platform/steward-voice-audio";
import * as tokens from "../src/theme/tokens";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

it("cleans speech after Expo releases the player without calling the released object", async () => {
  const h = await harness();
  await h.readAloud();
  expect(h.player.play).toHaveBeenCalledOnce();
  h.player.pause.mockClear();
  h.local.stop.mockClear();

  expect(h.unmount).not.toThrow();
  expect(h.released()).toBe(true);
  expect(h.player.pause).not.toHaveBeenCalled();
  expect(h.local.stop).toHaveBeenCalledOnce();
  expect(h.file.delete).toHaveBeenCalledOnce();
});

it("still pauses playback and deletes its file when the user stops speech", async () => {
  const h = await harness();
  await h.readAloud();
  h.player.pause.mockClear();
  await h.readAloud();
  expect(h.player.pause).toHaveBeenCalledOnce();
  expect(h.player.play).toHaveBeenCalledOnce();
  expect(h.file.delete).toHaveBeenCalledOnce();
  expect(h.speech).toHaveBeenCalledOnce();
});

it("does not request audio when the screen closes during audio session setup", async () => {
  const h = await harness();
  const setup = deferred<void>();
  h.configure.mockReturnValueOnce(setup.promise);
  const reading = h.readAloud();
  h.unmount();
  setup.resolve();
  await reading;
  expect(h.speech).not.toHaveBeenCalled();
  expect(h.player.play).not.toHaveBeenCalled();
});

it("ignores a remote audio response received after the screen closes", async () => {
  const h = await harness();
  const response = deferred<Uint8Array>();
  h.speech.mockReturnValueOnce(response.promise);
  const reading = h.readAloud();
  await vi.waitFor(() => expect(h.speech).toHaveBeenCalledOnce());
  h.unmount();
  response.resolve(new Uint8Array([1]));
  await reading;
  expect(h.file.write).not.toHaveBeenCalled();
  expect(h.player.replace).not.toHaveBeenCalled();
  expect(h.local.speak).not.toHaveBeenCalled();
});

it("does not start local fallback speech after closing during its audio setup", async () => {
  const h = await harness();
  const setup = deferred<void>();
  h.speech.mockRejectedValueOnce(new Error("Remote speech unavailable"));
  h.configure.mockResolvedValueOnce(undefined).mockReturnValueOnce(setup.promise);
  const reading = h.readAloud();
  await vi.waitFor(() => expect(h.configure).toHaveBeenCalledTimes(2));
  h.unmount();
  setup.resolve();
  await reading;
  expect(h.local.speak).not.toHaveBeenCalled();
});

// Run the route callbacks with Expo's native ownership represented explicitly:
// its hook registers release before the consumer's passive unmount cleanup.
async function harness() {
  const slots: any[] = [];
  let cursor = 0;
  let queued: Array<() => void> = [];
  let released = false;
  let unmounted = false;
  const message = { id: "reply", author: "steward", sequence: 1, content: "Reply" };
  const speech = vi.fn(async (): Promise<Uint8Array> => new Uint8Array([1]));
  const runtime = { steward: { transcript: async () => [message], speech } };
  const local = { stop: vi.fn(), speak: vi.fn(async () => true) };
  const configure = vi.fn(async () => {});
  const file = { exists: true, uri: "file:///speech.mp3", write: vi.fn(), delete: vi.fn() };
  const player = {
    pause: vi.fn(() => { if (released) throw new Error("Unable to find the native shared object associated with given JavaScript object"); }),
    replace: vi.fn(), play: vi.fn(),
  };
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    ...require("react"),
    useRef(value: unknown) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value: unknown) => { slots[i] = value; }];
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, value: callback };
      return slots[i].value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        slots[i]?.cleanup?.();
        slots[i] = { deps };
        queued.push(() => { slots[i].cleanup = effect(); });
      }
    },
  };
  const native = {
    ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
    StyleSheet: { create: (value: unknown) => value },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/app/steward/[projectId].tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-native", "expo-*", "@/*"],
  });
  const module = { exports: {} as { default: () => ReactNode } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return native;
    if (name === "expo-audio") return {
      setAudioModeAsync: configure,
      useAudioPlayer: () => {
        react.useEffect(() => () => { released = true; }, []);
        return player;
      },
      useAudioPlayerStatus: () => ({ didJustFinish: false }),
    };
    if (name === "expo-file-system") return { File: function () { return file; }, Paths: { cache: "cache" } };
    if (name === "expo-router") return { useRouter: () => ({}), useLocalSearchParams: () => ({ projectId: "project" }) };
    if (name === "@/composition/runtime-context") return { useMobileRuntime: () => runtime };
    if (name === "@/features/connection/connection-store") return { useConnections: () => ({ selected: { id: "mac" } }) };
    if (name === "@/features/overview/overview-store") return { useOverview: () => ({}) };
    if (name === "@/components/primitives") return { Banner: "Banner", UnavailableNote: "UnavailableNote" };
    if (name === "@/components/screen") return { Screen: "Screen", ScreenHeader: "ScreenHeader" };
    if (name === "@/presentation/relative-time") return { relativeAge: () => "" };
    if (name === "@/platform/steward-local-speech") return { stewardLocalSpeech: local };
    if (name === "@/platform/steward-voice-audio") return audioSession;
    if (name === "@/theme/tokens") return tokens;
    if (name === "@/theme/typography") return { fontFamily: {}, text: {} };
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
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    slots.forEach((slot) => slot?.cleanup?.());
  };
  cleanups.push(unmount);
  render();
  await vi.waitFor(() => expect(bubble(render())).toBeDefined());
  return {
    player, local, file, speech, configure, unmount, released: () => released,
    readAloud: () => bubble(render())!.readAloud(message) as Promise<void>,
  };
}

function bubble(node: ReactNode): Props | undefined {
  if (Array.isArray(node)) return node.map(bubble).find(Boolean);
  if (!isValidElement<Props>(node)) return undefined;
  return node.props.readAloud ? node.props : bubble(node.props.children);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
