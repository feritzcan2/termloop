import { useEffect, useState, useSyncExternalStore } from "react";
import type { HunkData, HunkTokens } from "react-diff-view";
import { appearanceTheme, subscribeAppearanceTheme } from "../appearance-theme.js";
import { colorizedRuns, diffSideLines, diffSyntaxTokens } from "../diff-syntax.js";
import { fileLanguage } from "../file-language.js";

/// Syntax tokens for a rendered diff, colored by the same Monaco tokenizer and
/// theme as the file editor so switching between Diff and Edit keeps colors.
/// Undefined while loading, for plain text, or when colorizing fails.
export function useDiffSyntax(hunks: readonly HunkData[], path: string | undefined): HunkTokens | undefined {
  const languageId = path ? fileLanguage(path)?.id : undefined;
  const theme = useSyncExternalStore(subscribeAppearanceTheme, appearanceTheme, appearanceTheme);
  const [result, setResult] = useState<{ hunks: readonly HunkData[]; languageId: string; tokens: HunkTokens }>();

  useEffect(() => {
    if (!languageId || languageId === "plaintext") return;
    let cancelled = false;
    void import("../monaco-editor.js").then(async ({ monaco }) => {
      monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
      const lines = diffSideLines(hunks);
      // A lone carriage return would split a line inside the colorizer; a
      // space keeps every offset while tokenizing the same text.
      const colorize = async (side: readonly string[]) =>
        colorizedRuns(await monaco.editor.colorize(side.join("\n").replaceAll("\r", " "), languageId, { tabSize: 1 }));
      const [oldRuns, newRuns] = await Promise.all([colorize(lines.old), colorize(lines.new)]);
      if (!cancelled) setResult({ hunks, languageId, tokens: diffSyntaxTokens(lines, { old: oldRuns, new: newRuns }) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hunks, languageId, theme]);

  return result && result.hunks === hunks && result.languageId === languageId ? result.tokens : undefined;
}
