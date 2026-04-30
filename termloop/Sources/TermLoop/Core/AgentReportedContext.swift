// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct AgentReportedContextEntry: Equatable {
    enum Scope: String, Equatable, Codable {
        case workspace
        case branch
        case project
    }

    let scope: Scope
    let labelForAgent: String
    let displayValue: String
    let url: String?
    let updatedAt: Date
}

struct AgentReportedContextSnapshot: Equatable {
    let entries: [AgentReportedContextEntry]
    var isEmpty: Bool { entries.isEmpty }
}

@MainActor
enum AgentReportedContextSnapshotBuilder {

    static func build(
        workspaceId: UUID?,
        projectId: UUID?,
        branchName: String?,
        runCwd: URL? = nil
    ) -> AgentReportedContextSnapshot {
        // Worktree-keyed: resolve cwd → canonical git toplevel → look up
        // the per-worktree entry. Survives workspace UUID churn, panel
        // close/reopen, and parallel split sessions on the same worktree.
        guard let path = resolveWorktreeRoot(
            workspaceId: workspaceId,
            projectId: projectId,
            runCwd: runCwd
        ),
              let entry = AgentReportedStateStore.shared.entry(forPath: path) else {
            return AgentReportedContextSnapshot(entries: [])
        }

        var entries: [AgentReportedContextEntry] = []

        // Ability-driven bindings. The label format `<binding-id> @ <ability-id>`
        // is generic enough that any ability (Jira ticket, deploy chip,
        // incident link, …) flows through this single branch without
        // special-cased Swift code.
        let sortedBindings = entry.bindings.values
            .sorted { ($0.abilityId, $0.bindingId) < ($1.abilityId, $1.bindingId) }
        for binding in sortedBindings {
            guard let safeLabel = sanitizeShortText(binding.label) else { continue }
            var display = safeLabel
            if let safeStatus = sanitizeShortText(binding.status) {
                display += " · \(safeStatus)"
            }
            let agentLabel: String = {
                let id = sanitizeIdentifier(binding.bindingId) ?? "binding"
                let owner = sanitizeIdentifier(binding.abilityId) ?? "unknown"
                return "Reported \(id) (\(owner))"
            }()
            entries.append(
                AgentReportedContextEntry(
                    scope: .branch,
                    labelForAgent: agentLabel,
                    displayValue: display,
                    url: sanitizeURL(binding.url),
                    updatedAt: binding.reportedAt
                )
            )
        }

        return AgentReportedContextSnapshot(entries: entries)
    }

    /// Workspace id is preferred — `WorkspaceMetadataStore.worktreeRootPath`
    /// reads the persisted physical checkout path and applies symlink
    /// resolution at the filesystem level. `runCwd` is the fallback for
    /// socket / generic-terminal launches without a workspace binding. When
    /// that cwd lives under TermLoop's canonical worktree folder, collapse it
    /// to `.termloop-worktrees/<leaf>` without spawning git so subdirectory
    /// launches still find the worktree-scoped reported-state entry.
    private static func resolveWorktreeRoot(
        workspaceId: UUID?,
        projectId: UUID?,
        runCwd: URL?
    ) -> String? {
        if let workspaceId,
           let path = WorkspaceMetadataStore.shared.worktreeRootPath(forWorkspaceId: workspaceId) {
            return path
        }
        if let runCwd {
            let standardizedRunPath = URL(fileURLWithPath: runCwd.path)
                .standardizedFileURL
                .path
            let resolvedRunPath = URL(fileURLWithPath: runCwd.path)
                .resolvingSymlinksInPath()
                .path
            if let project = reportedContextProject(
                projectId: projectId,
                standardizedRunPath: standardizedRunPath,
                resolvedRunPath: resolvedRunPath
            ),
               let worktreeRoot = termLoopWorktreeRoot(
                containing: resolvedRunPath,
                projectFolderPath: project.folderPath
               ) {
                return worktreeRoot
            }
            return resolvedRunPath
        }
        return nil
    }

    private static func reportedContextProject(
        projectId: UUID?,
        standardizedRunPath: String,
        resolvedRunPath: String
    ) -> Project? {
        if let projectId,
           let project = ProjectStore.shared.project(id: projectId) {
            return project
        }
        return ProjectStore.shared.project(containingPath: standardizedRunPath)
            ?? ProjectStore.shared.project(containingPath: resolvedRunPath)
    }

    private static func termLoopWorktreeRoot(
        containing resolvedRunPath: String,
        projectFolderPath: String
    ) -> String? {
        let projectRoot = URL(fileURLWithPath: projectFolderPath)
            .resolvingSymlinksInPath()
            .path
        return WorktreeResolver.worktreeRoot(
            containing: resolvedRunPath,
            projectFolder: projectRoot
        )
    }

    static func composeBlock(
        _ snapshot: AgentReportedContextSnapshot,
        now: Date = Date()
    ) -> String? {
        guard !snapshot.entries.isEmpty else { return nil }
        let lines = snapshot.entries.map { entry -> String in
            let urlSuffix = (entry.url?.isEmpty == false) ? " (\(entry.url!))" : ""
            return "\(entry.labelForAgent): \(entry.displayValue)\(urlSuffix)"
        }
        return "<system-reminder>\n" + lines.joined(separator: "\n") + "\n</system-reminder>"
    }

    // MARK: - Sanitizers
    //
    // MCP-reported values (URLs, titles, kinds, Jira keys) flow into a future
    // agent's system prompt. A buggy or hostile payload could embed newlines
    // or instruction-like text and hijack the next session. Strip control
    // characters, cap length, validate structure.

    private static let allowedURLSchemes: Set<String> = ["https", "http"]

    /// Match the slug shape ability/binding ids use on disk so a malformed
    /// payload can't break out of the rendered system-reminder line.
    private static let identifierRegex: NSRegularExpression? =
        try? NSRegularExpression(pattern: #"^[a-z0-9][a-z0-9._-]{0,63}$"#)

    private static func sanitizeShortText(_ value: String?, maxLength: Int = 120) -> String? {
        guard let value else { return nil }
        let collapsed = value
            .components(separatedBy: .controlCharacters)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty else { return nil }
        if collapsed.count <= maxLength { return collapsed }
        return String(collapsed.prefix(maxLength - 1)) + "…"
    }

    private static func sanitizeIdentifier(_ value: String) -> String? {
        guard let regex = identifierRegex else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        return regex.firstMatch(in: trimmed, range: range) != nil ? trimmed : nil
    }

    private static func sanitizeURL(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              allowedURLSchemes.contains(scheme),
              let host = url.host, !host.isEmpty else {
            return nil
        }
        return value
    }
}
