import { lightTheme } from "../src/theme/tokens";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { emptyTerminalBuffer } from "../src/presentation/terminal-buffer";
import { TerminalSessionState } from "../src/features/terminal/terminal-session-state";
import { terminalGeometry } from "../src/theme/tokens";
import { scrollSequence, supportsTerminalWheel, terminalLiveSequence } from "../src/presentation/terminal-scroll";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;

afterEach(() => vi.unstubAllGlobals());

it("keeps scrolling older output after Codex pins a prompt header above the transcript", async () => {
  const state = new TerminalSessionState("mac", "pinned-header");
  const encoder = new TextEncoder();
  const height = terminalGeometry.lineHeights[1]!;
  let olderRows = 0;
  state.begin();
  state.push({ type: "replay", mouseModes: 0x104,
    bytes: encoder.encode("\x1b[?1049h\x1b[1;1HLatest answer\x1b[24;1HComposer") });
  state.push({ type: "state", state: "connected" });
  state.push({ type: "ready" });
  await state.whenIdle();
  const props = {
    buffer: state.buffer, fontSizeIndex: 1, capNotice: undefined, programScroll: true,
    onReturnToLive: vi.fn(() => {
      const sequence = terminalLiveSequence("codex", state.projection.mouseTracking, state.projection.sgrMouseEncoding);
      if (sequence === "\x1b[1;5F") olderRows = 0;
    }),
    onScrollBack: (lines: number) => {
      const sequence = scrollSequence(lines, state.projection.mouseTracking, state.projection.sgrMouseEncoding);
      // Codex 0.160.0 transcript_view.rs reserves its first row for a prompt
      // header. input.rs ignores wheel events outside the remaining body.
      for (const report of sequence.matchAll(/\x1b\[<(64|65);(\d+);(\d+)M/g)) {
        const row = Number(report[3]) - 1;
        const bodyTop = olderRows === 0 ? 0 : 1;
        if (row < bodyTop || row >= 20) continue;
        olderRows += report[1] === "64" ? 3 : -3;
        state.push({ type: "live", bytes: encoder.encode(
          `\x1b[1;1HPinned prompt\x1b[K\x1b[2;1HEarlier row ${olderRows}\x1b[K`,
        ) });
      }
    },
  };
  const harness = await terminalHarness(props);
  try {
    harness.render().onContentSizeChange();
    harness.frames();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      harness.render();
      const gesture = harness.gesture();
      gesture.onPanResponderGrant({}, finger(0));
      gesture.onPanResponderMove({}, finger(3 * height));
      gesture.onPanResponderRelease();
      await state.whenIdle();
      props.buffer = state.buffer;
      expect(olderRows).toBe(attempt * 3);
    }
    // The local frame fits the phone, but Codex is still reading its own history.
    const view = harness.render();
    view.onScroll(scrollEvent(0, 24 * height));
    harness.render();
    expect(harness.liveButton()).toBeDefined();
    harness.liveButton()!.props.onPress();
    harness.render();
    expect(props.onReturnToLive).toHaveBeenCalledTimes(1);
    expect(olderRows).toBe(0);
    expect(harness.liveButton()).toBeUndefined();
  } finally {
    state.dispose();
  }
});

it.each(["startup", "late attach"])("scrolls a mouse-tracking TUI directly after %s without native overscroll", async (attach) => {
  const state = new TerminalSessionState("mac", "touch-scroll");
  state.begin();
  const frame = "\x1b[?1049h\x1b[1;1HFirst visible answer\x1b[24;1HComposer";
  state.push({ type: "replay", bytes: new TextEncoder().encode(
    (attach === "startup" ? "\x1b[?1003;1006h" : "") + frame,
  ), ...(attach === "late attach" ? { mouseModes: 0x104 } : {}) });
  state.push({ type: "state", state: "connected" });
  state.push({ type: "ready" });
  await state.whenIdle();
  const projection = state.projection;
  const onScrollBack = vi.fn((lines: number) => scrollSequence(lines, projection.mouseTracking, projection.sgrMouseEncoding));
  const harness = await terminalHarness({
    buffer: state.buffer, fontSizeIndex: 1, capNotice: undefined, onScrollBack,
    programScroll: supportsTerminalWheel(projection.mouseTracking, projection.sgrMouseEncoding),
  });
  const height = terminalGeometry.lineHeights[1]!;
  try {
    let view = harness.render();
    expect(harness.gesture().onMoveShouldSetPanResponderCapture({}, finger(2 * height))).toBe(false);
    view.onContentSizeChange();
    harness.frames();
    view = harness.render();
    const gesture = harness.gesture();
    expect(view.scrollEnabled).toBe(false);
    expect(gesture.onMoveShouldSetPanResponderCapture({}, finger(2 * height))).toBe(true);
    expect(gesture.onMoveShouldSetPanResponderCapture({}, finger(0, 50))).toBe(false);
    expect(gesture.onMoveShouldSetPanResponderCapture({}, { ...finger(50), numberActiveTouches: 2 })).toBe(false);

    gesture.onPanResponderGrant({}, finger(0));
    gesture.onPanResponderMove({}, finger(height));
    gesture.onPanResponderMove({}, finger(height * 1.5));
    gesture.onPanResponderMove({}, finger(height * 2));
    expect(onScrollBack).not.toHaveBeenCalled();
    gesture.onPanResponderMove({}, finger(height * 3));
    gesture.onPanResponderMove({}, finger(height * 4.5));
    gesture.onPanResponderMove({}, finger(height * 6));
    gesture.onPanResponderMove({}, finger(height * 3));
    expect(onScrollBack.mock.calls).toEqual([[-1], [-1], [1]]);
    expect(onScrollBack.mock.results.map((result) => result.value)).toEqual([
      "\x1b[<64;1;2M", "\x1b[<64;1;2M", "\x1b[<65;1;2M",
    ]);
    // A native bounce must not duplicate the input already sent by the drag.
    view.onScrollBeginDrag();
    view.onScroll(scrollEvent(-3 * height, 24 * height));
    expect(onScrollBack).toHaveBeenCalledTimes(3);
    gesture.onPanResponderRelease();
    gesture.onPanResponderGrant({}, finger(0));
    gesture.onPanResponderMove({}, finger(-3 * height));
    expect(onScrollBack).toHaveBeenLastCalledWith(1);
    gesture.onPanResponderTerminate();
    gesture.onPanResponderGrant({}, finger(0));
    gesture.onPanResponderMove({}, finger(3 * height));
    expect(onScrollBack).toHaveBeenLastCalledWith(-1);
  } finally {
    state.dispose();
  }
});

it("keeps program scrolling active when Codex inserts older rows into its frame, including after returning live", async () => {
  const state = new TerminalSessionState("mac", "scrolling-frame");
  const encoder = new TextEncoder();
  const height = terminalGeometry.lineHeights[1]!;
  state.begin();
  state.push({ type: "replay", mouseModes: 0x104, bytes: encoder.encode(
    "\x1b[?1049h\x1b[1;1H" + Array.from({ length: 24 }, (_, i) => `Answer ${i}`).join("\r\n"),
  ) });
  state.push({ type: "state", state: "connected" });
  state.push({ type: "ready" });
  await state.whenIdle();
  const onScrollBack = vi.fn();
  const props = { buffer: state.buffer, fontSizeIndex: 1, capNotice: undefined, programScroll: true, onScrollBack };
  const harness = await terminalHarness(props);
  try {
    harness.render().onContentSizeChange();
    harness.frames();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.render();
      const gesture = harness.gesture();
      expect(gesture.onMoveShouldSetPanResponderCapture({}, finger(3 * height))).toBe(true);
      gesture.onPanResponderGrant({}, finger(0));
      gesture.onPanResponderMove({}, finger(3 * height));
      gesture.onPanResponderRelease();
      expect(onScrollBack).toHaveBeenLastCalledWith(-1);
      // Terminal scroll-down preserves old row identities below newly inserted
      // history. Those identities are screen cells, not local reading anchors.
      state.push({ type: "live", bytes: encoder.encode(
        `\x1b[3T\x1b[1;1HEarlier ${attempt}\r\nEarlier\r\nEarlier`,
      ) });
      await state.whenIdle();
      props.buffer = state.buffer;
      harness.scrollTo.mockClear();
      const view = harness.render();
      expect(view.scrollEnabled).toBe(false);
      expect(harness.renderedKeys()).toContain(String(state.buffer.screen![0]!.id));
      expect(harness.scrollTo).not.toHaveBeenCalled();
      expect(harness.liveButton()).toBeDefined();
      if (attempt === 1) {
        harness.liveButton()!.props.onPress();
        harness.render();
        expect(harness.liveButton()).toBeUndefined();
      }
    }
    expect(onScrollBack).toHaveBeenCalledTimes(4);
  } finally {
    state.dispose();
  }
});

it("pans a tall terminal frame and scrolls the program at its edge in the same drag", async () => {
  const height = terminalGeometry.lineHeights[1]!;
  const screen = Array.from({ length: 80 }, (_, index) => ({ id: index + 1, spans: [] }));
  const onScrollBack = vi.fn();
  const harness = await terminalHarness({
    buffer: { ...emptyTerminalBuffer(), screen, ready: true, stream: "live" },
    fontSizeIndex: 1, capNotice: undefined, onScrollBack, programScroll: true,
  });
  let view = harness.render();
  view.onContentSizeChange();
  harness.frames();
  view = harness.render();
  const contentHeight = 80 * height + 2 * terminalGeometry.contentPadding;
  const bottom = contentHeight - 600;
  view.onScroll(scrollEvent(bottom, contentHeight));
  view = harness.render();
  const gesture = harness.gesture();
  gesture.onPanResponderGrant({}, finger(0));
  gesture.onPanResponderMove({}, finger(height));
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: bottom - height, animated: false });
  expect(onScrollBack).not.toHaveBeenCalled();
  // Delayed native callbacks must not undo the position owned by the gesture.
  view.onScroll(scrollEvent(bottom, contentHeight));
  harness.render();
  gesture.onPanResponderMove({}, finger(bottom + 6 * height));
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
  expect(onScrollBack.mock.calls).toEqual([[-2]]);
  harness.render();
  gesture.onPanResponderMove({}, finger(-3 * height));
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: bottom, animated: false });
  expect(onScrollBack.mock.calls).toEqual([[-2], [3]]);
});

it("leaves native history scrolling enabled when no program requested wheel input", async () => {
  const harness = await terminalHarness({
    buffer: { ...emptyTerminalBuffer(), screen: [{ id: 1, spans: [] }], ready: true, stream: "live" },
    fontSizeIndex: 1, capNotice: undefined, onScrollBack: vi.fn(), programScroll: false,
  });
  harness.render().onContentSizeChange();
  harness.frames();
  expect(harness.render().scrollEnabled).toBe(true);
  expect(harness.gesture().onMoveShouldSetPanResponderCapture({}, finger(50))).toBe(false);
});

it("lets a connected reader scroll back through output received during live composer redraws", async () => {
  const encoder = new TextEncoder();
  const state = new TerminalSessionState("mac", "live-history");
  state.begin();
  state.push({ type: "replay", bytes: encoder.encode("\x1b[40;1H\x1b[37;1HComposer") });
  state.push({ type: "state", state: "connected" });
  state.push({ type: "ready" });
  await state.whenIdle();
  const props = { buffer: state.buffer, fontSizeIndex: 1, capNotice: undefined, onScrollBack: vi.fn() };
  const harness = await terminalHarness(props);
  const height = terminalGeometry.lineHeights[1]!;
  try {
    let view = harness.render();
    view.onContentSizeChange();
    harness.frames();
    const history = Array.from({ length: 510 }, (_, index) => `Live answer ${index + 1}`);
    for (let start = 0; start < history.length; start += 170) {
      state.push({ type: "live", bytes: encoder.encode(
        `\x1b[37;1H\x1b[J${history.slice(start, start + 170).join("\r\n")}${"\r\n".repeat(4)}\x1b[37;1H\x1b[JComposer`,
      ) });
      await state.whenIdle();
      props.buffer = state.buffer;
      view = harness.render();
      view.onContentSizeChange();
    }
    const screen = state.buffer.screen!;
    expect(screen.map((row) => row.spans.map((span) => span.text).join("")))
      .toEqual([...history, "Composer"]);

    view.onScroll(scrollEvent(200 * height - 600, 200 * height));
    view = harness.render();
    view.onScrollBeginDrag();
    view.onScroll(scrollEvent(40, 200 * height));
    view = harness.render();
    view.onContentSizeChange();
    view.onScroll(scrollEvent(20, 400 * height));
    view = harness.render();
    view.onContentSizeChange();
    view.onScroll(scrollEvent(0, screen.length * height));
    harness.render();
    expect(harness.renderedKeys()).toContain(String(screen[0]!.id));
    expect(props.onScrollBack).not.toHaveBeenCalled();

    // A further live redraw must leave the reader on the oldest retained answer.
    harness.scrollTo.mockClear();
    harness.scrollToEnd.mockClear();
    state.push({ type: "live", bytes: encoder.encode(
      "\x1b[37;1H\x1b[JLatest answer\r\n\r\n\r\n\r\n\x1b[37;1H\x1b[JComposer",
    ) });
    await state.whenIdle();
    props.buffer = state.buffer;
    view = harness.render();
    view.onContentSizeChange();
    expect(harness.renderedKeys()).toContain(String(screen[0]!.id));
    expect(harness.scrollTo).not.toHaveBeenCalled();
    expect(harness.scrollToEnd).not.toHaveBeenCalled();
  } finally {
    state.dispose();
  }
});

it("reveals one cached page per layout, anchors the reader, and sends no program input", async () => {
  const screen = Array.from({ length: 510 }, (_, index) => ({ id: index + 1, spans: [] }));
  const buffer = { ...emptyTerminalBuffer(), screen, ready: true, stream: "live" as const };
  const onScrollBack = vi.fn();
  const height = terminalGeometry.lineHeights[1]!;
  const harness = await terminalHarness({ buffer, fontSizeIndex: 1, capNotice: undefined, onScrollBack });
  let view = harness.render();
  view.onContentSizeChange();
  harness.frames();
  view = harness.render();
  view.onScroll(scrollEvent(200 * height - 600, 200 * height));
  view = harness.render();
  view.onScrollBeginDrag();
  view.onScroll(scrollEvent(40, 200 * height));
  // More events can arrive before React commits the added rows.
  view.onScroll(scrollEvent(-40, 200 * height));
  view = harness.render();
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: 200 * height + 40, animated: false });
  expect(onScrollBack).not.toHaveBeenCalled();
  expect(harness.renderedKeys()).toContain(String(311 + Math.floor(40 / height)));
  expect(harness.renderedKeys().length).toBeLessThan(100);
  view.onContentSizeChange();
  view.onScroll(scrollEvent(200 * height + 40, 400 * height));
  view = harness.render();
  view.onScroll(scrollEvent(20, 400 * height));
  view = harness.render();
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: 110 * height + 20, animated: false });
  view.onContentSizeChange();
  // The final page's bounce still belongs to local history, not the agent TUI.
  view.onScroll(scrollEvent(-60, 510 * height));
  expect(onScrollBack).not.toHaveBeenCalled();
});

it("does not reapply an old eviction correction after the reader has moved again", async () => {
  const rows = (count: number, start: number) => Array.from({ length: count }, (_, i) => ({ id: start + i, spans: [] }));
  const buffer = { ...emptyTerminalBuffer(), screen: rows(200, 1), ready: true, stream: "live" as const };
  const height = terminalGeometry.lineHeights[1]!;
  const harness = await terminalHarness({ buffer, fontSizeIndex: 1, capNotice: undefined });
  let view = harness.render();
  view.onContentSizeChange();
  harness.frames();
  view = harness.render();
  view.onScrollBeginDrag();
  view.onScroll(scrollEvent(1000, 200 * height));
  view = harness.render();
  buffer.screen = rows(200, 21);
  view = harness.render();
  expect(harness.scrollTo).toHaveBeenLastCalledWith({ y: 1000 - 20 * height, animated: false });
  // Same-height eviction has no onContentSizeChange callback. Momentum continues.
  view.onScroll(scrollEvent(500, 200 * height));
  harness.render();
  harness.scrollTo.mockClear();
  buffer.screen = rows(201, 21);
  view = harness.render();
  view.onContentSizeChange();
  expect(harness.scrollTo).not.toHaveBeenCalled();
});

function scrollEvent(y: number, contentHeight: number) {
  return { nativeEvent: { contentOffset: { y }, contentSize: { height: contentHeight }, layoutMeasurement: { height: 600 } } };
}

it.each([false, true])("returns to the latest rows after reading history (expanded page: %s)", async (expanded) => {
  const screen = Array.from({ length: 510 }, (_, index) => ({ id: index + 1, spans: [] }));
  const buffer = { ...emptyTerminalBuffer(), screen, ready: true, stream: "live" as const };
  const harness = await terminalHarness({ buffer, fontSizeIndex: 1, capNotice: undefined });
  const height = terminalGeometry.lineHeights[1]!;
  const recentHeight = 200 * height + 2 * terminalGeometry.contentPadding;
  let view = harness.render();
  view.onContentSizeChange();
  harness.frames();
  view = harness.render();
  view.onScroll(scrollEvent(recentHeight - 600, recentHeight));
  view = harness.render();
  view.onScrollBeginDrag();
  view.onScroll(scrollEvent(expanded ? 20 : 1000, recentHeight));
  view = harness.render();
  view.onContentSizeChange();
  harness.scrollToEnd.mockClear();
  harness.liveButton()!.props.onPress();
  view = harness.render();
  // No new measurement is needed for a same-height page; render the latest rows
  // immediately, and ignore an in-flight callback from the old reading position.
  expect(harness.renderedKeys()).toContain("510");
  expect(harness.scrollToEnd).toHaveBeenCalledWith({ animated: false });
  view.onScroll(scrollEvent(1000, expanded ? 400 * height : recentHeight));
  view = harness.render();
  expect(harness.liveButton()).toBeUndefined();
  expect(harness.renderedKeys()).toContain("510");
  view.onContentSizeChange();
  view.onScroll(scrollEvent(recentHeight - 600, recentHeight));
  view = harness.render();
  expect(harness.liveButton()).toBeUndefined();
  // A new intentional drag still leaves live mode.
  view.onScrollBeginDrag();
  view.onScroll(scrollEvent(1000, recentHeight));
  harness.render();
  expect(harness.liveButton()).toBeDefined();
});

function finger(dy: number, dx = 0) {
  return { dy, dx, numberActiveTouches: 1 };
}

async function terminalHarness(props: Props) {
  const slots: any[] = [];
  let cursor = 0;
  let updates: Array<() => void> = [];
  let layouts: Array<() => void> = [];
  const frames: Array<() => void> = [];
  const scrollTo = vi.fn();
  const scrollToEnd = vi.fn();
  let tree: ReactNode;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { frames.push(callback); return frames.length; });
  const react = {
    ...require("react"), useContext: () => lightTheme,
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useLayoutEffect: (callback: () => void) => { layouts.push(callback); },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const index = cursor++;
      if (!slots[index] || !deps.every((dep, i) => Object.is(dep, slots[index].deps[i]))) {
        slots[index] = { value: factory(), deps };
      }
      return slots[index].value;
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (update: unknown) => {
        updates.push(() => { slots[index] = typeof update === "function" ? update(slots[index]) : update; });
      }];
    },
  };
  const native = {
    ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
    PanResponder: { create: (panHandlers: unknown) => ({ panHandlers }) },
    StyleSheet: { create: (styles: unknown) => styles },
    Platform: { OS: "ios", select: (values: { ios: string }) => values.ios },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/components/terminal-view.tsx", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-native", "react/jsx-runtime"],
  });
  const module = { exports: {} as { TerminalView: (props: Props) => ReactNode } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
    (name: string) => name === "react" ? react : name === "react-native" ? native : require(name), module, module.exports,
  );
  return {
    scrollTo,
    scrollToEnd,
    gesture: () => nodes(tree)[0]!.props,
    liveButton: () => nodes(tree).find((node) => node.props.accessibilityLabel === "Return to live output"),
    frames: () => { while (frames.length) frames.shift()!(); },
    renderedKeys: () => nodes(tree).filter((node) => node.props.spans).map((node) => node.key),
    render: () => {
      for (let pass = 0; pass < 20; pass += 1) {
        const pending = updates;
        updates = [];
        pending.forEach((update) => update());
        cursor = 0;
        layouts = [];
        tree = module.exports.TerminalView(props);
        if (updates.length) continue;
        const scroll = nodes(tree).find((node) => node.props.onScroll)!;
        scroll.props.ref.current = { scrollTo, scrollToEnd };
        layouts.forEach((layout) => layout());
        if (updates.length) continue;
        return scroll.props;
      }
      throw new Error("Terminal view did not settle");
    },
  };
}

function nodes(node: ReactNode): Array<React.ReactElement<Props>> {
  if (!isValidElement<Props>(node)) return [];
  const children = Array.isArray(node.props.children) ? node.props.children.flat() : [node.props.children];
  return [node, ...children.flatMap((child: ReactNode) => nodes(child))];
}
