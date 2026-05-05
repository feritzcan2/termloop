// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// User-configured entrypoint for opening a worktree in an external app.
///
/// `relativePath` is resolved against each physical worktree path, so a user
/// can configure `MyApp.sln` once on the project and have TermLoop open the
/// matching solution in every branch worktree without understanding the
/// project's language or build system.
struct WorktreeOpenTarget: Hashable, Sendable, Codable {
    var relativePath: String
    var applicationBundleIdentifier: String?
    var applicationURLPath: String?
    var applicationDisplayName: String?

    init(
        relativePath: String = ".",
        applicationBundleIdentifier: String? = nil,
        applicationURLPath: String? = nil,
        applicationDisplayName: String? = nil
    ) {
        self.relativePath = relativePath
        self.applicationBundleIdentifier = applicationBundleIdentifier
        self.applicationURLPath = applicationURLPath
        self.applicationDisplayName = applicationDisplayName
    }
}

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
    /// Identifier of the `ClaudeCredentialProfile` that the Claude agent
    /// should authenticate as for workspaces in this project. The actual
    /// `CLAUDE_CODE_OAUTH_TOKEN` lives in the Keychain and is resolved at
    /// launch time. `nil` means "use whatever the user is logged in with
    /// in `~/.claude/`" (legacy behavior).
    var claudeCredentialProfileId: String?
    /// Optional project-level worktree entrypoint. Stored as a relative path
    /// so the same target can be opened across every worktree checkout.
    var worktreeOpenTarget: WorktreeOpenTarget?

    init(
        id: UUID = UUID(),
        name: String,
        folderPath: String,
        createdAt: Date = Date(),
        defaultTerminalAgentId: String? = nil,
        claudeCredentialProfileId: String? = nil,
        worktreeOpenTarget: WorktreeOpenTarget? = nil
    ) {
        self.id = id
        self.name = name
        self.folderPath = folderPath
        self.createdAt = createdAt
        self.defaultTerminalAgentId = defaultTerminalAgentId
        self.claudeCredentialProfileId = claudeCredentialProfileId
        self.worktreeOpenTarget = worktreeOpenTarget
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
    var claudeCredentialProfileId: String?
    var worktreeOpenTarget: WorktreeOpenTarget?

    init(_ project: Project) {
        self.id = project.id.uuidString
        self.name = project.name
        self.folderPath = project.folderPath
        self.createdAt = project.createdAt.timeIntervalSince1970
        self.defaultTerminalAgentId = project.defaultTerminalAgentId
        self.claudeCredentialProfileId = project.claudeCredentialProfileId
        self.worktreeOpenTarget = project.worktreeOpenTarget
    }

    var project: Project? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        return Project(
            id: uuid,
            name: name,
            folderPath: folderPath,
            createdAt: Date(timeIntervalSince1970: createdAt),
            defaultTerminalAgentId: defaultTerminalAgentId,
            claudeCredentialProfileId: claudeCredentialProfileId,
            worktreeOpenTarget: worktreeOpenTarget
        )
    }
}
