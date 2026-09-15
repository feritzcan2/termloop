// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileHighlighter, type FileHighlight } from "../src/renderer/file-highlight.js";
import { highlightFileSource } from "../src/renderer/file-highlight-engine.js";
import { FileContentPreview } from "../src/renderer/ui/FilesOverlay.js";
import { WorkspaceFileIcon } from "../src/renderer/ui/WorkspaceFileIcon.js";

const deferred = () => {
  let resolve!: (value: FileHighlight) => void;
  const promise = new Promise<FileHighlight>((done) => { resolve = done; });
  return { resolve, promise };
};

describe("File preview colors", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (path: string, content: string) => {
    await act(async () => root.render(<FileContentPreview preview={{ status: "ready", path, result: { path, content, state: "text" } }} />));
  };
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders real Shiki tokens as escaped React text and keeps the line gutter", async () => {
    const source = '<script>alert("preview")</script>\n<div>hello & goodbye</div>\n';
    const colors = await highlightFileSource("html", source);
    expect(colors.kind).toBe("colored");
    vi.spyOn(FileHighlighter.prototype, "highlight").mockResolvedValue(colors);
    await render("index.html", source);
    expect(container.querySelector('[data-highlighting="colored"]')).not.toBeNull();
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll(".files-line-number")).toHaveLength(2);
    expect(container.querySelector(".files-source-line > span:last-child")?.textContent).toBe('<script>alert("preview")</script>');
    expect(container.querySelectorAll(".files-source-line > span:last-child > span").length).toBeGreaterThan(3);
    expect(container.querySelector("header")?.textContent).toContain("HTML · 2 lines");
  });

  it("never displays tokens from the previous file, and disposes work on close", async () => {
    const old = deferred(), next = deferred();
    vi.spyOn(FileHighlighter.prototype, "highlight").mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const dispose = vi.spyOn(FileHighlighter.prototype, "dispose");
    await render("old.cs", "old source");
    await render("new.ts", "new source");
    await act(async () => old.resolve({ kind: "colored", lines: [[{ content: "stale tokens", light: "#fff", dark: "#000" }]] }));
    expect(container.textContent).not.toContain("stale tokens");
    expect(container.textContent).toContain("new source");
    await act(async () => next.resolve({ kind: "plain", reason: "size" }));
    expect(container.textContent).toContain("Large file shown without syntax colors.");
    await act(async () => root.render(null));
    expect(dispose).toHaveBeenCalled();
  });

  it("leaves unknown file types readable without starting a worker", async () => {
    const highlight = vi.spyOn(FileHighlighter.prototype, "highlight");
    await render("data.unknown", "hello\n\nworld\n");
    expect(highlight).not.toHaveBeenCalled();
    expect(container.querySelector("header")?.textContent).toContain("Plain text · 3 lines");
    expect(container.querySelectorAll(".files-source-line")).toHaveLength(3);
  });

  it("chooses distinct colored file/folder icons and a safe unknown-file fallback", async () => {
    const entries = [
      { name: "Subscription.cs", kind: "file" }, { name: "package.json", kind: "file" },
      { name: "src", kind: "directory" }, { name: "data.unknown", kind: "file" },
    ] as const;
    await act(async () => root.render(<>{entries.map((entry) => <div key={entry.name}><WorkspaceFileIcon entry={entry} /></div>)}</>));
    const icons = [...container.querySelectorAll("svg")];
    expect(icons).toHaveLength(4);
    expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(4);
    expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(icons[0]?.querySelector('[fill^="#"]')).not.toBeNull();
  });
});
