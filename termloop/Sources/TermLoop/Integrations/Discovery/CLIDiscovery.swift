// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CLIDiscovery: IntegrationDiscovery {
    let kind: IntegrationKind = .cli

    /// Preset-driven PATH scan. Each entry is a tuple of (binary name,
    /// display name, one-line summary). A matching `IntegrationPreset` may
    /// refine the summary later with its `authCheck` metadata.
    static let candidates: [(binary: String, display: String, summary: String)] = [
        ("claude",    "claude",    "Claude Code CLI"),
        ("codex",     "codex",     "OpenAI Codex CLI"),
        ("gemini",    "gemini",    "Google Gemini CLI"),
        ("az",        "app-insights-logs", "Azure CLI Application Insights Logs"),
        ("wrangler",  "wrangler",  "Cloudflare Workers CLI"),
        ("gh",        "gh",        "GitHub CLI"),
        ("aws",       "aws",       "AWS CLI"),
        ("gcloud",    "gcloud",    "Google Cloud CLI"),
        ("vercel",    "vercel",    "Vercel CLI"),
        ("supabase",  "supabase",  "Supabase CLI"),
        ("fly",       "fly",       "Fly.io CLI"),
        ("railway",   "railway",   "Railway CLI"),
        ("jira",      "jira",      "Jira CLI"),
        ("acli",      "acli",      "Atlassian CLI"),
        ("doctl",     "doctl",     "DigitalOcean CLI"),
        ("heroku",    "heroku",    "Heroku CLI"),
        ("kubectl",   "kubectl",   "Kubernetes CLI"),
        ("aider",     "aider",     "Aider AI coding CLI"),
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
                id: IntegrationItem.makeId(kind: .cli, name: cand.binary),
                kind: .cli,
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
            home.appendingPathComponent(".local/bin", isDirectory: true),
            home.appendingPathComponent("bin", isDirectory: true),
            URL(fileURLWithPath: "/opt/homebrew/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/local/bin", isDirectory: true),
            URL(fileURLWithPath: "/usr/bin", isDirectory: true),
            URL(fileURLWithPath: "/bin", isDirectory: true),
        ]

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
}
