import { useEffect, useState } from "react";
import { FileHighlighter, type FileHighlight } from "../file-highlight.js";
import { fileLanguage, sourceLines } from "../file-language.js";

export function FileCodePreview({ path, content }: { path: string; content: string }) {
  const [highlighter] = useState(() => new FileHighlighter());
  const [highlight, setHighlight] = useState<{ path: string; content: string; result: FileHighlight }>();
  const language = fileLanguage(path);
  useEffect(() => () => highlighter.dispose(), [highlighter]);
  useEffect(() => {
    if (!language) return;
    let active = true;
    void highlighter.highlight(language.id, content).then((result) => {
      if (active) setHighlight({ path, content, result });
    });
    return () => { active = false; highlighter.cancel(); };
  }, [highlighter, path, content, language?.id]);
  const result = highlight?.path === path && highlight.content === content ? highlight.result : undefined;
  const lines = sourceLines(content);
  return <div className="files-code-preview">
    <pre className="files-source" tabIndex={0} aria-label={`Contents of ${path}`} data-highlighting={result?.kind === "colored" ? "colored" : "plain"}><code>{lines.map((line, index) => {
      const tokens = result?.kind === "colored" ? result.lines[index] : undefined;
      return <span className="files-source-line" key={index}>
        <span className="files-line-number" aria-hidden="true">{index + 1}</span>
        <span>{tokens?.length ? tokens.map((token, i) => <span key={i} style={{ color: `light-dark(${token.light}, ${token.dark})` }}>{token.content}</span>) : line || "\n"}</span>
      </span>;
    })}</code></pre>
    {result?.kind === "plain" ? <p className="files-color-note" role="status">{result.reason === "size" ? "Large file shown without syntax colors." : "Syntax colors unavailable; showing plain text."}</p> : null}
  </div>;
}
