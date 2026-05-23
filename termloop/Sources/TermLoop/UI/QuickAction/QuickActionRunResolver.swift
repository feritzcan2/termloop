// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum QuickActionError: Error, LocalizedError {
    case workspaceNotFound(UUID)
    case spawnCwdFailed(Error)
    case workspaceScopeRequiresTarget
    case noCurrentProject
    case worktreeMigrationUnavailable
    case variablesRequired([String])
    case promptRequired
    case noTemplate

    var errorDescription: String? {
        switch self {
        case .workspaceNotFound:
            return String(
                localized: "quickAction.error.workspaceNotFound",
                defaultValue: "Selected folder is no longer available.",
                table: "TermLoop"
            )
        case .spawnCwdFailed(let err):
            return String(
                localized: "quickAction.error.spawnCwdFailed",
                defaultValue: "Could not resolve folder: \(err.localizedDescription)",
                table: "TermLoop"
            )
        case .workspaceScopeRequiresTarget:
            return String(
                localized: "quickAction.error.workspaceScopeRequiresTarget",
                defaultValue: "Pick a folder to run in.",
                table: "TermLoop"
            )
        case .noCurrentProject:
            return String(
                localized: "quickAction.error.noCurrentProject",
                defaultValue: "No active project. Open a project to run root-scope templates.",
                table: "TermLoop"
            )
        case .worktreeMigrationUnavailable:
            return String(
                localized: "quickAction.error.worktreeMigrationUnavailable",
                defaultValue: "Move to worktree is unavailable for this session. Stop the running agent turn and try again.",
                table: "TermLoop"
            )
        case .variablesRequired(let names):
            return String(
                localized: "quickAction.error.variablesRequired",
                defaultValue: "Fill in required variables: \(names.joined(separator: ", "))",
                table: "TermLoop"
            )
        case .promptRequired:
            return String(
                localized: "quickAction.error.promptRequired",
                defaultValue: "Enter a prompt or choose a template that provides one.",
                table: "TermLoop"
            )
        case .noTemplate:
            return String(
                localized: "quickAction.error.noTemplate",
                defaultValue: "No template available.",
                table: "TermLoop"
            )
        }
    }
}

/// Resolves palette state into a composer-ready `AgentInvocationRequest`.
/// Pure: no side effects, no UI, no actual spawn. Context resolution +
/// auto-fill lives here because these are quick-action-specific concerns;
/// everything downstream (variable substitution, ability composition,
/// plan construction) is the composer's job.
@MainActor
enum QuickActionRunResolver {
    private enum WorkspaceCwdResolutionMode {
        case launchValidated
        case previewFast
    }

    static let autoFilledVariableNames: Set<String> = [
        "branch_name",
        "cwd",
        "workspace_path",
        "worktree_path",
        "repo_name",
        "project_name",
        "timestamp"
    ]
    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    struct ResolvedContext {
        var workspaceId: UUID?
        var projectId: UUID?
        var workspaceCwd: URL?
        var branchName: String?
        var repoRootPath: String
    }

    static func resolve(
        template: AgentTemplate,
        targetWorkspaceId: UUID?,
        agentId: String?,
        promptOverride: String?,
        promptDocumentIdOverride: String? = nil,
        permissionOverride: AgentTemplate.PermissionMode?,
        variableOverrides: [String: String],
        source: AgentInvocationSource = .quickAction,
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        systemPromptOverride: String? = nil,
        systemPromptDocumentIdOverride: String? = nil,
        reasonTag: String? = nil,
        projectId: UUID? = nil
    ) throws -> AgentInvocationRequest {
        let context = try resolveContext(
            template: template,
            targetWorkspaceId: targetWorkspaceId,
            projectId: projectId,
            workspaceCwdResolutionMode: .launchValidated
        )
        return try buildRequest(
            template: template,
            context: context,
            agentId: agentId,
            promptOverride: promptOverride,
            promptDocumentIdOverride: promptDocumentIdOverride,
            permissionOverride: permissionOverride,
            variableOverrides: variableOverrides,
            source: source,
            modelOverride: modelOverride,
            reasoningOverride: reasoningOverride,
            systemPromptOverride: systemPromptOverride,
            systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
            reasonTag: reasonTag
        )
    }

    static func resolvePreview(
        template: AgentTemplate,
        targetWorkspaceId: UUID?,
        agentId: String?,
        promptOverride: String?,
        promptDocumentIdOverride: String? = nil,
        permissionOverride: AgentTemplate.PermissionMode?,
        variableOverrides: [String: String],
        source: AgentInvocationSource = .quickAction,
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        systemPromptOverride: String? = nil,
        systemPromptDocumentIdOverride: String? = nil,
        reasonTag: String? = nil,
        projectId: UUID? = nil
    ) throws -> AgentInvocationRequest {
        let context = try resolveContext(
            template: template,
            targetWorkspaceId: targetWorkspaceId,
            projectId: projectId,
            workspaceCwdResolutionMode: .previewFast
        )
        return try buildRequest(
            template: template,
            context: context,
            agentId: agentId,
            promptOverride: promptOverride,
            promptDocumentIdOverride: promptDocumentIdOverride,
            permissionOverride: permissionOverride,
            variableOverrides: variableOverrides,
            source: source,
            modelOverride: modelOverride,
            reasoningOverride: reasoningOverride,
            systemPromptOverride: systemPromptOverride,
            systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
            reasonTag: reasonTag
        )
    }

    static func resolve(
        template: AgentTemplate,
        context: ResolvedContext,
        agentId: String?,
        promptOverride: String?,
        promptDocumentIdOverride: String? = nil,
        permissionOverride: AgentTemplate.PermissionMode?,
        variableOverrides: [String: String],
        source: AgentInvocationSource,
        modelOverride: AgentModelOption? = nil,
        reasoningOverride: AgentReasoningOption? = nil,
        systemPromptOverride: String? = nil,
        systemPromptDocumentIdOverride: String? = nil,
        reasonTag: String? = nil
    ) throws -> AgentInvocationRequest {
        try buildRequest(
            template: template,
            context: context,
            agentId: agentId,
            promptOverride: promptOverride,
            promptDocumentIdOverride: promptDocumentIdOverride,
            permissionOverride: permissionOverride,
            variableOverrides: variableOverrides,
            source: source,
            modelOverride: modelOverride,
            reasoningOverride: reasoningOverride,
            systemPromptOverride: systemPromptOverride,
            systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
            reasonTag: reasonTag
        )
    }

    private static func buildRequest(
        template: AgentTemplate,
        context: ResolvedContext,
        agentId: String?,
        promptOverride: String?,
        promptDocumentIdOverride: String?,
        permissionOverride: AgentTemplate.PermissionMode?,
        variableOverrides: [String: String],
        source: AgentInvocationSource,
        modelOverride: AgentModelOption?,
        reasoningOverride: AgentReasoningOption?,
        systemPromptOverride: String?,
        systemPromptDocumentIdOverride: String?,
        reasonTag: String?
    ) throws -> AgentInvocationRequest {
        var variableValues = variableOverrides
        autoFill(&variableValues, for: template, using: context)

        let missing = template.variables.filter { variableValues[$0] == nil }
        if !missing.isEmpty {
            throw QuickActionError.variablesRequired(missing)
        }

        return AgentInvocationRequest(
            agentId: agentId,
            templateId: template.id,
            userPrompt: promptOverride,
            workspaceId: context.workspaceId,
            projectId: context.projectId,
            runCwd: context.workspaceCwd,
            branchName: context.branchName,
            repoRootPath: context.repoRootPath,
            promptDocumentIdOverride: promptDocumentIdOverride,
            systemPromptOverride: systemPromptOverride,
            systemPromptDocumentIdOverride: systemPromptDocumentIdOverride,
            permissionOverride: permissionOverride,
            modelOverride: modelOverride,
            reasoningOverride: reasoningOverride,
            variableValues: variableValues,
            source: source,
            reasonTag: reasonTag
        )
    }

    /// Exposed for the advanced pane, which needs to know *before* Enter
    /// which variables still need user input (so it can render rows for
    /// them and pre-fill the auto-filled ones read-only).
    static func missingVariables(
        for template: AgentTemplate,
        targetWorkspaceId: UUID?,
        variableOverrides: [String: String]
    ) -> [String] {
        let context = try? resolveContext(
            template: template,
            targetWorkspaceId: targetWorkspaceId,
            projectId: nil,
            workspaceCwdResolutionMode: .previewFast
        )
        var values = variableOverrides
        if let context {
            autoFill(&values, for: template, using: context)
        }
        return template.variables.filter { values[$0] == nil }
    }

    static func resolvedVariableValues(
        for template: AgentTemplate,
        targetWorkspaceId: UUID?,
        projectId: UUID?,
        variableOverrides: [String: String]
    ) throws -> [String: String] {
        let context = try resolveContext(
            template: template,
            targetWorkspaceId: targetWorkspaceId,
            projectId: projectId,
            workspaceCwdResolutionMode: .launchValidated
        )
        var values = variableOverrides
        autoFill(&values, for: template, using: context)
        return values
    }

    static func resolvedVariableValues(
        for template: AgentTemplate,
        context: ResolvedContext,
        variableOverrides: [String: String]
    ) throws -> [String: String] {
        var values = variableOverrides
        autoFill(&values, for: template, using: context)
        return values
    }

    // MARK: Internals

    private static func resolveContext(
        template: AgentTemplate,
        targetWorkspaceId: UUID?,
        projectId: UUID?,
        workspaceCwdResolutionMode: WorkspaceCwdResolutionMode
    ) throws -> ResolvedContext {
        if let wsId = targetWorkspaceId {
            guard let ws = AppDelegate.shared?.workspaceFor(tabId: wsId) else {
                throw QuickActionError.workspaceNotFound(wsId)
            }
            let resolvedCwd: URL?
            switch workspaceCwdResolutionMode {
            case .launchValidated:
                do {
                    if let resolved = try ws.termLoopSpawnCwd() {
                        resolvedCwd = URL(fileURLWithPath: resolved)
                    } else {
                        resolvedCwd = nil
                    }
                } catch {
                    throw QuickActionError.spawnCwdFailed(error)
                }
            case .previewFast:
                if let resolved = ws.termLoopPresentationCwd() {
                    resolvedCwd = URL(fileURLWithPath: resolved)
                } else {
                    resolvedCwd = nil
                }
            }

            let branch = WorkspaceMetadataStore.shared.branch(for: ws)
            let meta = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: ws.id)
            let resolvedProjectId = resolveProjectId(
                explicitProjectId: projectId,
                metadataProjectId: meta.projectId
            )
            guard let resolvedProjectId else {
                throw QuickActionError.noCurrentProject
            }
            let repoRootPath = resolveRepoRootPath(
                projectId: resolvedProjectId,
                fallbackCwd: resolvedCwd
            )

            // If the workspace has no cwd of its own (brand-new tab at
            // ~/, or a shell-in-home tab), fall back to the project root
            // so the agent runs *inside* the project — not in the user's
            // home directory. This matches the one-off dialog's behavior
            // at AgentOneOffDialog.swift:169–171 (cwd ?? repoRootPath).
            let effectiveCwd = resolvedCwd ?? URL(fileURLWithPath: repoRootPath)

            return ResolvedContext(
                workspaceId: ws.id,
                projectId: resolvedProjectId,
                workspaceCwd: effectiveCwd,
                branchName: branch,
                repoRootPath: repoRootPath
            )
        }

        // Root/project context: when no workspace target is selected, fall
        // back to the active project's root for every template scope.
        let resolvedProjectId = projectId ?? ProjectStore.shared.activeProjectId
        guard let resolvedProjectId,
              let active = ProjectStore.shared.project(id: resolvedProjectId) else {
            throw QuickActionError.noCurrentProject
        }
        let expanded = (active.folderPath as NSString).expandingTildeInPath
        let rootURL = URL(fileURLWithPath: expanded)
        return ResolvedContext(
            workspaceId: nil,
            projectId: resolvedProjectId,
            workspaceCwd: rootURL,
            branchName: nil,
            repoRootPath: rootURL.path
        )
    }

    private static func autoFill(
        _ values: inout [String: String],
        for template: AgentTemplate,
        using context: ResolvedContext
    ) {
        let cwdPath = context.workspaceCwd?.path ?? ""
        let repoName = URL(fileURLWithPath: context.repoRootPath).lastPathComponent
        let branchName = context.branchName ?? "main"
        let timestamp = timestampFormatter.string(from: Date())

        for name in autoFilledVariableNames where values[name] == nil {
            switch name {
            case "branch_name":
                values[name] = branchName
            case "cwd", "workspace_path", "worktree_path":
                values[name] = cwdPath
            case "repo_name":
                values[name] = repoName
            case "project_name":
                values[name] = repoName
            case "timestamp":
                values[name] = timestamp
            default:
                break
            }
        }
    }

    /// Resolves the agent's `repoRootPath`. Priority:
    /// 1. Workspace's bound project (`metadata.projectId`) — exact match.
    /// 2. The app-wide currently-active project (`ProjectStore.activeProject`).
    /// 3. The workspace's own cwd (only if non-home — agents-in-home is the
    ///    bug we're protecting against).
    /// 4. Process cwd as a last resort.
    ///
    /// The activeProject fallback is what the user asked for: "project dir
    /// default olarak projenin seçileni olmalı" — if there's a project
    /// selected in the project switcher, that folder wins over a bare home
    /// cwd even when the workspace metadata lost its projectId binding.
    private static func resolveRepoRootPath(
        projectId: UUID?,
        fallbackCwd: URL?
    ) -> String {
        if let projectId,
           let project = ProjectStore.shared.projects.first(where: { $0.id == projectId }) {
            return (project.folderPath as NSString).expandingTildeInPath
        }
        if let active = ProjectStore.shared.activeProject {
            return (active.folderPath as NSString).expandingTildeInPath
        }
        let homePath = FileManager.default.homeDirectoryForCurrentUser.path
        if let cwdPath = fallbackCwd?.path, cwdPath != homePath {
            return cwdPath
        }
        return fallbackCwd?.path ?? FileManager.default.currentDirectoryPath
    }

    private static func resolveProjectId(
        explicitProjectId: UUID?,
        metadataProjectId: UUID?
    ) -> UUID? {
        if let metadataProjectId,
           ProjectStore.shared.project(id: metadataProjectId) != nil {
            return metadataProjectId
        }
        if let explicitProjectId,
           ProjectStore.shared.project(id: explicitProjectId) != nil {
            return explicitProjectId
        }
        return ProjectStore.shared.activeProjectId
    }
}

/// Convenience wrapper around `ProjectStore.shared.activeProjectId` lookup.
/// Not a stored property on ProjectStore (upstream-ish); kept as a helper
/// here so we don't depend on ProjectStore growing an `activeProject`
/// accessor.
@MainActor
extension ProjectStore {
    var activeProject: Project? {
        guard let id = activeProjectId else { return nil }
        return projects.first(where: { $0.id == id })
    }
}
