/// Loaded on first editor use. Only the core editor, its editing contributions
/// and Monarch tokenizers are bundled; language services (TS/JSON/CSS/HTML
/// workers) are left out, so the one worker below runs only diff/link helpers
/// without filesystem, network or daemon authority.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/caretOperations/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/comment/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/cursorUndo/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/indentation/register.js";
import "monaco-editor/features/linesOperations/register.js";
import "monaco-editor/features/multicursor/register.js";
import "monaco-editor/features/readOnlyMessage/register.js";
import "monaco-editor/features/smartSelect/register.js";
import "monaco-editor/features/stickyScroll/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/languages/definitions/register.all.js";

(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new Worker(new URL("./monaco-editor.worker.js", import.meta.url), { type: "module" }),
};

export { monaco };
