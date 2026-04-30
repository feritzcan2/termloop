// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Resolves a workspace's bound Claude credential profile to an env overlay
/// that the `TerminalAgentRunner` merges into the launch environment, so the
/// spawned `claude` process authenticates as the project-selected account
/// without touching `~/.claude/`.
///
/// Lookup precedence at launch:
/// 1. The workspace's stamped `resolvedClaudeCredentialProfileId` (set on a
///    prior launch — survives app restart, beats project-default flips).
/// 2. The owning project's `claudeCredentialProfileId`.
/// 3. The active project's default (for spawn paths that haven't yet stamped
///    `metadata.projectId` when the runner reads it).
///
/// When the resolved profile has no Keychain token, the resolver returns an
/// empty overlay rather than failing the launch — the agent then falls back
/// to whatever `~/.claude/` already has, so a half-configured profile never
/// locks the user out of their workspace.
@MainActor
enum ClaudeCredentialEnvResolver {
    /// Agent id for which the resolver injects the override token.
    /// Mirrors the literal id in `TerminalAgentRegistry`.
    static let claudeAgentId = "claude"

    static let oauthEnvVar = "CLAUDE_CODE_OAUTH_TOKEN"

    /// Mirror env var that survives `~/.zshrc` re-exports. The bootstrap /
    /// inline-dispatch shell wrappers run `zsh -ilc` to source the user's
    /// rc files (so PATH, aliases, and worktree integrations work). If the
    /// user has `export CLAUDE_CODE_OAUTH_TOKEN=…` in their rc, that line
    /// silently overwrites our resolver-injected token. We carry the token
    /// under this TermLoop-private name and re-export it from the wrapper
    /// *after* zsh init runs, so the project's selected account always wins.
    /// Symmetric `unset` post-exec keeps the override out of the subsequent
    /// interactive shell environment.
    static let oauthOverrideEnvVar = "TERMLOOP_CLAUDE_OAUTH_OVERRIDE"

    /// Returns the env overlay for the given workspace + agent. Empty dict
    /// when no profile is bound, the profile is unknown, or no token is
    /// stored in the Keychain.
    static func envOverlay(forWorkspaceId workspaceId: UUID, agentId: String) -> [String: String] {
        guard agentId == claudeAgentId,
              let profileId = effectiveProfileId(forWorkspaceId: workspaceId),
              !profileId.isEmpty,
              let token = ClaudeCredentialStore.shared.token(forProfileId: profileId),
              !token.isEmpty else {
            return [:]
        }
        return [oauthOverrideEnvVar: token]
    }

    /// Profile id that should be used for this workspace — workspace stamp
    /// first, project default second, active-project default third.
    ///
    /// The active-project fallback covers spawn paths that don't stamp
    /// `metadata.projectId` synchronously before the runner reads it (e.g.
    /// Quick Action's `createFreshWorkspace`); without it the resolver would
    /// silently fall back to the user's `~/.claude/` login and ignore the
    /// project's account binding.
    static func effectiveProfileId(forWorkspaceId workspaceId: UUID) -> String? {
        let metadata = WorkspaceMetadataStore.shared.byWorkspaceId[workspaceId]
        if let stamped = metadata?.resolvedClaudeCredentialProfileId,
           !stamped.isEmpty {
            return stamped
        }
        let resolvedProjectId = metadata?.projectId ?? ProjectStore.shared.activeProjectId
        guard let projectId = resolvedProjectId,
              let project = ProjectStore.shared.project(id: projectId) else {
            return nil
        }
        return project.claudeCredentialProfileId
    }

    /// Stamps the resolved profile id onto the workspace metadata at launch
    /// time. Idempotent. Called from the runner once the env overlay has
    /// been built so resume after app-restart keeps the same account binding.
    static func stampResolvedProfileIfNeeded(forWorkspaceId workspaceId: UUID, agentId: String) {
        guard agentId == claudeAgentId else { return }
        let metadata = WorkspaceMetadataStore.shared.byWorkspaceId[workspaceId]
        guard let projectId = metadata?.projectId,
              let project = ProjectStore.shared.project(id: projectId),
              let profileId = project.claudeCredentialProfileId,
              !profileId.isEmpty else {
            return
        }
        if metadata?.resolvedClaudeCredentialProfileId != profileId {
            WorkspaceMetadataStore.shared
                .setResolvedClaudeCredentialProfileId(profileId, for: workspaceId)
        }
    }
}
