import { describe, expect, it } from "vitest";
import { fileLanguage } from "../src/renderer/file-language.js";

describe("File language recognition", () => {
  it.each([
    ["src/Subscription.CS", "csharp", "C#"], ["Views/Index.cshtml", "razor", "Razor"], ["App.tsx", "typescript", "TSX"],
    ["tsconfig.build.json", "javascript", "JSON with comments"], ["package.json", "javascript", "JSON"], ["Project.csproj", "xml", "XML"],
    ["Directory.Build.props", "xml", "XML"], ["Dockerfile", "dockerfile", "Dockerfile"], ["Dockerfile.dev", "dockerfile", "Dockerfile"],
    [".env.production", "ini", "Environment"], [".zshrc", "shell", "Shell"], ["Makefile", "plaintext", "Makefile"],
    ["setup.ps1", "powershell", "PowerShell"], ["Subscription.feature", "plaintext", "Gherkin"], ["main.c", "cpp", "C"],
  ])("maps %s onto a bundled editor tokenizer", (path, id, label) => expect(fileLanguage(path)).toEqual({ id, label }));

  it("leaves unknown files as plain text", () => expect(fileLanguage("mystery.unknown")).toBeUndefined());
});
