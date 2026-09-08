import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { emptyTerminalBuffer } from "../src/presentation/terminal-buffer";
import { terminalGeometry } from "../src/theme/tokens";

const require = createRequire(import.meta.url);
type Props = Record<string, any>;

afterEach(() => vi.unstubAllGlobals());

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
    ...require("react"),
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
