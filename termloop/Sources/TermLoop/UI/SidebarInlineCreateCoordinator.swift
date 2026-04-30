// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

enum SidebarInlineCreateError: Error, LocalizedError {
    case invalidWorkspaceName
    case missingProject(UUID)
    case missingTabManager

    var errorDescription: String? {
        switch self {
        case .invalidWorkspaceName:
            return String(
                localized: "workspace.create.error.invalidName",
                defaultValue: "Workspace name cannot be empty.",
                table: "TermLoop"
            )
        case .missingProject:
            return String(
                localized: "workspace.create.error.missingProject",
                defaultValue: "Project context is no longer available.",
                table: "TermLoop"
            )
        case .missingTabManager:
            return String(
                localized: "workspace.create.error.missingTabManager",
                defaultValue: "Workspace could not be created right now.",
                table: "TermLoop"
            )
        }
    }
}

struct SidebarInlineCreateRequest: Identifiable, Equatable {
    enum Kind: Equatable {
        case workspace(projectId: UUID)
    }

    let id = UUID()
    let kind: Kind
    let defaultName: String
    let terminalAgentId: String?

    var projectId: UUID {
        switch kind {
        case .workspace(let projectId):
            return projectId
        }
    }

    var isWorkspace: Bool {
        if case .workspace = kind { return true }
        return false
    }

    func belongs(to projectId: UUID?) -> Bool {
        guard let projectId else { return false }
        return self.projectId == projectId
    }
}

@MainActor
final class SidebarInlineCreateCoordinator: ObservableObject {
    static let shared = SidebarInlineCreateCoordinator()

    @Published private(set) var request: SidebarInlineCreateRequest?

    private init() {}

    func beginWorkspace(projectId: UUID, terminalAgentId: String? = nil) {
        request = SidebarInlineCreateRequest(
            kind: .workspace(projectId: projectId),
            defaultName: Self.suggestedWorkspaceName(projectId: projectId),
            terminalAgentId: terminalAgentId
        )
    }

    /// Finds the lowest positive integer N such that "workspace N" is not
    /// already taken (case-insensitive) by another workspace in the same
    /// project. Falls back to "workspace 1" when the project has no tabs.
    private static func suggestedWorkspaceName(projectId: UUID) -> String {
        let tabs = AppDelegate.shared?.tabManager?.tabs ?? []
        let existing = Set(
            tabs.filter { $0.projectId == projectId }
                .map { $0.title.lowercased() }
        )
        var n = 1
        while existing.contains("workspace \(n)") { n += 1 }
        return "workspace \(n)"
    }

    /// Project-scoped agent counter naming used by `fastCreateWorkspace`.
    /// First workspace in project for a given agent → bare agent name (e.g.
    /// "claude"); subsequent ones get "(N)" suffix scoped per agent ("claude
    /// (2)" while "codex" stays bare).
    static func suggestedAgentWorkspaceName(
        agentId: String,
        existingTitlesInProject: [String]
    ) -> String {
        let lowered = Set(existingTitlesInProject.map { $0.lowercased() })
        let baseLower = agentId.lowercased()
        if !lowered.contains(baseLower) {
            return agentId
        }
        var n = 2
        while lowered.contains("\(baseLower) (\(n))") { n += 1 }
        return "\(agentId) (\(n))"
    }

    /// Opens Quick Action prefilled for an agent workspace, skipping the
    /// inline-rename row entirely. Used by per-agent "Add <Agent>" menu
    /// items and Cmd+K's default-agent path.
    func fastCreateWorkspace(
        agent: TerminalAgent,
        mode: AgentTemplate.PermissionMode,
        projectId: UUID,
        tabManager: TabManager
    ) throws {
        _ = tabManager
        guard ProjectStore.shared.project(id: projectId) != nil else {
            throw SidebarInlineCreateError.missingProject(projectId)
        }

        let titles: [String] = (AppDelegate.shared?.tabManager?.tabs ?? [])
            .compactMap { tab in
                tab.projectId == projectId ? tab.title : nil
            }
        let name = Self.suggestedAgentWorkspaceName(
            agentId: agent.id,
            existingTitlesInProject: titles
        )
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                promptText: "",
                advancedTitle: name,
                advancedTerminalAgentId: agent.id,
                advancedPermission: mode,
                launchSource: .manualWorkspaceCreate,
                reasonTag: "quickAction.freePrompt",
                projectId: projectId,
                openAdvanced: true
            )
        )
    }

    func cancel() {
        request = nil
    }

    func commit(name: String, tabManager: TabManager?) throws {
        guard let request else { return }

        switch request.kind {
        case .workspace(let projectId):
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw SidebarInlineCreateError.invalidWorkspaceName }
            guard let tabManager else { throw SidebarInlineCreateError.missingTabManager }
            guard let project = ProjectStore.shared.project(id: projectId) else {
                throw SidebarInlineCreateError.missingProject(projectId)
            }
            if let agentId = request.terminalAgentId {
                QuickActionController.shared.present(
                    prefill: QuickActionPresentationRequest(
                        initialSurface: .run,
                        promptText: "",
                        advancedTitle: trimmed,
                        advancedTerminalAgentId: agentId,
                        launchSource: .manualWorkspaceCreate,
                        reasonTag: "quickAction.freePrompt",
                        projectId: projectId,
                        openAdvanced: true
                    )
                )
            } else {
                _ = tabManager.addWorkspace(
                    title: trimmed,
                    workingDirectory: project.folderPath,
                    select: true,
                    projectId: projectId,
                    terminalAgentId: nil
                )
            }
            self.request = nil
        }
    }
}
