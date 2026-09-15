import { afterEach, describe, expect, it, vi } from "vitest";
import { fileLanguage, sourceLines } from "../src/renderer/file-language.js";
import { highlightFileSource } from "../src/renderer/file-highlight-engine.js";
import { FileHighlighter, type FileHighlightReply } from "../src/renderer/file-highlight.js";

describe("File language recognition", () => {
  it.each([
    ["src/Subscription.CS", "csharp"], ["Views/Index.cshtml", "razor"], ["App.tsx", "tsx"],
    ["tsconfig.build.json", "jsonc"], ["package.json", "json"], ["Project.csproj", "xml"],
    ["Directory.Build.props", "xml"], ["Dockerfile", "dockerfile"], ["Dockerfile.dev", "dockerfile"],
    [".env.production", "dotenv"], [".zshrc", "shellscript"], ["Makefile", "makefile"],
    ["setup.ps1", "powershell"], ["Subscription.feature", "gherkin"], ["mystery.unknown", undefined],
  ])("recognizes %s", (path, language) => expect(fileLanguage(path)?.id).toBe(language));
});

describe("Shiki file colors", () => {
  it.each([
    ["Subscription.cs", 'public class Subscription { public string Name = "Plan"; }\r\n'],
    ["App.tsx", 'const App = () => <div title="hi">Hello</div>;\n'],
    ["package.json", '{ "enabled": true, "count": 12 }\n'],
    ["Project.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>\n'],
    ["README.md", '# Files\n\nSome **bold** text.\n'],
    ["Index.cshtml", '@model Subscription\n<h1>@Model.Name</h1>\n'],
  ])("preserves source and supplies light/dark colors for %s", async (path, source) => {
    const result = await highlightFileSource(fileLanguage(path)!.id, source);
    expect(result.kind).toBe("colored");
    if (result.kind !== "colored") return;
    expect(result.lines.map((line) => line.map((token) => token.content).join(""))).toEqual(sourceLines(source));
    const tokens = result.lines.flat();
    expect(new Set(tokens.map((token) => token.dark)).size).toBeGreaterThan(1);
    expect(tokens.some((token) => token.dark !== token.light)).toBe(true);
  });

  it("returns plain text for oversize content and excessive rendered tokens", async () => {
    expect(await highlightFileSource("json", "é".repeat(131073))).toEqual({ kind: "plain", reason: "size" });
    expect(await highlightFileSource("json", '"x":true,\n'.repeat(15_000))).toEqual({ kind: "plain", reason: "size" });
  });
});

function fakeWorker() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker;
  const reply = (data: FileHighlightReply) => worker.onmessage?.call(worker, new MessageEvent("message", { data }));
  return { worker, reply };
}

describe("File highlighting worker lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("ignores replaced results and reuses an idle worker", async () => {
    const first = fakeWorker(), second = fakeWorker();
    const create = vi.fn().mockReturnValueOnce(first.worker).mockReturnValue(second.worker);
    const highlighter = new FileHighlighter(create);
    const old = highlighter.highlight("csharp", "old");
    const late = first.worker.onmessage;
    const next = highlighter.highlight("json", "new");
    expect(first.worker.terminate).toHaveBeenCalledOnce();
    expect(await old).toEqual({ kind: "plain", reason: "unavailable" });
    late?.call(first.worker, new MessageEvent("message", { data: { id: 1, result: { kind: "colored", lines: [] } } }));
    const colored = { kind: "colored", lines: [] } as const;
    second.reply({ id: 2, result: { ...colored, lines: [] } });
    expect(await next).toEqual(colored);
    const reused = highlighter.highlight("json", "third");
    expect(create).toHaveBeenCalledTimes(2);
    highlighter.dispose();
    expect(await reused).toEqual({ kind: "plain", reason: "unavailable" });
    expect(second.worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a stalled worker so syntax coloring never blocks file viewing", async () => {
    vi.useFakeTimers();
    const { worker } = fakeWorker();
    const highlighter = new FileHighlighter(() => worker, 50);
    const result = highlighter.highlight("csharp", "class Subscription {}");
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ kind: "plain", reason: "unavailable" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("falls back when a worker cannot be created", async () => {
    const highlighter = new FileHighlighter(() => { throw new Error("Unavailable"); });
    expect(await highlighter.highlight("csharp", "class Subscription {}")).toEqual({ kind: "plain", reason: "unavailable" });
  });
});
