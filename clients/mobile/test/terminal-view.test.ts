import { build } from "esbuild";
import { createRequire } from "node:module";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { emptyTerminalBuffer } from "../src/presentation/terminal-buffer";

const require = createRequire(import.meta.url);

describe("terminal native layout", () => {
  it("keeps the measured height after React Native releases the event", async () => {
    const updates: Array<() => unknown> = [];
    const react = {
      ...require("react"),
      useCallback: (callback: unknown) => callback,
      useEffect: () => {},
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, (update: unknown) => {
        updates.push(() => typeof update === "function" ? update(initial) : update);
      }],
    };
    const native = {
      ActivityIndicator: "ActivityIndicator", Pressable: "Pressable",
      ScrollView: "ScrollView", Text: "Text", View: "View",
      StyleSheet: { create: (styles: unknown) => styles },
      Platform: { OS: "ios", select: (values: { ios: string }) => values.ios },
    };
    const bundle = await build({
      entryPoints: [new URL("../src/components/terminal-view.tsx", import.meta.url).pathname],
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      external: ["react", "react-native", "react/jsx-runtime"],
    });
    const module = { exports: {} as typeof import("../src/components/terminal-view") };
    new Function("require", "module", "exports", bundle.outputFiles[0]!.text)(
      (name: string) => name === "react" ? react : name === "react-native" ? native : require(name),
      module, module.exports,
    );
    const tree = module.exports.TerminalView({
      buffer: emptyTerminalBuffer(), fontSizeIndex: 1, capNotice: undefined,
    });
    const layout = findLayout(tree);
    expect(layout).toBeDefined();
    const event = { nativeEvent: { layout: { height: 320 } } as { layout: { height: number } } | null };
    layout!(event);
    // Fabric pools the event before a queued state updater necessarily runs.
    event.nativeEvent = null;
    expect(updates.map((update) => update())).toContainEqual({ offset: 0, height: 320 });
  });
});

function findLayout(node: ReactNode): ((event: unknown) => void) | undefined {
  if (!isValidElement<{ onLayout?: (event: unknown) => void; children?: ReactNode }>(node)) return;
  if (node.props.onLayout) return node.props.onLayout;
  const children = Array.isArray(node.props.children) ? node.props.children : [node.props.children];
  for (const child of children) {
    const layout = findLayout(child);
    if (layout) return layout;
  }
}
