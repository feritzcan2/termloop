import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { FileHighlight } from "./file-highlight.js";
import { sourceLines, type FileLanguageId } from "./file-language.js";

const grammars = {
  csharp: () => import("shiki/langs/csharp.mjs"), razor: () => import("shiki/langs/razor.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"), tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"), jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"), jsonc: () => import("shiki/langs/jsonc.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"), toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"), html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"), scss: () => import("shiki/langs/scss.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"), sql: () => import("shiki/langs/sql.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"), powershell: () => import("shiki/langs/powershell.mjs"),
  bat: () => import("shiki/langs/bat.mjs"), python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"), go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"), c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"), swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"), ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"), vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"), graphql: () => import("shiki/langs/graphql.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"), makefile: () => import("shiki/langs/makefile.mjs"),
  ini: () => import("shiki/langs/ini.mjs"), dotenv: () => import("shiki/langs/dotenv.mjs"),
  diff: () => import("shiki/langs/diff.mjs"), gherkin: () => import("shiki/langs/gherkin.mjs"),
} satisfies Record<FileLanguageId, () => Promise<unknown>>;

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
export async function highlightFileSource(language: FileLanguageId, content: string): Promise<FileHighlight> {
  if (new TextEncoder().encode(content).length > 262_144 || sourceLines(content).length > 20_000) return { kind: "plain", reason: "size" };
  try {
    highlighter ??= createHighlighterCore({
      engine: createJavaScriptRegexEngine(), langs: [],
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    });
    const instance = await highlighter;
    await instance.loadLanguage(await grammars[language]());
    const lines = instance.codeToTokensWithThemes(sourceLines(content).join("\n"), {
      lang: language, themes: { light: "github-light", dark: "github-dark" },
    });
    if (lines.reduce((count, line) => count + line.length, 0) > 50_000) return { kind: "plain", reason: "size" };
    return { kind: "colored", lines: lines.map((line) => line.map((token) => ({
      content: token.content, light: token.variants.light?.color ?? "#24292f", dark: token.variants.dark?.color ?? "#c9d1d9",
    }))) };
  } catch { return { kind: "plain", reason: "unavailable" }; }
}
