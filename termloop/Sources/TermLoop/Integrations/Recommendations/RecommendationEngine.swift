// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Generates a curated recommended set for the integrations tab. Dismissed
/// recommendations persist across launches.
@MainActor
final class RecommendationEngine: ObservableObject {
    static let shared = RecommendationEngine()

    @Published private(set) var recommendations: [Recommendation] = []
    @Published private(set) var dismissed: Set<String> = []

    private init() {
        loadDismissed()
    }

    func recompute(projectRoot _: URL?, items: [IntegrationItem]) {
        var out: [Recommendation] = []
        let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })

        // Always-on curated recommendations.
        out.append(contentsOf: Self.essentialCLI(byId: byId,
                                                  kind: .agent,
                                                  name: "claude",
                                                  presetId: nil))
        out.append(contentsOf: Self.essentialCLI(byId: byId,
                                                  kind: .agent,
                                                  name: "codex",
                                                  presetId: "cli.codex"))
        out.append(contentsOf: Self.essentialCLI(byId: byId,
                                                  kind: .agent,
                                                  name: "gemini",
                                                  presetId: "cli.gemini"))
        out.append(contentsOf: Self.essentialCLI(byId: byId,
                                                  name: "aws",
                                                  presetId: "cli.aws"))
        out.append(contentsOf: Self.essentialCLI(byId: byId,
                                                  name: "app-insights-logs",
                                                  presetId: "cli.app-insights-logs"))

        // Dedupe by id — multiple heuristics may land on the same item.
        var seen: Set<String> = []
        out = out.filter { seen.insert($0.id).inserted }

        out = out
            .filter { !dismissed.contains($0.id) }
            .sorted { $0.severity > $1.severity }
        recommendations = out
    }

    /// Returns an "install / fix / configure" recommendation for a core
    /// CLI. Emits nothing if the CLI tested OK — no point nagging.
    private static func essentialCLI(byId: [String: IntegrationItem],
                                     kind: IntegrationKind = .cli,
                                     name: String,
                                     presetId: String?) -> [Recommendation] {
        let id = IntegrationItem.makeId(kind: kind, name: name)
        guard let item = byId[id] else {
            return [Recommendation(
                id: "rec.essential.\(kind.rawValue).\(name).missing",
                kind: kind,
                itemName: name,
                reason: "Essential CLI — not detected on PATH.",
                action: .add(presetId: presetId),
                severity: .suggest
            )]
        }
        switch item.status {
        case .ok:
            return []
        case .fail:
            return [Recommendation(
                id: "rec.essential.\(kind.rawValue).\(name).fix",
                kind: kind,
                itemName: name,
                reason: "Essential CLI — install or authenticate it.",
                action: .add(presetId: presetId),
                severity: .suggest
            )]
        case .notConfigured:
            return [Recommendation(
                id: "rec.essential.\(kind.rawValue).\(name).configure",
                kind: kind,
                itemName: name,
                reason: "Essential CLI — needs configuration.",
                action: .configure,
                severity: .suggest
            )]
        case .idle, .running:
            return []
        }
    }

    /// Surfaces the "do you have any hooks" view as a recommendation so
    /// users know hooks are supported.
    private static func essentialHooks(items: [IntegrationItem]) -> [Recommendation] {
        var out: [Recommendation] = []
        let hasClaudeHooks = items.contains { $0.kind == .claudeHook }
        let hasCodexHooks = items.contains { $0.kind == .codexHook }
        if !hasClaudeHooks {
            out.append(Recommendation(
                id: "rec.essential.hooks.claude.missing",
                kind: .claudeHook,
                itemName: "claude-hooks",
                reason: "No Claude hooks found — add PreToolUse / Stop hooks for safety.",
                action: .add(presetId: nil),
                severity: .info
            ))
        }
        if !hasCodexHooks {
            out.append(Recommendation(
                id: "rec.essential.hooks.codex.missing",
                kind: .codexHook,
                itemName: "codex-hooks",
                reason: "No Codex hooks found — hooks.json is empty or missing.",
                action: .add(presetId: nil),
                severity: .info
            ))
        }
        return out
    }

    func dismiss(id: String) {
        dismissed.insert(id)
        saveDismissed()
        recommendations.removeAll { $0.id == id }
    }

    func reset() {
        dismissed.removeAll()
        saveDismissed()
    }

    // MARK: - Heuristics

    private static func detectAppInsightsLogs(root: URL,
                                              items: [String: IntegrationItem]) -> [Recommendation] {
        let fm = FileManager.default
        let candidateFiles = [
            "README.md",
            "package.json",
            "appsettings.json",
            "appsettings.Development.json",
            ".env",
            ".env.example",
        ]
        let signals = [
            "APPLICATIONINSIGHTS_CONNECTION_STRING",
            "APPINSIGHTS_INSTRUMENTATIONKEY",
            "ApplicationInsights",
            "AddApplicationInsightsTelemetry",
            "Microsoft.ApplicationInsights",
        ]
        let foundSignal = candidateFiles.contains { file in
            let url = root.appendingPathComponent(file)
            guard fm.fileExists(atPath: url.path),
                  let text = try? String(contentsOf: url, encoding: .utf8) else {
                return false
            }
            return signals.contains(where: { text.contains($0) })
        }
        guard foundSignal else { return [] }
        guard let item = items["cli:app-insights-logs"] else { return [] }
        switch item.status {
        case .ok:
            return []
        case .fail:
            return [Recommendation(
                id: "rec.app-insights-logs.add",
                kind: .cli,
                itemName: "app-insights-logs",
                reason: "Application Insights markers were found in this repo.",
                action: .add(presetId: "cli.app-insights-logs"),
                severity: .warning
            )]
        case .notConfigured, .idle, .running:
            return [Recommendation(
                id: "rec.app-insights-logs.configure",
                kind: .cli,
                itemName: "app-insights-logs",
                reason: "Application Insights markers were found in this repo.",
                action: .configure,
                severity: .suggest
            )]
        }
    }

    private static func detectWrangler(root: URL, items: [String: IntegrationItem]) -> [Recommendation] {
        let fm = FileManager.default
        let signals = ["landing/_headers", "landing/_redirects", "wrangler.toml", "wrangler.jsonc"]
        guard signals.contains(where: { fm.fileExists(atPath: root.appendingPathComponent($0).path) }) else {
            return []
        }
        guard let item = items["cli:wrangler"] else {
            return [Recommendation(
                id: "rec.wrangler.add",
                kind: .cli,
                itemName: "wrangler",
                reason: "Workers config detected in this repo.",
                action: .add(presetId: "cli.wrangler"),
                severity: .warning
            )]
        }
        if case .fail = item.status {
            return [Recommendation(
                id: "rec.wrangler.fix",
                kind: .cli,
                itemName: "wrangler",
                reason: "Workers config detected but auth is failing.",
                action: .fix(step: "wrangler login"),
                severity: .warning
            )]
        }
        return []
    }

    private static func detectJira(root: URL, items: [String: IntegrationItem]) -> [Recommendation] {
        // Skip the recommendation if any alias the user might have
        // already wired up satisfies the Atlassian/Jira need —
        // discovery surfaces them under their original config names.
        let aliases = ["atlassian", "jira-mcp", "jira", "mcp-atlassian"]
        if aliases.contains(where: { items["mcp:\($0)"] != nil }) { return [] }
        // cheap signal: look for `[A-Z]+-\d+` references in README.md
        let readme = root.appendingPathComponent("README.md")
        guard let text = try? String(contentsOf: readme, encoding: .utf8) else { return [] }
        let pattern = "[A-Z]+-[0-9]+"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        let matches = regex.numberOfMatches(in: text, range: NSRange(location: 0, length: ns.length))
        guard matches >= 3 else { return [] }
        return [Recommendation(
            id: "rec.jira.add",
            kind: .mcp,
            itemName: "atlassian",
            reason: "Found \(matches) Jira-style ticket references.",
            action: .add(presetId: nil),
            severity: .suggest
        )]
    }

    private static func detectContext7(root: URL, items: [String: IntegrationItem]) -> [Recommendation] {
        guard items["mcp:context7"] == nil else { return [] }
        let pkg = root.appendingPathComponent("package.json")
        guard let text = try? String(contentsOf: pkg, encoding: .utf8) else { return [] }
        let signals = ["\"expo\"", "\"react-native\"", "\"next\""]
        guard signals.contains(where: { text.contains($0) }) else { return [] }
        return [Recommendation(
            id: "rec.context7.add",
            kind: .mcp,
            itemName: "context7",
            reason: "JS framework detected — up-to-date docs recommended.",
            action: .add(presetId: nil),
            severity: .suggest
        )]
    }

    private static func detectGh(root: URL, items: [String: IntegrationItem]) -> [Recommendation] {
        let fm = FileManager.default
        let dotGitHub = root.appendingPathComponent(".github")
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dotGitHub.path, isDirectory: &isDir), isDir.boolValue else {
            return []
        }
        guard let item = items["cli:gh"] else {
            return [Recommendation(
                id: "rec.gh.add",
                kind: .cli,
                itemName: "gh",
                reason: "This repo has a .github/ folder but gh CLI is missing.",
                action: .add(presetId: "cli.gh"),
                severity: .suggest
            )]
        }
        if case .fail = item.status {
            return [Recommendation(
                id: "rec.gh.configure",
                kind: .cli,
                itemName: "gh",
                reason: "gh CLI is installed but not authenticated.",
                action: .configure,
                severity: .warning
            )]
        }
        return []
    }

    private static func detectAws(root: URL, items: [String: IntegrationItem]) -> [Recommendation] {
        let fm = FileManager.default
        let signals = ["serverless.yml", "template.yaml", ".aws"]
        guard signals.contains(where: { fm.fileExists(atPath: root.appendingPathComponent($0).path) })
        else { return [] }
        guard let item = items["cli:aws"] else {
            return [Recommendation(
                id: "rec.aws.add",
                kind: .cli,
                itemName: "aws",
                reason: "AWS infra config found; aws CLI missing.",
                action: .add(presetId: "cli.aws"),
                severity: .suggest
            )]
        }
        if case .fail = item.status {
            return [Recommendation(
                id: "rec.aws.fix",
                kind: .cli,
                itemName: "aws",
                reason: "aws CLI is installed but auth failing.",
                action: .fix(step: "aws configure"),
                severity: .warning
            )]
        }
        return []
    }

    // MARK: - Persistence

    private func loadDismissed() {
        guard let data = try? Data(contentsOf: IntegrationsPaths.dismissedFile()) else { return }
        guard let arr = try? JSONDecoder().decode([String].self, from: data) else { return }
        dismissed = Set(arr)
    }

    private func saveDismissed() {
        IntegrationsPaths.ensureSupportDir()
        guard let data = try? JSONEncoder().encode(Array(dismissed)) else { return }
        try? data.write(to: IntegrationsPaths.dismissedFile(), options: .atomic)
    }
}
