// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CLIDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .cli

    /// Preset-driven PATH scan. A matching `IntegrationPreset` may refine
    /// the summary later with its `authCheck` metadata.
    static let candidates: [(kind: IntegrationKind, binary: String, display: String, summary: String)] = [
        (.agent, "claude",    "claude",    "Claude Code CLI"),
        (.agent, "codex",     "codex",     "OpenAI Codex CLI"),
        (.agent, "gemini",    "gemini",    "Google Gemini CLI"),
        (.cli,   "az",        "app-insights-logs", "Azure CLI Application Insights Logs"),
        (.cli,   "wrangler",  "wrangler",  "Cloudflare Workers CLI"),
        (.cli,   "gh",        "gh",        "GitHub CLI"),
        (.cli,   "aws",       "aws",       "AWS CLI"),
        (.cli,   "gcloud",    "gcloud",    "Google Cloud CLI"),
        (.cli,   "vercel",    "vercel",    "Vercel CLI"),
        (.cli,   "supabase",  "supabase",  "Supabase CLI"),
        (.cli,   "fly",       "fly",       "Fly.io CLI"),
        (.cli,   "railway",   "railway",   "Railway CLI"),
        (.cli,   "acli",      "acli (Atlassian)", "Atlassian CLI"),
        (.cli,   "doctl",     "doctl",     "DigitalOcean CLI"),
        (.cli,   "heroku",    "heroku",    "Heroku CLI"),
        (.cli,   "kubectl",   "kubectl",   "Kubernetes CLI"),
        (.cli,   "aider",     "aider",     "Aider AI coding CLI"),
    ]

    func discover(projectRoot: URL?) async -> [IntegrationItem] {
        let pathDirs = Self.pathDirectories()
        var items: [IntegrationItem] = []
        for cand in Self.candidates {
            let url = Self.findBinary(name: cand.binary, in: pathDirs)
            let status: IntegrationItem.Status = url == nil
                ? .fail(reason: "not installed")
                : .idle
            items.append(IntegrationItem(
                id: IntegrationItem.makeId(kind: cand.kind, name: cand.binary),
                kind: cand.kind,
                displayName: cand.display,
                summary: url == nil
                    ? "\(cand.summary) · not on PATH"
                    : cand.summary,
                source: url.map { .systemPath($0) } ?? .termLoop,
                status: status,
                lastTestedAt: nil,
                lastTestDurationMs: nil,
                capabilities: [],
                configRef: nil,
                attachedToActiveSpawn: false,
                binaryPath: url?.path,
                version: nil,
                authSubject: nil
            ))
        }
        return items
    }

    static func pathDirectories() -> [URL] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let envDirs = (ProcessInfo.processInfo.environment["PATH"]
            ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0), isDirectory: true) }
        let commonUserDirs = [
            home.appendingPathComponent(".bun/bin", isDirectory: true),
            home.appendingPathComponent(".volta/bin", isDirectory: true),
            home.appendingPathComponent(".asdf/shims", isDirectory: true),
            home.appendingPathComponent(".npm-global/bin", isDirectory: true),
            home.appendingPathComponent(".nvm/current/bin", isDirectory: true),
            home.appendingPathComponent(".local/bin", isDirectory: true),
            home.appendingPathComponent("bin", isDirectory: true),
            URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/local/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/bin", isDirectory: true),
            URL(fileURLWithPath: "/bin", isDirectory: true),
        ] + nvmNodeBinDirectories(home: home)

        var seen: Set<String> = []
        var out: [URL] = []
        for dir in envDirs + commonUserDirs {
            let path = dir.standardizedFileURL.path
            guard !path.isEmpty, seen.insert(path).inserted else { continue }
            out.append(dir)
        }
        return out
    }

    static func findBinary(name: String, in dirs: [URL]) -> URL? {
        let fm = FileManager.default
        for dir in dirs {
            let candidate = dir.appendingPathComponent(name)
            if fm.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    private static func nvmNodeBinDirectories(home: URL) -> [URL] {
        let fm = FileManager.default
        let versionsRoot = home
            .appendingPathComponent(".nvm/versions/node", isDirectory: true)
        guard let versions = try? fm.contentsOfDirectory(
            at: versionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        return versions.compactMap { versionDir in
            let values = try? versionDir.resourceValues(forKeys: [.isDirectoryKey])
            guard values?.isDirectory == true else { return nil }
            return versionDir.appendingPathComponent("bin", isDirectory: true)
        }
    }
}
