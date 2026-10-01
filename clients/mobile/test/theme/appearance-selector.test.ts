import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { expect, it } from "vitest";

import { createAppearanceStore } from "../../src/theme/appearance-store";
import { themes } from "../../src/theme/tokens";

const require = createRequire(import.meta.url);
type Props = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityState?: { checked: boolean };
  onPress?: () => void;
  style?: unknown;
};

it("switches both ways from the home control and updates already mounted surfaces", async () => {
  let saved: string | null = null;
  const preferences = { read: async () => saved, write: async (mode: string) => { saved = mode; } };
  const store = createAppearanceStore(preferences);
  await store.initialize();
  const react = { ...require("react"), useContext: () => themes[store.getMode()] };
  const native = {
    Pressable: "Pressable", Text: "Text", View: "View", ActivityIndicator: "ActivityIndicator",
    StyleSheet: { create: (value: unknown) => value }, Platform: { select: () => "Menlo" },
  };
  const bundle = await build({
    stdin: {
      contents: 'export { AppearanceSelector } from "./components/appearance-selector"; export { Card } from "./components/primitives";',
      resolveDir: fileURLToPath(new URL("../../src", import.meta.url)), loader: "tsx",
    },
    tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    external: ["react", "react-native", "react/jsx-runtime", "@/theme/provider"],
  });
  const module = { exports: {} as {
    AppearanceSelector(): ReactNode;
    Card(props: { children: ReactNode }): ReactNode;
  } };
  new Function("require", "module", "exports", bundle.outputFiles[0]!.text)((name: string) => {
    if (name === "react") return react;
    if (name === "react-native") return native;
    if (name === "@/theme/provider") return { useAppearance: () => store };
    return require(name);
  }, module, module.exports);

  const lightCard = module.exports.Card({ children: "Retained content" });
  let selector = module.exports.AppearanceSelector();
  expect(find(selector, "Light")?.accessibilityState?.checked).toBe(true);
  find(selector, "Dark — Ghostty")!.onPress!();
  selector = module.exports.AppearanceSelector();
  expect(find(selector, "Dark — Ghostty")?.accessibilityState?.checked).toBe(true);
  expect(find(selector, "Light")?.accessibilityState?.checked).toBe(false);
  const darkCard = module.exports.Card({ children: "Retained content" });
  expect(rootProps(darkCard).style).toEqual([{ borderRadius: 12, backgroundColor: themes.dark.color.bgRaised, overflow: "hidden" }, undefined]);
  expect(rootProps(darkCard).children).toBe(rootProps(lightCard).children);

  find(selector, "Light")!.onPress!();
  expect(rootProps(module.exports.Card({ children: "Retained content" })).style).toEqual(rootProps(lightCard).style);
  // Flush the serialized persistence queue before simulating a process restart.
  await store.setMode("light");
  const restarted = createAppearanceStore(preferences);
  await restarted.initialize();
  expect(restarted.getMode()).toBe("light");
});

function rootProps(node: ReactNode): Props {
  if (!isValidElement<Props>(node)) throw new Error("Expected an element");
  return node.props;
}

function find(node: ReactNode, label: string): Props | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, label); if (result) return result; }
  }
  if (!isValidElement<Props>(node)) return undefined;
  if (node.props.accessibilityLabel === label) return node.props;
  return find(node.props.children, label);
}
