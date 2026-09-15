/** Filename associations for the grammars shipped with the read-only viewer. */
const languages = [
  ["csharp", "C#", "cs csx"], ["razor", "Razor", "cshtml razor"],
  ["typescript", "TypeScript", "ts mts cts"], ["tsx", "TSX", "tsx"],
  ["javascript", "JavaScript", "js mjs cjs"], ["jsx", "JSX", "jsx"],
  ["json", "JSON", "json jsonl ipynb"], ["jsonc", "JSON with comments", "jsonc"],
  ["yaml", "YAML", "yaml yml"], ["toml", "TOML", "toml"],
  ["xml", "XML", "xml xsd xsl xslt svg csproj fsproj vbproj props targets resx config plist slnx"],
  ["html", "HTML", "html htm"], ["css", "CSS", "css"], ["scss", "SCSS", "scss"],
  ["markdown", "Markdown", "md markdown"], ["sql", "SQL", "sql"],
  ["shellscript", "Shell", "sh bash zsh"], ["powershell", "PowerShell", "ps1 psm1 psd1"],
  ["bat", "Batch", "bat cmd"], ["python", "Python", "py pyi pyw"],
  ["rust", "Rust", "rs"], ["go", "Go", "go"], ["java", "Java", "java"],
  ["c", "C", "c h"], ["cpp", "C++", "cpp cc cxx hpp hxx"],
  ["swift", "Swift", "swift"], ["kotlin", "Kotlin", "kt kts"],
  ["ruby", "Ruby", "rb"], ["php", "PHP", "php"], ["vue", "Vue", "vue"],
  ["svelte", "Svelte", "svelte"], ["graphql", "GraphQL", "graphql gql"],
  ["dockerfile", "Dockerfile", "dockerfile"], ["makefile", "Makefile", "mk"],
  ["ini", "INI", "ini editorconfig"], ["dotenv", "Environment", "env"],
  ["diff", "Diff", "diff patch"], ["gherkin", "Gherkin", "feature"],
] as const;

export type FileLanguageId = typeof languages[number][0];
export type FileLanguage = { id: FileLanguageId; label: string };
const extensions = new Map(languages.flatMap(([id, label, values]) => values.split(" ").map((ext) => [ext, { id, label }] as const)));
const filenames: Record<string, string> = {
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "mk", gnumakefile: "mk",
  gemfile: "rb", rakefile: "rb", ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh",
  ".bash_profile": "sh", ".editorconfig": "ini", ".npmrc": "ini", ".yarnrc": "ini",
};

export function fileLanguage(path: string): FileLanguage | undefined {
  const name = path.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return extensions.get("env");
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return extensions.get("dockerfile");
  if (/^(?:tsconfig|jsconfig)(?:\..+)?\.json$/u.test(name)) return extensions.get("jsonc");
  return extensions.get(filenames[name] ?? name.split(".").at(-1)!);
}

export function sourceLines(content: string): string[] {
  return content === "" ? [] : content.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
}
