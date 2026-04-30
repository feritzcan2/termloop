// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// App-level project entry. A project is a named folder that groups one
/// or more workspaces. Projects span windows and persist across app launches.
struct Project: Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var folderPath: String
    let createdAt: Date
    /// Default terminal-agent id applied to new workspaces created in this
    /// project when the caller does not override. Nil falls back to
    /// `TermLoopSettings.shared.defaultTerminalAgentId`.
    var defaultTerminalAgentId: String?
    /// Branches that the Tasks tab tracks for this project. When `nil`, the
    /// tracked set is auto-detected (default branch + `dev` if present) via
    /// `TrackedBranchesResolver`.
    var trackedBranches: [String]?
    /// Identifier of the `ClaudeCredentialProfile` that the Claude agent
    /// should authenticate as for workspaces in this project. The actual
    /// `CLAUDE_CODE_OAUTH_TOKEN` lives in the Keychain and is resolved at
    /// launch time. `nil` means "use whatever the user is logged in with
    /// in `~/.claude/`" (legacy behavior).
    var claudeCredentialProfileId: String?

    init(
        id: UUID = UUID(),
        name: String,
        folderPath: String,
        createdAt: Date = Date(),
        defaultTerminalAgentId: String? = nil,
        trackedBranches: [String]? = nil,
        claudeCredentialProfileId: String? = nil
    ) {
        self.id = id
        self.name = name
        self.folderPath = folderPath
        self.createdAt = createdAt
        self.defaultTerminalAgentId = defaultTerminalAgentId
        self.trackedBranches = trackedBranches
        self.claudeCredentialProfileId = claudeCredentialProfileId
    }
}

/// Codable persistence mirror of `Project`. Stored at the root of the session
/// snapshot so project metadata survives restarts.
struct SessionProjectSnapshot: Codable, Sendable {
    var id: String
    var name: String
    var folderPath: String
    var createdAt: TimeInterval
    var defaultTerminalAgentId: String?
    var trackedBranches: [String]?
    var claudeCredentialProfileId: String?

    init(_ project: Project) {
        self.id = project.id.uuidString
        self.name = project.name
        self.folderPath = project.folderPath
        self.createdAt = project.createdAt.timeIntervalSince1970
        self.defaultTerminalAgentId = project.defaultTerminalAgentId
        self.trackedBranches = project.trackedBranches
        self.claudeCredentialProfileId = project.claudeCredentialProfileId
    }

    var project: Project? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        return Project(
            id: uuid,
            name: name,
            folderPath: folderPath,
            createdAt: Date(timeIntervalSince1970: createdAt),
            defaultTerminalAgentId: defaultTerminalAgentId,
            trackedBranches: trackedBranches,
            claudeCredentialProfileId: claudeCredentialProfileId
        )
    }
}
