// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

@MainActor
struct ActiveAgentWorkspaceContextMenuBuildContext {
    let validationMetadataByWorkspaceId: [UUID: BridgeCreationValidator.ValidationMetadata]
    let bridgedWorkspaceIds: Set<UUID>
    let worktreeWorkspaceIds: Set<UUID>

    static func live(tabs: [Workspace]) -> Self {
        let metadataStore = WorkspaceMetadataStore.shared
        let bridgeStore = WorkspaceBridgeStore.shared
        let validationMetadataByWorkspaceId = Dictionary(
            uniqueKeysWithValues: tabs.map { workspace in
                (
                    workspace.id,
                    BridgeCreationValidator.ValidationMetadata(
                        projectId: metadataStore.projectId(forWorkspaceId: workspace.id),
                        terminalAgentId: metadataStore.terminalAgentId(for: workspace.id)
                    )
                )
            }
        )
        let bridgedWorkspaceIds = Set(
            bridgeStore.bridges.flatMap { [$0.leftWorkspaceId, $0.rightWorkspaceId] }
        )
        let worktreeWorkspaceIds = Set(tabs.compactMap { workspace in
            metadataStore.branch(for: workspace) == nil ? nil : workspace.id
        })
        return Self(
            validationMetadataByWorkspaceId: validationMetadataByWorkspaceId,
            bridgedWorkspaceIds: bridgedWorkspaceIds,
            worktreeWorkspaceIds: worktreeWorkspaceIds
        )
    }

    func validateBridge(source: UUID, target: UUID) -> BridgeCreationResult {
        BridgeCreationValidator.validate(
            source: source,
            target: target,
            metadataSnapshot: { workspaceId in
                validationMetadataByWorkspaceId[workspaceId] ?? BridgeCreationValidator.ValidationMetadata(
                    projectId: nil,
                    terminalAgentId: nil
                )
            },
            isAlreadyBridged: { bridgedWorkspaceIds.contains($0) }
        )
    }

    func isWorktree(workspaceId: UUID) -> Bool {
        worktreeWorkspaceIds.contains(workspaceId)
    }
}

struct ActiveAgentWorkspaceContextMenuSnapshot: Equatable {
    struct ForkTarget: Identifiable, Equatable {
        let agentId: String
        let displayName: String
        let launchSource: AgentInvocationSource

        var id: String { "\(agentId)|\(launchSource.isNativeFork ? "native" : "handoff")" }
    }

    struct LinkTarget: Identifiable, Equatable {
        let workspaceId: UUID
        let label: String

        var id: UUID { workspaceId }
    }

    struct LinkGroup: Equatable {
        let header: String?
        let icon: String
        let targets: [LinkTarget]
    }

    let workspaceId: UUID
    let copyIdentifier: String
    let isWorktree: Bool
    let canAskTo: Bool
    let canAnalyze: Bool
    let nativeForkTargets: [ForkTarget]
    let handoffTargets: [ForkTarget]
    let linkGroups: [LinkGroup]

    @MainActor
    static func build(
        workspaceId: UUID,
        tabs: [Workspace],
        context: ActiveAgentWorkspaceContextMenuBuildContext? = nil
    ) -> Self? {
        guard let workspace = tabs.first(where: { $0.id == workspaceId }) else { return nil }
        return build(workspace: workspace, tabs: tabs, context: context)
    }

    @MainActor
    static func build(
        workspace: Workspace,
        tabs: [Workspace],
        context: ActiveAgentWorkspaceContextMenuBuildContext? = nil
    ) -> Self {
        let buildContext = context ?? ActiveAgentWorkspaceContextMenuBuildContext.live(tabs: tabs)
        let sessionReference = WorkspaceSessionReferenceResolver.resolve(for: workspace)
        let resolvedAgentId = TerminalAgentActivityStore.shared.resolvedAgentId(forWorkspace: workspace)
        var nativeForkTargets: [ForkTarget] = []
        var handoffTargets: [ForkTarget] = []
        for agent in TerminalAgentRegistry.shared.agents {
            let launchSource = TermLoopHooks.preferredForkLaunchSource(
                workspace: workspace,
                targetAgentId: agent.id
            )
            let target = ForkTarget(
                agentId: agent.id,
                displayName: agent.displayName,
                launchSource: launchSource
            )
            if launchSource.isNativeFork {
                nativeForkTargets.append(target)
            } else {
                handoffTargets.append(target)
            }
        }

        let canAnalyze: Bool = {
            guard let ref = sessionReference else { return false }
            return AssistantSessionScannerRegistry.supports(agentId: ref.agentId)
        }()

        return ActiveAgentWorkspaceContextMenuSnapshot(
            workspaceId: workspace.id,
            copyIdentifier: sessionReference?.sessionId ?? workspace.id.uuidString,
            isWorktree: buildContext.isWorktree(workspaceId: workspace.id),
            canAskTo: resolvedAgentId == TerminalAgent.claudeId || resolvedAgentId == "codex",
            canAnalyze: canAnalyze,
            nativeForkTargets: nativeForkTargets,
            handoffTargets: handoffTargets,
            linkGroups: buildLinkGroups(source: workspace, tabs: tabs, context: buildContext)
        )
    }

    @MainActor
    private static func buildLinkGroups(
        source: Workspace,
        tabs: [Workspace],
        context: ActiveAgentWorkspaceContextMenuBuildContext
    ) -> [LinkGroup] {
        let sourceIndex = tabs.firstIndex(where: { $0.id == source.id }) ?? 0

        let accepted: [(target: LinkTarget, distance: Int)] = tabs
            .enumerated()
            .compactMap { idx, target in
                let result = context.validateBridge(
                    source: source.id,
                    target: target.id
                )
                if case .ok = result {
                    let custom = target.customTitle?.trimmingCharacters(in: .whitespaces)
                    let label = (custom?.isEmpty == false ? custom! : target.title)
                    return (
                        LinkTarget(workspaceId: target.id, label: label),
                        abs(idx - sourceIndex)
                    )
                }
                return nil
            }

        let targets = accepted
            .sorted { $0.distance < $1.distance }
            .map(\.target)

        guard !targets.isEmpty else { return [] }
        return [LinkGroup(header: nil, icon: "folder", targets: targets)]
    }
}

struct ActiveAgentWorkspaceContextMenu: View {
    let snapshot: ActiveAgentWorkspaceContextMenuSnapshot
    let tabManager: TabManager

    private var workspace: Workspace? {
        tabManager.tabs.first(where: { $0.id == snapshot.workspaceId })
    }

    var body: some View {
        if let workspace {
            TermLoopHooks.workspaceForkMenu(workspace: workspace, snapshot: snapshot, isMulti: false)
            TermLoopHooks.workspaceAskToMenu(workspace: workspace, canAskTo: snapshot.canAskTo, isMulti: false)
            TermLoopHooks.workspaceLinkToMenu(snapshot: snapshot, isMulti: false)

            if snapshot.canAnalyze {
                Button(String(
                    localized: "contextMenu.sendToAnalyze",
                    defaultValue: "Send to Analyze",
                    table: "TermLoop"
                )) {
                    handleSendToAnalyze(workspace: workspace)
                }
            }

            Divider()

            if snapshot.isWorktree {
                Button(String(
                    localized: "contextMenu.createPR",
                    defaultValue: "Create PR",
                    table: "TermLoop"
                )) {
                    presentCreatePR(for: workspace)
                }
            }

            Button(worktreeActionTitle(isWorktree: snapshot.isWorktree)) {
                handlePrimaryWorktreeAction(for: workspace)
            }

            if snapshot.isWorktree {
                Button(deleteWorktreeActionTitle(for: workspace)) {
                    handleDeleteBranch(workspace: workspace)
                }
            }

            if snapshot.isWorktree,
               JiraTicketBindingPrompt.isJiraAbilityActive(forWorkspace: workspace) {
                Button(String(
                    localized: "contextMenu.setJiraTicket",
                    defaultValue: "Set Jira Ticket URL…",
                    table: "TermLoop"
                )) {
                    JiraTicketBindingPrompt.present(forWorkspaceId: workspace.id)
                }
            }

            Divider()

            Button(String(
                localized: "contextMenu.killAgent",
                defaultValue: "Kill Agent",
                table: "TermLoop"
            )) {
                tabManager.closeWorkspacesWithConfirmation([snapshot.workspaceId], allowPinned: true)
            }

            Button(String(
                localized: "contextMenu.copyId",
                defaultValue: "Copy ID",
                table: "TermLoop"
            )) {
                copyTextToPasteboard(snapshot.copyIdentifier)
            }
        }
    }

    private func worktreeActionTitle(isWorktree: Bool) -> String {
        if isWorktree {
            return String(
                localized: "contextMenu.returnToLocalBranch",
                defaultValue: "Return to Local Branch",
                table: "TermLoop"
            )
        }
        return String(
            localized: "contextMenu.moveToWorktree",
            defaultValue: "Move to Worktree…",
            table: "TermLoop"
        )
    }

    private func deleteWorktreeActionTitle(for workspace: Workspace) -> String {
        if WorktreeResolver.normalizePath(WorkspaceMetadataStore.shared.worktreePath(for: workspace)) != nil {
            return String(
                localized: "contextMenu.deleteWorktree",
                defaultValue: "Delete Worktree…",
                table: "TermLoop"
            )
        }
        return String(
            localized: "contextMenu.deleteBranch",
            defaultValue: "Delete Branch…",
            table: "TermLoop"
        )
    }

    private func handlePrimaryWorktreeAction(for workspace: Workspace) {
        if snapshot.isWorktree {
            handleDetach(workspace: workspace)
            return
        }

        QuickActionController.shared.present(
            initialSurface: .worktree,
            targetWorkspaceId: workspace.id,
            worktreeIntent: .migrateConversationIfPossible
        )
    }

    private func handleDetach(workspace: Workspace) {
        do {
            let workspaces = detachTargetWorkspaces(for: workspace)
            let inspection = try WorktreeCoordinator.shared.inspectDetachToCurrentLocalBranch(
                workspaces: workspaces,
                worktreePath: WorkspaceMetadataStore.shared.worktreePath(for: workspace)
            )

            guard inspection.runningWorkspaceIds.isEmpty else {
                presentError(String(
                    localized: "worktreeAgents.group.move.runningError",
                    defaultValue: "Stop running agents in this worktree before moving it back to \(inspection.currentLocalBranch).",
                    table: "TermLoop"
                ))
                return
            }

            guard !inspection.hasUnmergedCommits else {
                presentError(String(
                    localized: "worktreeAgents.group.move.unmergedError",
                    defaultValue: "Branch \(inspection.worktreeBranch) has commits that are not merged into \(inspection.currentLocalBranch). Merge them first.",
                    table: "TermLoop"
                ))
                return
            }

            let policy: WorktreeCoordinator.LocalChangesPolicy
            if inspection.hasLocalChanges {
                guard let selected = selectLocalChangesPolicy(
                    for: inspection,
                    workspaceCount: workspaces.count
                ) else { return }
                policy = selected
            } else {
                guard confirmCleanDetach(
                    inspection: inspection,
                    workspaceCount: workspaces.count
                ) else { return }
                policy = .discardAll
            }

            let result = try WorktreeCoordinator.shared.detachToCurrentLocalBranch(
                workspaces: workspaces,
                worktreePath: WorkspaceMetadataStore.shared.worktreePath(for: workspace),
                localChangesPolicy: policy
            )
            if !result.worktreeRemoved {
                presentInfo(String(
                    localized: "worktreeAgents.group.move.leftOnDisk",
                    defaultValue: "Detached \(result.workspaceCount) workspace(s) to \(result.currentLocalBranch). Local changes were left in the worktree at \(result.worktreePath).",
                    table: "TermLoop"
                ))
            }
        } catch {
            presentError((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    private func detachTargetWorkspaces(for workspace: Workspace) -> [Workspace] {
        guard let projectId = workspace.projectId else {
            return [workspace]
        }

        if let path = WorktreeResolver.normalizePath(WorkspaceMetadataStore.shared.worktreePath(for: workspace)) {
            let workspaceIds = Set(
                WorkspaceMetadataStore.shared.workspaceIds(withWorktreePath: path, projectId: projectId)
            )
            let grouped = tabManager.tabs.filter { workspaceIds.contains($0.id) }
            if !grouped.isEmpty {
                return grouped
            }
        }

        guard let branch = WorkspaceMetadataStore.shared.branch(for: workspace) else {
            return [workspace]
        }
        let workspaceIds = Set(
            WorkspaceMetadataStore.shared.workspaceIds(withBranch: branch, projectId: projectId)
        )
        let grouped = tabManager.tabs.filter { workspaceIds.contains($0.id) }
        return grouped.isEmpty ? [workspace] : grouped
    }

    private func confirmCleanDetach(
        inspection: WorktreeCoordinator.DetachToCurrentLocalBranchInspection,
        workspaceCount: Int
    ) -> Bool {
        let alert = NSAlert()
        alert.messageText = String(
            localized: "worktreeAgents.group.move.cleanTitle",
            defaultValue: "Move to \(inspection.currentLocalBranch)?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeAgents.group.move.cleanBody",
            defaultValue: "This detaches \(workspaceCount) workspace(s) from \(inspection.worktreeBranch) and removes the clean worktree at \(inspection.worktreePath).",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeAgents.group.move.confirm",
            defaultValue: "Move",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func selectLocalChangesPolicy(
        for inspection: WorktreeCoordinator.DetachToCurrentLocalBranchInspection,
        workspaceCount: Int
    ) -> WorktreeCoordinator.LocalChangesPolicy? {
        let alert = NSAlert()
        alert.messageText = String(
            localized: "worktreeAgents.group.move.localChangesTitle",
            defaultValue: "Local changes in worktree",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeAgents.group.move.localChangesBody",
            defaultValue: "TermLoop will move \(workspaceCount) workspace(s) from “\(inspection.worktreeBranch)” back to “\(inspection.currentLocalBranch)”. This worktree has local changes that may only exist in:\n\(inspection.worktreePath)\n\nChoose how to handle those changes.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "worktreeAgents.group.move.optionLeave.short",
            defaultValue: "Keep Worktree",
            table: "TermLoop"
        ))

        if inspection.rootHasLocalChanges {
            alert.informativeText += "\n\n" + String(
                localized: "worktreeAgents.group.move.rootDirtyNote",
                defaultValue: "The current local branch already has local changes, so bringing worktree changes over is disabled until that checkout is clean.",
                table: "TermLoop"
            )
        } else {
            alert.addButton(withTitle: String(
                localized: "worktreeAgents.group.move.optionBring.short",
                defaultValue: "Bring Changes",
                table: "TermLoop"
            ))
        }
        alert.addButton(withTitle: String(
            localized: "worktreeAgents.group.move.optionDiscard.short",
            defaultValue: "Discard Changes",
            table: "TermLoop"
        ))
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return .leaveInWorktree
        case .alertSecondButtonReturn where !inspection.rootHasLocalChanges:
            return .moveToCurrentBranch
        case .alertSecondButtonReturn:
            return .discardAll
        case .alertThirdButtonReturn where !inspection.rootHasLocalChanges:
            return .discardAll
        default:
            return nil
        }
    }

    private func handleDeleteBranch(workspace: Workspace) {
        guard let branch = WorkspaceMetadataStore.shared.branch(for: workspace) else { return }
        WorktreeDeletionCoordinator.shared.confirmAndDelete(
            branch: branch,
            worktreePath: WorkspaceMetadataStore.shared.worktreePath(for: workspace),
            projectId: workspace.projectId,
            fallbackWorkspaceIds: [workspace.id]
        )
    }

    private func presentCreatePR(for workspace: Workspace) {
        guard snapshot.isWorktree else { return }
        guard AgentTemplateStore.shared.template(id: "pr-agent") != nil else {
            presentError("PR Agent template is unavailable.")
            return
        }

        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                targetWorkspaceId: workspace.id,
                composition: .template(id: "pr-agent"),
                advancedTerminalAgentId: resolvedAgentId(for: workspace),
                launchSource: .quickAction,
                reasonTag: "contextMenu.createPR"
            )
        )
    }

    private func resolvedAgentId(for workspace: Workspace) -> String? {
        if let resolved = TerminalAgentActivityStore.shared.resolvedAgentId(forWorkspace: workspace) {
            return resolved
        }
        if let defaultId = TerminalAgentRegistry.shared.agent(id: TermLoopSettings.shared.defaultTerminalAgentId)?.id {
            return defaultId
        }
        return TerminalAgentRegistry.shared.agents.first?.id
    }

    private func handleSendToAnalyze(workspace: Workspace) {
        do {
            _ = try ContextBankAnalysisCoordinator.shared.startAnalyze(forking: workspace)
        } catch {
            presentError(error.localizedDescription)
        }
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "contextMenu.agentMenuErrorTitle",
            defaultValue: "Agent Menu Error",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }

    private func presentInfo(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "worktreeAgents.group.move.infoTitle",
            defaultValue: "Worktree updated",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }

    private func copyTextToPasteboard(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }
}

struct ActiveAgentWorkspaceLinkMenu: View {
    let snapshot: ActiveAgentWorkspaceContextMenuSnapshot

    var body: some View {
        if snapshot.linkGroups.isEmpty {
            Text(String(
                localized: "bridge.contextMenu.noCandidates",
                defaultValue: "No eligible workspaces",
                table: "TermLoop"
            ))
            .disabled(true)
        } else {
            ForEach(Array(snapshot.linkGroups.enumerated()), id: \.offset) { idx, group in
                if idx > 0 { Divider() }
                if let header = group.header {
                    Section(header: Text(header)) {
                        groupButtons(group)
                    }
                } else {
                    groupButtons(group)
                }
            }
        }
    }

    @ViewBuilder
    private func groupButtons(_ group: ActiveAgentWorkspaceContextMenuSnapshot.LinkGroup) -> some View {
        ForEach(group.targets) { target in
            Button {
                NotificationCenter.default.post(
                    name: .termLoopOpenBridgeKickoff,
                    object: nil,
                    userInfo: [
                        "leftWorkspaceId": snapshot.workspaceId.uuidString,
                        "rightWorkspaceId": target.workspaceId.uuidString,
                    ]
                )
            } label: {
                Label(target.label, systemImage: group.icon)
            }
        }
    }
}
