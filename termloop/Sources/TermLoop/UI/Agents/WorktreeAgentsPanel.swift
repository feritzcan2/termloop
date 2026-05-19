import AppKit
import Combine
import SwiftUI

@MainActor
enum WorktreeAgentsPullRequestSummary {
    struct Summary: Equatable {
        let pullRequests: [SidebarPullRequestState]
        let primary: SidebarPullRequestState?
        let headerLabel: String
        let rowLabel: String
        let tooltip: String

        init(pullRequests: [SidebarPullRequestState]) {
            self.pullRequests = pullRequests
            self.primary = pullRequests.first
            self.headerLabel = Self.headerLabel(for: pullRequests)
            self.rowLabel = Self.rowLabel(for: pullRequests)
            self.tooltip = Self.tooltip(for: pullRequests)
        }

        private static func sharedBaseBranch(for pullRequests: [SidebarPullRequestState]) -> String? {
            guard !pullRequests.isEmpty else { return nil }
            let branches = Set(
                pullRequests.compactMap { state in
                    let trimmed = state.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    return trimmed.isEmpty ? nil : trimmed
                }
            )
            guard branches.count == 1 else { return nil }
            return branches.first
        }

        private static func statusLabel(for pullRequests: [SidebarPullRequestState]) -> String? {
            guard let primary = pullRequests.first else { return nil }
            if pullRequests.count == 1 {
                return primary.displayStatus
            }
            let statuses = Set(pullRequests.map(\.displayStatus))
            guard statuses.count == 1 else { return "mixed" }
            return statuses.first
        }

        private static func appendMetadata(to label: String, pullRequests: [SidebarPullRequestState]) -> String {
            var result = label
            let statusLabel = statusLabel(for: pullRequests)
            if let statusLabel, !statusLabel.isEmpty {
                result += " · \(statusLabel)"
            }
            let sharedBaseBranch = sharedBaseBranch(for: pullRequests)
            if let sharedBaseBranch {
                result += " → \(sharedBaseBranch)"
            }
            return result
        }

        private static func headerLabel(for pullRequests: [SidebarPullRequestState]) -> String {
            guard let primary = pullRequests.first else { return "" }
            let label = pullRequests.count == 1 ? "\(primary.label) #\(primary.number)" : "\(pullRequests.count) PRs"
            // Headline pill stays terse: count/number + status. Base branch
            // (`→ <name>`) is dropped here because long base names like
            // `complete-development` pushed the pill wide enough to truncate
            // adjacent commit/change tokens to garbage like `4 c…ges`. Full
            // metadata still lives in the tooltip and the popover.
            let statusLabel = statusLabel(for: pullRequests)
            if let statusLabel, !statusLabel.isEmpty {
                return "\(label) · \(statusLabel)"
            }
            return label
        }

        private static func rowLabel(for pullRequests: [SidebarPullRequestState]) -> String {
            guard let primary = pullRequests.first else { return "" }
            let label = pullRequests.count == 1 ? "#\(primary.number)" : "\(pullRequests.count) PRs"
            return appendMetadata(to: label, pullRequests: pullRequests)
        }

        private static func tooltip(for pullRequests: [SidebarPullRequestState]) -> String {
            pullRequests
                .map { state in
                    let baseBranch = state.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let baseBranchSuffix = baseBranch.isEmpty ? "" : " → \(baseBranch)"
                    return "\(state.label) #\(state.number) · \(state.displayStatus)\(baseBranchSuffix)"
                }
                .joined(separator: "\n")
        }
    }

    static func summary(
        for workspaces: [Workspace],
        statuses: Set<SidebarPullRequestStatus>? = nil
    ) -> Summary? {
        let pullRequests = orderedUniquePullRequests(for: workspaces, statuses: statuses)
        guard !pullRequests.isEmpty else { return nil }
        return Summary(pullRequests: pullRequests)
    }

    static func summary(
        for pullRequests: [SidebarPullRequestState],
        statuses: Set<SidebarPullRequestStatus>? = nil
    ) -> Summary? {
        let filtered: [SidebarPullRequestState]
        if let statuses {
            filtered = pullRequests.filter { statuses.contains($0.status) }
        } else {
            filtered = pullRequests
        }
        let ordered = orderedUniquePullRequests(from: filtered)
        guard !ordered.isEmpty else { return nil }
        return Summary(pullRequests: ordered)
    }

    static func orderedUniquePullRequests(
        for workspaces: [Workspace],
        statuses: Set<SidebarPullRequestStatus>? = nil
    ) -> [SidebarPullRequestState] {
        orderedUniquePullRequests(
            from: workspaces.flatMap { workspace in
                workspace.sidebarPullRequestsInDisplayOrder().filter { state in
                    statuses?.contains(state.status) ?? true
                }
            }
        )
    }

    static func normalizedReviewURLKey(for url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }

        components.query = nil
        components.fragment = nil

        let scheme = components.scheme?.lowercased() ?? ""
        let host = components.host?.lowercased() ?? ""
        let port = components.port.map { ":\($0)" } ?? ""
        var path = components.path
        if path.hasSuffix("/"), path.count > 1 {
            path.removeLast()
        }
        return "\(scheme)://\(host)\(port)\(path)"
    }

    static func orderedUniquePullRequests(
        from states: [SidebarPullRequestState]
    ) -> [SidebarPullRequestState] {
        func statusPriority(_ status: SidebarPullRequestStatus) -> Int {
            switch status {
            case .merged: return 3
            case .open: return 2
            case .closed: return 1
            }
        }

        func freshnessPriority(_ isStale: Bool) -> Int {
            isStale ? 0 : 1
        }

        func reviewKey(for state: SidebarPullRequestState) -> String {
            "\(state.label.lowercased())#\(state.number)|\(Self.normalizedReviewURLKey(for: state.url))"
        }

        var orderedKeys: [String] = []
        var pullRequestsByKey: [String: SidebarPullRequestState] = [:]

        for state in states {
            let key = reviewKey(for: state)
            if pullRequestsByKey[key] == nil {
                orderedKeys.append(key)
                pullRequestsByKey[key] = state
                continue
            }

            guard let existing = pullRequestsByKey[key] else { continue }
            if freshnessPriority(state.isStale) > freshnessPriority(existing.isStale) {
                pullRequestsByKey[key] = state
            } else if freshnessPriority(state.isStale) == freshnessPriority(existing.isStale),
                      statusPriority(state.status) > statusPriority(existing.status) {
                pullRequestsByKey[key] = state
            }
        }

        return orderedKeys.compactMap { pullRequestsByKey[$0] }
    }
}

struct WorktreeAgentsGroup: Identifiable {
    let id: String
    let branch: String
    let workspaces: [Workspace]
    let worktreePath: String?
    let projectId: UUID?

    let statusKind: WorktreeStatus.Kind?
    let observedRef: WorktreeObservedRef?
    let expectedBranches: [String]
    let needsAttention: Bool

    init(
        id: String? = nil,
        branch: String,
        workspaces: [Workspace],
        worktreePath: String?,
        projectId: UUID? = nil,
        statusKind: WorktreeStatus.Kind? = nil,
        observedRef: WorktreeObservedRef? = nil,
        expectedBranches: [String]? = nil,
        needsAttention: Bool = false
    ) {
        self.id = id ?? branch
        self.branch = branch
        self.workspaces = workspaces
        self.worktreePath = worktreePath
        self.projectId = projectId
        self.statusKind = statusKind
        self.observedRef = observedRef
        self.expectedBranches = expectedBranches ?? [branch]
        self.needsAttention = needsAttention
    }
}

@MainActor
struct WorktreeGroupContextMenu: View {
    let group: WorktreeAgentsGroup
    let sourceWorkspace: Workspace?
    let tabManager: TabManager
    var onChanged: (() -> Void)? = nil
    var onDeleted: (() -> Void)? = nil

    var body: some View {
        Button {
            WorktreeRepairCoordinator.shared.refreshStatus(
                group: group,
                sourceWorkspace: sourceWorkspace,
                onRefresh: { onChanged?() }
            )
        } label: {
            Label(
                String(
                    localized: "worktreeAgents.group.refreshStatus",
                    defaultValue: "Refresh Git Worktree Status",
                    table: "TermLoop"
                ),
                systemImage: "arrow.clockwise"
            )
        }

        LocalSetupWorktreeMenuItems(projectId: projectId, worktreePath: group.worktreePath)

        if let worktreePath = group.worktreePath {
            let openTarget = projectId.flatMap { ProjectStore.shared.project(id: $0)?.worktreeOpenTarget }
            Menu {
                Button {
                    WorktreeRepairCoordinator.shared.openFolder(path: worktreePath)
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.openFolder",
                            defaultValue: "Open Folder",
                            table: "TermLoop"
                        ),
                        systemImage: "folder"
                    )
                }

                Button {
                    WorktreeRepairCoordinator.shared.openConfiguredTarget(
                        projectId: projectId,
                        worktreePath: worktreePath
                    )
                } label: {
                    Label(openTargetLabel(for: openTarget), systemImage: "arrow.up.right.square")
                }

                Button {
                    WorktreeRepairCoordinator.shared.configureOpenTarget(
                        projectId: projectId,
                        worktreePath: worktreePath
                    )
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.configureOpenTarget",
                            defaultValue: "Configure Open Target…",
                            table: "TermLoop"
                        ),
                        systemImage: "slider.horizontal.3"
                    )
                }

                if openTarget != nil {
                    Button {
                        WorktreeRepairCoordinator.shared.clearOpenTarget(projectId: projectId)
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.clearOpenTarget",
                                defaultValue: "Clear Open Target",
                                table: "TermLoop"
                            ),
                            systemImage: "xmark.circle"
                        )
                    }
                }

                Divider()

                Button {
                    WorktreeRepairCoordinator.shared.reveal(path: worktreePath)
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.revealWorktree",
                            defaultValue: "Reveal in Finder",
                            table: "TermLoop"
                        ),
                        systemImage: "magnifyingglass"
                    )
                }

                Button {
                    WorktreeRepairCoordinator.shared.copyPath(worktreePath)
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.copyPath",
                            defaultValue: "Copy Path",
                            table: "TermLoop"
                        ),
                        systemImage: "doc.on.doc"
                    )
                }
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.openWorktreeMenu",
                        defaultValue: "Open Worktree",
                        table: "TermLoop"
                    ),
                    systemImage: "arrow.up.right.square"
                )
            }
        }

        if group.statusKind == .branchDrift,
           canPerformBranchActions,
           group.worktreePath != nil {
            Button {
                WorktreeRepairCoordinator.shared.switchToExpectedBranch(
                    group: group,
                    sourceWorkspace: sourceWorkspace,
                    onRefresh: { onChanged?() }
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.switchToExpectedBranch",
                        defaultValue: "Switch Git Back to Expected Branch…",
                        table: "TermLoop"
                    ),
                    systemImage: "arrow.triangle.2.circlepath"
                )
            }
        }

        if group.statusKind == .branchDrift,
           group.observedRef?.branchName != nil,
           group.worktreePath != nil {
            Button {
                WorktreeRepairCoordinator.shared.acceptObservedBranch(
                    group: group,
                    onRefresh: { onChanged?() }
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.acceptObservedBranch",
                        defaultValue: "Use Current Git Branch as Expected…",
                        table: "TermLoop"
                    ),
                    systemImage: "checkmark.circle"
                )
            }
        }

        if group.statusKind == .missingRegistration, group.worktreePath != nil {
            Button {
                WorktreeRepairCoordinator.shared.repairRegistration(
                    group: group,
                    sourceWorkspace: sourceWorkspace,
                    onRefresh: { onChanged?() }
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.repairRegistration",
                        defaultValue: "Repair Git Registration…",
                        table: "TermLoop"
                    ),
                    systemImage: "wrench.and.screwdriver"
                )
            }
        }

        if group.statusKind == .prunable {
            Button {
                WorktreeRepairCoordinator.shared.pruneStaleRegistrations(
                    group: group,
                    sourceWorkspace: sourceWorkspace,
                    onRefresh: { onChanged?() }
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.pruneRegistrations",
                        defaultValue: "Prune Stale Registrations…",
                        table: "TermLoop"
                    ),
                    systemImage: "scissors"
                )
            }
        }

        Divider()

        if group.needsAttention {
            Button {
                WorktreeRepairCoordinator.shared.detachGroupFromWorktree(
                    group: group,
                    onRefresh: { onChanged?() }
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.detachFromWorktree",
                        defaultValue: "Detach from Worktree…",
                        table: "TermLoop"
                    ),
                    systemImage: "rectangle.portrait.and.arrow.right"
                )
            }
        }

        if !group.workspaces.isEmpty {
            Button {
                _ = WorkspaceHideCoordinator.confirmAndCollapse(
                    workspaces: group.workspaces,
                    tabManager: tabManager,
                    targetName: group.branch
                )
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.collapse",
                        defaultValue: "Collapse Worktree…",
                        table: "TermLoop"
                    ),
                    systemImage: "archivebox"
                )
            }
        }

        if canPerformBranchActions, !group.workspaces.isEmpty {
            Button {
                moveGroupToCurrentLocalBranch()
            } label: {
                Label(
                    String(
                        localized: "worktreeAgents.group.moveToCurrentLocalBranch",
                        defaultValue: "Move to current local branch…",
                        table: "TermLoop"
                    ),
                    systemImage: "arrow.turn.up.left"
                )
            }
        }

        Divider()

        Button {
            if let worktreePath = group.worktreePath {
                RemoteItemBindingPrompt.present(
                    forWorktreePath: worktreePath,
                    workspaceIds: group.workspaces.map(\.id)
                )
            } else {
                RemoteItemBindingPrompt.present(forGroupWorkspaces: group.workspaces)
            }
        } label: {
            Label(
                String(
                    localized: "worktreeAgents.group.setRemoteItem",
                    defaultValue: "Set Remote Item…",
                    table: "TermLoop"
                ),
                systemImage: "link"
            )
        }

        Divider()

        if canDeleteGroup {
            Button {
                WorktreeDeletionCoordinator.shared.confirmAndDelete(
                    branch: singleExpectedBranch,
                    worktreePath: canDeletePhysicalWorktree ? group.worktreePath : nil,
                    projectId: projectId,
                    fallbackWorkspaceIds: group.workspaces.map(\.id),
                    onDeleted: { onDeleted?() }
                )
            } label: {
                Label(
                    deleteLabel,
                    systemImage: "trash.fill"
                )
            }
        }
    }

    private var projectId: UUID? {
        sourceWorkspace?.projectId ?? group.projectId ?? group.workspaces.first?.projectId
    }

    private var canPerformBranchActions: Bool {
        group.expectedBranches.count == 1
    }

    private var singleExpectedBranch: String? {
        canPerformBranchActions ? group.expectedBranches.first : nil
    }

    private var canDeletePhysicalWorktree: Bool {
        guard group.worktreePath != nil else { return false }
        switch group.statusKind {
        case .missingRegistration, .missingPath, .unknown, .prunable:
            return false
        default:
            return true
        }
    }

    private var canDeleteGroup: Bool {
        canDeletePhysicalWorktree || canPerformBranchActions
    }

    private var deleteLabel: String {
        if canDeletePhysicalWorktree {
            return String(
                localized: "worktreeAgents.group.deleteWorktree",
                defaultValue: "Delete Worktree…",
                table: "TermLoop"
            )
        }
        return String(
            localized: "worktreeAgents.group.deleteBranch",
            defaultValue: "Delete Branch…",
            table: "TermLoop"
        )
    }

    private func openTargetLabel(for target: WorktreeOpenTarget?) -> String {
        guard let target else {
            return String(
                localized: "worktreeAgents.group.openTarget.configureFirst",
                defaultValue: "Open Target…",
                table: "TermLoop"
            )
        }
        let rawRelative = target.relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let relative = rawRelative.isEmpty ? "." : rawRelative
        if let appName = target.applicationDisplayName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !appName.isEmpty {
            return String(
                localized: "worktreeAgents.group.openTarget.withApp",
                defaultValue: "Open \(relative) in \(appName)",
                table: "TermLoop"
            )
        }
        return String(
            localized: "worktreeAgents.group.openTarget.default",
            defaultValue: "Open \(relative)",
            table: "TermLoop"
        )
    }

    private func moveGroupToCurrentLocalBranch() {
        do {
            let inspection = try WorktreeCoordinator.shared.inspectDetachToCurrentLocalBranch(
                workspaces: group.workspaces,
                worktreePath: group.worktreePath
            )

            guard inspection.runningWorkspaceIds.isEmpty else {
                presentGroupMoveError(
                    String(
                        localized: "worktreeAgents.group.move.runningError",
                        defaultValue: "Stop running agents in this worktree before moving it back to \(inspection.currentLocalBranch).",
                        table: "TermLoop"
                    )
                )
                return
            }

            guard !inspection.hasUnmergedCommits else {
                presentGroupMoveError(
                    String(
                        localized: "worktreeAgents.group.move.unmergedError",
                        defaultValue: "Branch \(inspection.worktreeBranch) has commits that are not merged into \(inspection.currentLocalBranch). Merge them first.",
                        table: "TermLoop"
                    )
                )
                return
            }

            let policy: WorktreeCoordinator.LocalChangesPolicy
            if inspection.hasLocalChanges {
                guard let selected = selectLocalChangesPolicy(
                    for: inspection,
                    workspaceCount: group.workspaces.count
                ) else { return }
                policy = selected
            } else {
                guard confirmCleanGroupMove(
                    inspection: inspection,
                    workspaceCount: group.workspaces.count
                ) else { return }
                policy = .discardAll
            }

            let result = try WorktreeCoordinator.shared.detachToCurrentLocalBranch(
                workspaces: group.workspaces,
                worktreePath: group.worktreePath,
                localChangesPolicy: policy
            )
            onChanged?()
            if !result.worktreeRemoved {
                presentGroupMoveInfo(
                    String(
                        localized: "worktreeAgents.group.move.leftOnDisk",
                        defaultValue: "Detached \(result.workspaceCount) workspace(s) to \(result.currentLocalBranch). Local changes were left in the worktree at \(result.worktreePath).",
                        table: "TermLoop"
                    )
                )
            }
        } catch {
            presentGroupMoveError((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    private func confirmCleanGroupMove(
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

    private func presentGroupMoveError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeAgents.group.move.errorTitle",
            defaultValue: "Worktree move failed",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }

    private func presentGroupMoveInfo(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = message
        alert.runModal()
    }
}

@MainActor
final class WorktreeDeletionCoordinator {
    static let shared = WorktreeDeletionCoordinator()

    enum DeletionMode {
        case worktreeOnly
        case branchOnly
        case branchAndWorktree
    }

    private struct Target {
        let project: Project
        let requestedBranch: String?
        let registeredBranch: String?
        let worktreePath: String?
        let workspaceIds: [UUID]
        let liveWorkspaces: [Workspace]
        let hasLocalChanges: Bool
        let runningWorkspaceIds: [UUID]
        let assignedTicketKeys: [String]

        var branchToDelete: String? {
            if worktreePath != nil {
                guard registeredBranch == requestedBranch else { return nil }
                return registeredBranch
            }
            return requestedBranch
        }
    }

    private let worktreeService = GitWorktreeService()

    private init() {}

    func confirmAndDelete(
        branch: String?,
        worktreePath: String?,
        projectId: UUID?,
        fallbackWorkspaceIds: [UUID],
        onDeleted: (() -> Void)? = nil
    ) {
        #if DEBUG
        dlog("worktree.delete.confirm.begin branch=\(branch ?? "nil") worktreePath=\(worktreePath ?? "nil") projectId=\(projectId?.uuidString.prefix(8) ?? "nil") fallbackIds=\(fallbackWorkspaceIds.map { $0.uuidString.prefix(8) }.joined(separator: ","))")
        #endif
        do {
            let target = try resolveTarget(
                branch: branch,
                worktreePath: worktreePath,
                projectId: projectId,
                fallbackWorkspaceIds: fallbackWorkspaceIds
            )

            guard let mode = confirmDeleteMode(target: target) else { return }

            // Branch-only deletion keeps the worktree open, so we still
            // require any active agents to stop first. If the user chose
            // "Delete Branch + Worktree" or "Delete Worktree", workspaces are closed as part
            // of the delete flow, so running agents are allowed to proceed.
            if mode == .branchOnly, !target.runningWorkspaceIds.isEmpty {
                presentError(
                    String(
                        localized: "worktreeDeletion.error.runningAgents",
                        defaultValue: "Stop running agents in this worktree before deleting it.",
                        table: "TermLoop"
                    )
                )
                return
            }

            try performDelete(target: target, mode: mode)
            onDeleted?()
        } catch {
            presentError((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    private func resolveTarget(
        branch: String?,
        worktreePath: String?,
        projectId: UUID?,
        fallbackWorkspaceIds: [UUID]
    ) throws -> Target {
        let trimmedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedBranch = (trimmedBranch?.isEmpty ?? true) ? nil : trimmedBranch
        let normalizedWorktreePath = WorktreeResolver.normalizePath(worktreePath)
        guard requestedBranch != nil || normalizedWorktreePath != nil else {
            throw WorktreeError.invalidParams(reason: "branch or worktree path is required")
        }

        let resolvedProjectId = projectId
            ?? fallbackWorkspaceIds.compactMap { workspaceId in
                let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
                return metadata.projectId ?? AppDelegate.shared?.workspaceFor(tabId: workspaceId)?.projectId
            }.first
        guard let resolvedProjectId,
              let project = ProjectStore.shared.project(id: resolvedProjectId) else {
            throw WorktreeError.notFound(what: "project for worktree deletion")
        }

        let worktrees = try worktreeService.list(in: project.folderPath)
        let entry: GitWorktreeService.ListEntry?
        if let normalizedWorktreePath {
            entry = worktrees.first(where: {
                WorktreeResolver.normalizePath($0.path) == normalizedWorktreePath && !$0.isMain
            })
        } else if let requestedBranch {
            entry = worktrees.first(where: { $0.branch == requestedBranch && !$0.isMain })
        } else {
            entry = nil
        }
        if let normalizedWorktreePath, entry == nil {
            throw WorktreeError.notFound(what: "registered Git worktree at \(normalizedWorktreePath)")
        }

        let liveWorkspaceIds: [UUID]
        if let normalizedWorktreePath {
            let ids = WorkspaceMetadataStore.shared.workspaceIds(
                withWorktreePath: normalizedWorktreePath,
                projectId: project.id
            )
            liveWorkspaceIds = ids.isEmpty ? fallbackWorkspaceIds : ids
        } else if let requestedBranch {
            liveWorkspaceIds = WorkspaceMetadataStore.shared
                .workspaceIds(withBranch: requestedBranch, projectId: project.id)
        } else {
            liveWorkspaceIds = fallbackWorkspaceIds
        }
        let liveWorkspaces = liveWorkspaceIds.compactMap { AppDelegate.shared?.workspaceFor(tabId: $0) }
        let hasLocalChanges = try entry.map { try !worktreeService.isClean(worktreePath: $0.path) } ?? false
        let runningWorkspaceIds = liveWorkspaces.compactMap { workspace in
            TerminalAgentActivityStore.shared.isRunning(forWorkspace: workspace) ? workspace.id : nil
        }
        let assignedTicketKeys = Array(Set(liveWorkspaceIds.compactMap { workspaceId in
            WorkspaceMetadataStore.shared.assignedTicket(for: workspaceId)?.key
        })).sorted()
        #if DEBUG
        dlog(
            "worktree.delete.resolve requestedBranch=\(requestedBranch ?? "nil") registeredBranch=\(entry?.branch ?? "nil") project=\(project.name)[\(project.id.uuidString.prefix(8))] worktreePath=\(entry?.path ?? normalizedWorktreePath ?? "nil") live=\(liveWorkspaces.count) running=\(runningWorkspaceIds.map { $0.uuidString.prefix(8) }.joined(separator: ","))"
        )
        #endif

        return Target(
            project: project,
            requestedBranch: requestedBranch,
            registeredBranch: entry?.branch,
            worktreePath: entry?.path,
            workspaceIds: liveWorkspaceIds,
            liveWorkspaces: liveWorkspaces,
            hasLocalChanges: hasLocalChanges,
            runningWorkspaceIds: runningWorkspaceIds,
            assignedTicketKeys: assignedTicketKeys
        )
    }

    private func confirmDeleteMode(target: Target) -> DeletionMode? {
        let branchToDelete = target.branchToDelete
        let alert = NSAlert()
        alert.alertStyle = .warning
        if target.worktreePath != nil {
            alert.messageText = String(
                localized: "worktreeDeletion.confirm.worktree.title",
                defaultValue: "Delete this Git worktree?",
                table: "TermLoop"
            )
        } else if let branchToDelete {
            alert.messageText = String(
                localized: "worktreeDeletion.confirm.branch.title",
                defaultValue: "Delete branch “\(branchToDelete)”?",
                table: "TermLoop"
            )
        } else {
            return nil
        }

        let closeLine = String(
            localized: "worktreeDeletion.confirm.closeLine",
            defaultValue: "This detaches \(target.workspaceIds.count) workspace(s); \(target.liveWorkspaces.count) currently open workspace(s) will close.",
            table: "TermLoop"
        )
        let runningLine = !target.runningWorkspaceIds.isEmpty
            ? String(
                localized: "worktreeDeletion.confirm.runningLine",
                defaultValue: "There are \(target.runningWorkspaceIds.count) running agent workspace(s) in this worktree; deleting the worktree will close them.",
                table: "TermLoop"
            )
            : ""
        let deleteLine: String
        if let branchToDelete {
            deleteLine = String(
                localized: "worktreeDeletion.confirm.branch.body",
                defaultValue: "The local Git branch “\(branchToDelete)” will be deleted.",
                table: "TermLoop"
            )
        } else if let requestedBranch = target.requestedBranch,
                  let registeredBranch = target.registeredBranch {
            deleteLine = String(
                localized: "worktreeDeletion.confirm.drift.body",
                defaultValue: "Git currently reports “\(registeredBranch)” at this path, so TermLoop will not delete the expected branch “\(requestedBranch)”.",
                table: "TermLoop"
            )
        } else {
            deleteLine = String(
                localized: "worktreeDeletion.confirm.worktreeOnly.body",
                defaultValue: "Only the Git worktree folder will be removed. No branch will be deleted.",
                table: "TermLoop"
            )
        }
        let worktreeLine = target.worktreePath.map {
            String(
                localized: "worktreeDeletion.confirm.worktreeQuestion",
                defaultValue: "Worktree path:\n\($0)",
                table: "TermLoop"
            )
        } ?? ""
        let dirtyLine = target.hasLocalChanges
            ? String(
                localized: "worktreeDeletion.confirm.dirtyLine",
                defaultValue: "Uncommitted changes inside this worktree will be discarded.",
                table: "TermLoop"
            )
            : ""
        let ticketLine: String = {
            guard !target.assignedTicketKeys.isEmpty else { return "" }
            let keys = target.assignedTicketKeys.joined(separator: ", ")
            if target.worktreePath != nil, branchToDelete != nil {
                return String(
                    localized: "worktreeDeletion.confirm.ticketLine.worktreeChoicePrefix",
                    defaultValue: "Jira binding(s) will be preserved if you choose Delete Worktree Only; deleting the branch releases binding(s): ",
                    table: "TermLoop"
                ) + keys
            }
            if branchToDelete != nil {
                return String(
                    localized: "worktreeDeletion.confirm.ticketLine.branchPrefix",
                    defaultValue: "Deleting the branch releases Jira binding(s): ",
                    table: "TermLoop"
                ) + keys
            }
            return String(
                localized: "worktreeDeletion.confirm.ticketLine.preservePrefix",
                defaultValue: "Jira binding(s) will be preserved: ",
                table: "TermLoop"
            ) + keys
        }()

        alert.informativeText = [closeLine, runningLine, deleteLine, worktreeLine, dirtyLine, ticketLine]
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")

        if target.worktreePath != nil, branchToDelete != nil {
            alert.addButton(withTitle: String(
                localized: "worktreeDeletion.confirm.deleteBranchAndWorktree",
                defaultValue: "Delete Branch + Worktree",
                table: "TermLoop"
            ))
            alert.addButton(withTitle: String(
                localized: "worktreeDeletion.confirm.deleteWorktreeOnly",
                defaultValue: "Delete Worktree Only",
                table: "TermLoop"
            ))
        } else if target.worktreePath != nil {
            alert.addButton(withTitle: String(
                localized: "worktreeDeletion.confirm.deleteWorktree",
                defaultValue: "Delete Worktree",
                table: "TermLoop"
            ))
        } else {
            alert.addButton(withTitle: String(
                localized: "worktreeDeletion.confirm.delete",
                defaultValue: "Delete Branch",
                table: "TermLoop"
            ))
        }
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        let response = alert.runModal()
        if target.worktreePath != nil, branchToDelete != nil {
            switch response {
            case .alertFirstButtonReturn:
                return .branchAndWorktree
            case .alertSecondButtonReturn:
                return .worktreeOnly
            default:
                return nil
            }
        }
        if target.worktreePath != nil {
            return response == .alertFirstButtonReturn ? .worktreeOnly : nil
        }

        return response == .alertFirstButtonReturn ? .branchOnly : nil
    }

    private func performDelete(target: Target, mode: DeletionMode) throws {
        #if DEBUG
        dlog("worktree.delete.perform.begin requestedBranch=\(target.requestedBranch ?? "nil") registeredBranch=\(target.registeredBranch ?? "nil") mode=\(mode) project=\(target.project.name)[\(target.project.id.uuidString.prefix(8))] worktreePath=\(target.worktreePath ?? "nil") localChanges=\(target.hasLocalChanges ? 1 : 0) live=\(target.liveWorkspaces.count)")
        #endif
        let removedWorktree = try removeWorktreeIfNeeded(target: target, mode: mode)

        do {
            try deleteBranchIfNeeded(target: target, mode: mode)
        } catch {
            if removedWorktree {
                closeDeletedWorktreeWorkspaces(target: target, mode: .worktreeOnly)
                persistDeleteSideEffects(target: target)
                let detail = (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
                throw WorktreeError.invalidParams(
                    reason: "The worktree folder was deleted, but deleting the branch failed: \(detail)"
                )
            }
            throw error
        }

        if removedWorktree {
            closeDeletedWorktreeWorkspaces(target: target, mode: mode)
        }
        persistDeleteSideEffects(target: target)
        #if DEBUG
        dlog("worktree.delete.perform.result branch=\(target.branchToDelete ?? "nil") mode=\(mode) project=\(target.project.name)[\(target.project.id.uuidString.prefix(8))]")
        #endif
    }

    private func removeWorktreeIfNeeded(target: Target, mode: DeletionMode) throws -> Bool {
        guard mode == .branchAndWorktree || mode == .worktreeOnly else { return false }
        guard let worktreePath = target.worktreePath else { return false }
        try worktreeService.remove(
            folder: target.project.folderPath,
            path: worktreePath,
            force: true
        )
        return true
    }

    private func deleteBranchIfNeeded(target: Target, mode: DeletionMode) throws {
        guard mode == .branchAndWorktree || mode == .branchOnly else { return }
        guard let branchToDelete = target.branchToDelete else {
            throw WorktreeError.invalidParams(reason: "No safe branch deletion target.")
        }
        _ = try GitCommandRunner.runMutation(
            ["branch", "-D", branchToDelete],
            in: target.project.folderPath,
            kind: .mutation,
            caller: "WorktreeDeletionCoordinator.branchDelete",
            invalidates: [.project(target.project.folderPath)]
        )
    }

    private func closeDeletedWorktreeWorkspaces(target: Target, mode: DeletionMode) {
        primeClosableWindows(for: target.liveWorkspaces)

        for workspaceId in target.workspaceIds {
            if mode == .worktreeOnly {
                WorkspaceMetadataStore.shared.setWorktreePath(nil, forWorkspaceId: workspaceId)
            } else {
                WorkspaceMetadataStore.shared.setBranch(nil, forWorkspaceId: workspaceId)
            }
        }

        for workspace in target.liveWorkspaces {
            AppDelegate.shared?.tabManagerFor(tabId: workspace.id)?.closeWorkspace(workspace)
        }
    }

    private func persistDeleteSideEffects(target: Target) {
        AppDelegate.shared?.saveSessionSnapshot(includeScrollback: false, forceSync: true)
        refreshWorktreeRegistryAfterDeletion(projectFolder: target.project.folderPath)
        TaskBoardReconcileScheduler.shared.request(projectId: target.project.id, reason: "worktreeDeleted")
    }

    private func refreshWorktreeRegistryAfterDeletion(projectFolder: String) {
        GitPresentationInvalidationCenter.invalidate(
            [.project(projectFolder)],
            reason: "worktreeDeleted",
            source: "WorktreeDeletionCoordinator"
        )

        do {
            let entries = try worktreeService.list(in: projectFolder)
            WorktreeRegistry.shared.record(projectFolder: projectFolder, entries: entries)
            WorktreeProjectionStore.shared.markChanged(reason: "worktreeDeleted")
        } catch {
            WorktreeProjectionStore.shared.refresh(projectFolder: projectFolder, reason: "worktreeDeleted")
        }
    }

    private func primeClosableWindows(for workspaces: [Workspace]) {
        #if DEBUG
        dlog("worktree.delete.prime.begin workspaces=\(workspaces.map { $0.id.uuidString.prefix(8) }.joined(separator: ","))")
        #endif
        var grouped: [ObjectIdentifier: (tabManager: TabManager, victims: [Workspace])] = [:]
        for workspace in workspaces {
            guard let tabManager = AppDelegate.shared?.tabManagerFor(tabId: workspace.id) else {
                continue
            }
            let key = ObjectIdentifier(tabManager)
            if grouped[key] == nil {
                grouped[key] = (tabManager: tabManager, victims: [])
            }
            grouped[key]?.victims.append(workspace)
        }

        for entry in grouped.values {
            let tabManager = entry.tabManager
            let victims = entry.victims
            guard !victims.isEmpty, tabManager.tabs.count == victims.count else { continue }
            _ = tabManager.addWorkspace(
                title: nil,
                workingDirectory: nil,
                select: true,
                eagerLoadTerminal: false
            )
        }
        #if DEBUG
        dlog("worktree.delete.prime.result groups=\(grouped.count)")
        #endif
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeDeletion.error.title",
            defaultValue: "Delete failed",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }
}

private struct WorktreePullRequestSummarySet {
    let all: WorktreeAgentsPullRequestSummary.Summary?
    let open: WorktreeAgentsPullRequestSummary.Summary?
    let merged: WorktreeAgentsPullRequestSummary.Summary?
}

@MainActor
enum WorktreeAgentsSectionPartition {
    struct Sections {
        let openPullRequests: [WorktreeAgentsGroup]
        let mergedPullRequests: [WorktreeAgentsGroup]
        let worktrees: [WorktreeAgentsGroup]
    }

    static func partition(_ groups: [WorktreeAgentsGroup]) -> Sections {
        var openPullRequests: [WorktreeAgentsGroup] = []
        var mergedPullRequests: [WorktreeAgentsGroup] = []
        var worktrees: [WorktreeAgentsGroup] = []

        for group in groups {
            if WorktreeAgentsPullRequestSummary.summary(
                for: group.workspaces,
                statuses: [.open]
            ) != nil {
                openPullRequests.append(group)
            } else if WorktreeAgentsPullRequestSummary.summary(
                for: group.workspaces,
                statuses: [.merged]
            ) != nil {
                mergedPullRequests.append(group)
            } else {
                worktrees.append(group)
            }
        }

        return Sections(
            openPullRequests: openPullRequests,
            mergedPullRequests: mergedPullRequests,
            worktrees: worktrees
        )
    }
}

enum WorktreeAgentsPanelState {
    static let collapsedKey = "termloop.activeWorktrees.collapsed.v1"
    // Branch-level rows default to expanded; this set holds branches the user
    // explicitly collapsed.
    static let collapsedBranchesKey = "termloop.activeWorktrees.collapsedBranches.v1"
    static let openPullRequestsCollapsedKey = "termloop.openPullRequests.collapsed.v1"
    static let mergedPullRequestsCollapsedKey = "termloop.mergedPullRequests.collapsed.v1"
    static let hiddenKey = "termloop.activeWorktrees.hidden.v1"

    static func reveal(branch: String, defaults: UserDefaults = .standard) {
        let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedBranch.isEmpty else { return }

        defaults.set(false, forKey: collapsedKey)

        var collapsedBranches = Set(
            (defaults.string(forKey: collapsedBranchesKey) ?? "")
                .split(separator: "\n")
                .map(String.init)
        )
        collapsedBranches.remove(trimmedBranch)
        defaults.set(collapsedBranches.sorted().joined(separator: "\n"), forKey: collapsedBranchesKey)
    }
}

private enum WorktreeAgentsSectionKind {
    case openPullRequests
    case mergedPullRequests
    case worktrees

    var initialVisibleLimit: Int {
        switch self {
        case .openPullRequests:
            return 5
        case .mergedPullRequests:
            return 4
        case .worktrees:
            return 6
        }
    }

    var isArchived: Bool {
        if case .mergedPullRequests = self { return true }
        return false
    }
}

private enum WorktreeAgentsPanelTypography {
    static let headerLabel: Font = .system(size: 13, weight: .semibold, design: .monospaced)
    static let branchLabel: Font = .system(size: 11, weight: .regular, design: .monospaced)
    static let branchValue: Font = .system(size: 11.5, weight: .medium, design: .monospaced)
}

/// Sidebar panel that sits above `ActiveAgentsPanel` and groups every
/// workspace running on a `.termloop-worktrees/<branch>/` worktree by branch.
/// Unlike `ActiveAgentsPanel` (flat list of agent runs), this panel answers
/// one question at a glance: "which worktrees do I have open right now, and
/// what agent is in each?"
///
/// A workspace is considered worktree-backed when
/// `WorkspaceMetadataStore.branch(for:)` returns a non-empty branch — the
/// same signal the sidebar uses to render its "WORKTREE" badge.
@MainActor
struct WorktreeAgentsPanel: View {
    let showsEmptySections: Bool

    fileprivate struct WorkspaceIdentity: Equatable {
        let id: UUID
        let title: String
        let customTitle: String?
    }

    fileprivate struct WorktreeRowSnapshot: Equatable {
        let core: AgentRowPresentationSnapshot
        let contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot?
    }

    fileprivate struct WorktreeGroupRemoteItemBadgeSnapshot: Equatable, Hashable, Identifiable {
        let id: String
        let label: String
        let provider: RemoteWorkItemProviderId
        let destinationURL: URL?
        let tooltip: String

        init(
            binding: WorktreeRemoteItemBindingStore.Binding,
            snapshot: RemoteWorkItemSnapshot?
        ) {
            let status = snapshot?.statusLabel
            let url = snapshot?.reference.url ?? binding.reference.url
            self.id = binding.reference.storageKey
            self.provider = binding.reference.provider
            if let status, !status.isEmpty {
                self.label = "\(binding.reference.key) · \(status)"
            } else {
                self.label = binding.reference.key
            }
            self.destinationURL = url.flatMap(URL.init(string:))
            var parts = [binding.reference.provider.displayLabel, binding.reference.key]
            if let title = snapshot?.title, !title.isEmpty {
                parts.append(title)
            }
            if let status, !status.isEmpty {
                parts.append("status: \(status)")
            }
            if let url, !url.isEmpty {
                parts.append(url)
            }
            self.tooltip = parts.joined(separator: "\n")
        }
    }

    private struct RenderSignature: Equatable {
        let workspaceFingerprint: [WorkspaceIdentity]
        let branchTick: Int
        let worktreeProjectionVersion: UInt64
        let pullRequestTick: UInt64
        let worktreePullRequestLookupSignature: PullRequestLookupSignature
        let activeProjectId: UUID?
        let agentSessionTick: Int
        let projectScopeTick: Int
        let activityTick: Int
        let taskBoardTick: UInt64
        let remoteItemTick: Int
        let remoteSnapshotTick: Int
        let runTargetTick: Int
    }

    private struct PullRequestLookupSignature: Equatable {
        struct Entry: Equatable {
            let input: WorktreeBranchPullRequestStore.LookupInput
            let pullRequests: [SidebarPullRequestState]
        }

        static let empty = PullRequestLookupSignature(entries: [])

        let entries: [Entry]
    }

    private final class RenderMemo {
        private var signature: RenderSignature?
        private var snapshot: RenderSnapshot?

        func value(
            for signature: RenderSignature,
            build: () -> RenderSnapshot
        ) -> RenderSnapshot {
            if self.signature == signature, let snapshot {
                return snapshot
            }
            let next = build()
            self.signature = signature
            self.snapshot = next
            return next
        }
    }

    private struct RenderSnapshot {
        let orderedSections: WorktreeAgentsSectionPartition.Sections
        let groupSummaryByKey: [String: WorktreeAgentsPullRequestSummary.Summary]
        let workspaceSummaryByKey: [String: WorktreeAgentsPullRequestSummary.Summary]
        let workspaceBranchById: [UUID: String]
        let rowSnapshotsByWorkspaceId: [UUID: WorktreeRowSnapshot]
        let orderedWorkspacesByBranch: [String: [Workspace]]
        let branchAttributedStringByBranch: [String: AttributedString]
        let allWorkspaceIds: [UUID]
        let pullRequestLookupInputs: [WorktreeBranchPullRequestStore.LookupInput]
        let branchesNeedingInitialExpansion: [String]
        /// Every PR for a branch — needed because `groupSummaryByKey` only
        /// carries the section's status bucket (open XOR merged), so the
        /// badge popover would otherwise miss the other-status PRs.
        let allPullRequestsByBranch: [String: [SidebarPullRequestState]]
        let runTargetsByBranch: [String: [RunTargetStore.RunTarget]]
        let remoteItemBadgeSnapshotsByBranch: [String: [WorktreeGroupRemoteItemBadgeSnapshot]]
    }

    @EnvironmentObject private var tabManager: TabManager
    @ObservedObject private var projectStore = ProjectStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    private let worktreePullRequestStore = WorktreeBranchPullRequestStore.shared

    /// Narrow subscription — matches `ActiveAgentsPanel`'s rationale: the
    /// metadata store fires `objectWillChange` on every report_* telemetry
    /// event; `$agentSessionVersion` only ticks on role/binding changes.
    @State private var agentSessionTick: Int = 0
    @State private var projectScopeTick: Int = 0
    @State private var branchTick: Int = 0
    @State private var pullRequestTick: UInt64 = 0
    @State private var pullRequestLookupSignature: PullRequestLookupSignature = .empty
    @State private var activityTick: Int = 0
    @State private var taskBoardTick: UInt64 = 0
    @State private var hasDeferredActivityTick = false
    @State private var remoteItemTick: Int = 0
    @State private var remoteSnapshotTick: Int = 0
    @State private var runTargetTick: Int = 0
    @State private var hoveredBranch: String?
    @State private var renderMemo = RenderMemo()
    /// Stable Combine subscription keyed on `subscribedWorkspaceIds`. Without
    /// this, `.onReceive(Publishers.MergeMany(...))` inside `body` re-subscribed
    /// N per-workspace publishers on every tick.
    @State private var pullRequestSubscription: AnyCancellable?
    @State private var activitySubscription: AnyCancellable?
    @State private var taskBoardSubscription: AnyCancellable?
    @State private var subscribedTaskProjectId: UUID?
    @State private var subscribedWorkspaceIds: [UUID] = []
    @State private var observedWorktreeHeadSignature: String?
    @State private var didApplyInitialBranchAutoExpand: Bool = false
    @State private var showsAllOpenPullRequests: Bool = false
    @State private var showsAllMergedPullRequests: Bool = false
    @State private var showsAllWorktrees: Bool = false

    @AppStorage(WorktreeAgentsPanelState.collapsedKey) private var isCollapsed: Bool = false
    @AppStorage(WorktreeAgentsPanelState.openPullRequestsCollapsedKey)
    private var isOpenPullRequestsCollapsed: Bool = false
    @AppStorage(WorktreeAgentsPanelState.mergedPullRequestsCollapsedKey)
    private var isMergedPullRequestsCollapsed: Bool = false
    @AppStorage(WorktreeAgentsPanelState.collapsedBranchesKey) private var collapsedBranchesRaw: String = ""
    @AppStorage(WorktreeAgentsPanelState.hiddenKey) private var isHidden: Bool = false

    init(showsEmptySections: Bool = false) {
        self.showsEmptySections = showsEmptySections
    }

    var body: some View {
        let scopedTabs = projectScopedTabs()
        let _ = agentSessionTick
        let _ = projectScopeTick
        let _ = branchTick
        let _ = pullRequestTick
        let _ = activityTick
        let _ = remoteItemTick
        let _ = remoteSnapshotTick
        let _ = runTargetTick
        let collapsedBranchSet = branchSet(from: collapsedBranchesRaw)
        let fingerprint = scopedTabs.map {
            WorkspaceIdentity(id: $0.id, title: $0.title, customTitle: $0.customTitle)
        }
        let renderSnapshot = renderMemo.value(
            for: RenderSignature(
                workspaceFingerprint: fingerprint,
                branchTick: branchTick,
                worktreeProjectionVersion: worktreeProjectionStore.version,
                pullRequestTick: pullRequestTick,
                worktreePullRequestLookupSignature: pullRequestLookupSignature,
                activeProjectId: projectStore.activeProjectId,
                agentSessionTick: agentSessionTick,
                projectScopeTick: projectScopeTick,
                activityTick: activityTick,
                taskBoardTick: taskBoardTick,
                remoteItemTick: remoteItemTick,
                remoteSnapshotTick: remoteSnapshotTick,
                runTargetTick: runTargetTick
            )
        ) {
            makeRenderSnapshot()
        }
        return Group {
            if !isHidden {
                VStack(spacing: 0) {
                    if showsEmptySections || !renderSnapshot.orderedSections.openPullRequests.isEmpty {
                        sectionView(
                            storageKey: AgentSidebarPanelLayoutState.worktreeOpenPRsHeightKey,
                            title: String(
                                localized: "worktreeAgents.panel.openPullRequests.title",
                                defaultValue: "Open PRs",
                                table: "TermLoop"
                            ),
                            emptyMessage: String(
                                localized: "worktreeAgents.panel.openPullRequests.empty",
                                defaultValue: "No open PRs",
                                table: "TermLoop"
                            ),
                            iconName: "arrow.up.right.square",
                            orderedGroups: renderSnapshot.orderedSections.openPullRequests,
                            sectionKind: .openPullRequests,
                            isCollapsed: $isOpenPullRequestsCollapsed,
                            showsAllGroups: $showsAllOpenPullRequests,
                            pullRequestStatuses: [.open],
                            renderSnapshot: renderSnapshot,
                            collapsedBranchSet: collapsedBranchSet
                        )
                    }
                    if showsEmptySections || !renderSnapshot.orderedSections.mergedPullRequests.isEmpty {
                        sectionView(
                            storageKey: AgentSidebarPanelLayoutState.worktreeMergedPRsHeightKey,
                            title: String(
                                localized: "worktreeAgents.panel.mergedPullRequests.title",
                                defaultValue: "Merged PRs",
                                table: "TermLoop"
                            ),
                            emptyMessage: String(
                                localized: "worktreeAgents.panel.mergedPullRequests.empty",
                                defaultValue: "No merged PRs",
                                table: "TermLoop"
                            ),
                            iconName: "checkmark.circle",
                            orderedGroups: renderSnapshot.orderedSections.mergedPullRequests,
                            sectionKind: .mergedPullRequests,
                            isCollapsed: $isMergedPullRequestsCollapsed,
                            showsAllGroups: $showsAllMergedPullRequests,
                            pullRequestStatuses: [.merged],
                            renderSnapshot: renderSnapshot,
                            collapsedBranchSet: collapsedBranchSet
                        )
                    }
                    if showsEmptySections || !renderSnapshot.orderedSections.worktrees.isEmpty {
                        sectionView(
                            storageKey: AgentSidebarPanelLayoutState.worktreeAgentsHeightKey,
                            title: String(
                                localized: "worktreeAgents.panel.title",
                                defaultValue: "Worktree Agents",
                                table: "TermLoop"
                            ),
                            emptyMessage: String(
                                localized: "worktreeAgents.panel.empty",
                                defaultValue: "No worktree agents",
                                table: "TermLoop"
                            ),
                            iconName: "point.3.connected.trianglepath.dotted",
                            orderedGroups: renderSnapshot.orderedSections.worktrees,
                            sectionKind: .worktrees,
                            isCollapsed: $isCollapsed,
                            showsAllGroups: $showsAllWorktrees,
                            pullRequestStatuses: nil,
                            renderSnapshot: renderSnapshot,
                            collapsedBranchSet: collapsedBranchSet,
                            addWorktreeAction: {
                                QuickActionController.shared.present(initialSurface: .worktree)
                            }
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .onReceive(WorkspaceMetadataStore.shared.$agentSessionVersion) { newValue in
            guard newValue != agentSessionTick else { return }
            agentSessionTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$projectScopeVersion) { newValue in
            guard newValue != projectScopeTick else { return }
            projectScopeTick = newValue
        }
        .onReceive(WorkspaceMetadataStore.shared.$branchVersion) { newValue in
            guard newValue != branchTick else { return }
            branchTick = newValue
        }
        .onReceive(WorktreeRemoteItemBindingStore.shared.$version) { newValue in
            guard newValue != remoteItemTick else { return }
            remoteItemTick = newValue
        }
        .onReceive(RemoteWorkItemSnapshotStore.shared.$version) { newValue in
            guard newValue != remoteSnapshotTick else { return }
            remoteSnapshotTick = newValue
        }
        .onReceive(RunTargetStore.shared.$version) { newValue in
            guard newValue != runTargetTick else { return }
            runTargetTick = newValue
        }
        .onChange(of: renderSnapshot.allWorkspaceIds) { newIds in
            guard newIds != subscribedWorkspaceIds else { return }
            subscribedWorkspaceIds = newIds
            let idSet = Set(newIds)
            let workspaces = tabManager.tabs.filter { idSet.contains($0.id) }
            pullRequestSubscription = pullRequestRefreshPublisher(for: workspaces)
                .sink { _ in pullRequestTick &+= 1 }
            activitySubscription = TerminalAgentActivityStore.shared.workspacePresentationDidChange
                .filter { idSet.contains($0) }
                .sink { _ in
                    if AppMenuTrackingGate.shared.isTrackingMenu {
                        hasDeferredActivityTick = true
                    } else {
                        activityTick &+= 1
                    }
                }
        }
        .onReceive(AppMenuTrackingGate.shared.trackingEnded) { _ in
            guard hasDeferredActivityTick else { return }
            hasDeferredActivityTick = false
            activityTick &+= 1
        }
        .onAppear {
            if !didApplyInitialBranchAutoExpand {
                autoExpandActiveBranches(renderSnapshot.branchesNeedingInitialExpansion)
                didApplyInitialBranchAutoExpand = true
            }
            refreshWorktreeProjection(for: scopedTabs, reason: "appear")
            subscribeToActiveTaskBoardStore()
            refreshWorktreeHeadProjectionIfChanged(for: scopedTabs, reason: "headBaseline", marksProjection: false)
            refreshWorktreePullRequests(renderSnapshot.pullRequestLookupInputs, reason: "appear")
        }
        .onChange(of: scopedTabs.map(\.id)) { _ in
            refreshWorktreeProjection(for: scopedTabs, reason: "tabsChanged")
            observedWorktreeHeadSignature = nil
        }
        .onChange(of: projectStore.activeProjectId) { _ in
            refreshWorktreeProjection(for: scopedTabs, reason: "activeProjectChanged")
            observedWorktreeHeadSignature = nil
            subscribeToActiveTaskBoardStore()
        }
        .onChange(of: renderSnapshot.pullRequestLookupInputs) { inputs in
            refreshPullRequestLookupSignature(inputs: inputs)
            refreshWorktreePullRequests(inputs, reason: "inputsChanged")
        }
        .onReceive(WorktreeBranchPullRequestStore.shared.$version.removeDuplicates()) { _ in
            refreshPullRequestLookupSignature(inputs: renderSnapshot.pullRequestLookupInputs)
        }
        .onReceive(Timer.publish(every: 5, on: .main, in: .common).autoconnect()) { _ in
            // External `git switch` / rebase / bisect edits `.git/HEAD`
            // without touching TermLoop metadata. Poll the cheap HEAD files,
            // but only invalidate SwiftUI when the observed ref actually moves.
            refreshWorktreeHeadProjectionIfChanged(for: scopedTabs, reason: "headChanged")
            refreshWorktreePullRequests(renderSnapshot.pullRequestLookupInputs, reason: "timer")
        }
    }

    private func refreshPullRequestLookupSignature(
        inputs: [WorktreeBranchPullRequestStore.LookupInput]
    ) {
        let next = makePullRequestLookupSignature(inputs: inputs)
        guard next != pullRequestLookupSignature else { return }
        pullRequestLookupSignature = next
    }

    private func makePullRequestLookupSignature(
        inputs: [WorktreeBranchPullRequestStore.LookupInput]
    ) -> PullRequestLookupSignature {
        let entries = inputs
            .sorted {
                if $0.directory != $1.directory {
                    return $0.directory < $1.directory
                }
                return $0.branch < $1.branch
            }
            .map { input in
                PullRequestLookupSignature.Entry(
                    input: input,
                    pullRequests: worktreePullRequestStore.cachedPullRequests(
                        directory: input.directory,
                        branch: input.branch
                    )
                )
            }
        return PullRequestLookupSignature(entries: entries)
    }

    private func refreshWorktreeHeadProjectionIfChanged(
        for workspaces: [Workspace],
        reason: String,
        marksProjection: Bool = true
    ) {
        let signature = worktreeHeadSignature(for: workspaces)
        guard observedWorktreeHeadSignature != nil else {
            observedWorktreeHeadSignature = signature
            return
        }
        guard signature != observedWorktreeHeadSignature else { return }
        observedWorktreeHeadSignature = signature
        if marksProjection {
            worktreeProjectionStore.markChanged(reason: "panel.\(reason)")
        }
    }

    private func worktreeHeadSignature(for workspaces: [Workspace]) -> String {
        workspaces.compactMap { workspace -> String? in
            let expectedBranch = WorkspaceMetadataStore.shared.branch(for: workspace)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !expectedBranch.isEmpty else { return nil }
            let path = WorktreeResolver.normalizePath(
                WorkspaceMetadataStore.shared.worktreePath(forWorkspaceId: workspace.id)
            ) ?? WorktreeResolver.normalizePath(workspace.termLoopPresentationCwd())
            guard let path else { return nil }
            let observed = TermLoopWorktreeHeadReader
                .currentObservedRefWithoutGit(checkoutPath: path)?
                .displayName ?? "unknown"
            return "\(workspace.id.uuidString)|\(path)|\(expectedBranch)|\(observed)"
        }
        .sorted()
        .joined(separator: "\n")
    }

    private func groupSummaryKey(
        groupId: String,
        statuses: Set<SidebarPullRequestStatus>?
    ) -> String {
        let statusKey = statuses?
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",") ?? "all"
        return "\(groupId)|\(statusKey)"
    }

    private func workspaceSummaryKey(
        workspaceId: UUID,
        statuses: Set<SidebarPullRequestStatus>?
    ) -> String {
        let statusKey = statuses?
            .map(\.rawValue)
            .sorted()
            .joined(separator: ",") ?? "all"
        return "\(workspaceId.uuidString)|\(statusKey)"
    }

    private func normalizedBranch(for workspace: Workspace) -> String? {
        let persisted = WorkspaceMetadataStore.shared.branch(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !persisted.isEmpty {
            return persisted
        }
        return nil
    }

    private func summarySet(for pullRequests: [SidebarPullRequestState]) -> WorktreePullRequestSummarySet {
        WorktreePullRequestSummarySet(
            all: WorktreeAgentsPullRequestSummary.summary(for: pullRequests, statuses: nil),
            open: WorktreeAgentsPullRequestSummary.summary(for: pullRequests, statuses: [.open]),
            merged: WorktreeAgentsPullRequestSummary.summary(for: pullRequests, statuses: [.merged])
        )
    }

    private func makeRenderSnapshot() -> RenderSnapshot {
        PanelRenderInstrumentation.measure(.worktreeAgents) {
            makeRenderSnapshotCore()
        }
    }

    private func makeRenderSnapshotCore() -> RenderSnapshot {
        // Bridge helper workspaces (ask-to right endpoint) inherit the
        // source's worktree/branch. Without this filter they appear as a
        // duplicate top-level row next to the source on the same branch,
        // with the nested BridgeCable already rendering the helper below.
        let scopedTabs = projectScopedTabs()
        let contextMenuContext = ActiveAgentWorkspaceContextMenuBuildContext.live(tabs: scopedTabs)
        let tabs = scopedTabs.filter {
            !WorkspaceMetadataStore.shared.isHiddenFromWorkspaceTree(workspaceId: $0.id)
        }
        let workspaceBranchById = Dictionary(
            uniqueKeysWithValues: tabs.compactMap { workspace in
                normalizedBranch(for: workspace).map { (workspace.id, $0) }
            }
        )
        let workspaceStatusById = Dictionary(
            uniqueKeysWithValues: tabs.compactMap { workspace in
                workspace.termLoopCachedWorktreeStatus(maximumAge: 60)
                    .map { (workspace.id, $0) }
            }
        )
        func groupPath(for workspace: Workspace) -> String? {
            if let statusPath = WorktreeResolver.normalizePath(workspaceStatusById[workspace.id]?.path) {
                return statusPath
            }
            if let storedPath = WorktreeResolver.normalizePath(
                WorkspaceMetadataStore.shared.worktreePath(forWorkspaceId: workspace.id)
            ) {
                return storedPath
            }
            return WorktreeResolver.normalizePath(workspace.termLoopPresentationCwd())
        }
        func groupKey(for workspace: Workspace, branch: String) -> String {
            if let path = groupPath(for: workspace) {
                return "path:\(path)"
            }
            let projectKey = workspace.projectId?.uuidString ?? "unknown-project"
            return "branch:\(projectKey):\(branch)"
        }
        func pathKey(_ rawPath: String?, relativeTo projectRoot: URL?) -> String? {
            TaskPathNormalization
                .resolveDisplayAndKey(rawPath, relativeTo: projectRoot)?
                .keyPath
        }
        func groupProjectId(workspaces: [Workspace], worktreePath: String?) -> UUID? {
            workspaces.compactMap(\.projectId).first
                ?? worktreePath.flatMap { projectStore.project(containingPath: $0)?.id }
        }

        var buckets: [String: [Workspace]] = [:]
        var order: [String] = []
        for workspace in tabs {
            guard let branch = workspaceBranchById[workspace.id] else { continue }
            let key = groupKey(for: workspace, branch: branch)
            if buckets[key] == nil {
                buckets[key] = []
                order.append(key)
            }
            buckets[key, default: []].append(workspace)
        }
        var groups = order.map { key in
            let workspaces = buckets[key] ?? []
            let expectedBranches = Array(Set(workspaces.compactMap { workspaceBranchById[$0.id] })).sorted()
            let displayBranch: String
            if let first = expectedBranches.first {
                displayBranch = expectedBranches.count == 1
                    ? first
                    : "\(first) +\(expectedBranches.count - 1)"
            } else {
                displayBranch = "worktree"
            }
            let worktreePath = workspaces.lazy.compactMap { groupPath(for: $0) }.first
            let statuses = workspaces.compactMap { workspaceStatusById[$0.id] }
            let representativeStatus = statuses.first(where: { $0.needsUserAttention }) ?? statuses.first
            #if DEBUG
            dlog(
                "worktree.panel.group id=\(key) branch=\(displayBranch) workspaces=\(workspaces.map { $0.id.uuidString.prefix(8) }.joined(separator: ",")) worktreePath=\(worktreePath ?? "nil") status=\(representativeStatus?.kind.rawValue ?? "nil")"
            )
            #endif
            return WorktreeAgentsGroup(
                id: key,
                branch: displayBranch,
                workspaces: workspaces,
                worktreePath: worktreePath,
                projectId: groupProjectId(workspaces: workspaces, worktreePath: worktreePath),
                statusKind: representativeStatus?.kind,
                observedRef: representativeStatus?.observedRef,
                expectedBranches: expectedBranches,
                needsAttention: statuses.contains(where: { $0.needsUserAttention })
            )
        }
        if let activeProject = projectStore.activeProject {
            let projectRoot = URL(fileURLWithPath: activeProject.folderPath, isDirectory: true)
            let projection = worktreeProjectionStore.snapshot(
                project: activeProject,
                workspaces: scopedTabs,
                maximumAge: 60
            )
            var seenPathKeys = Set(groups.compactMap {
                pathKey($0.worktreePath, relativeTo: projectRoot)
            })
            for entry in projection.entries where entry.isPhysical && !entry.isMain {
                guard !entry.hasTaskBinding,
                      seenPathKeys.insert(entry.pathKey).inserted else {
                    continue
                }
                let trimmedBranch = entry.branch?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let displayBranch = trimmedBranch.isEmpty
                    ? URL(fileURLWithPath: entry.path).lastPathComponent
                    : trimmedBranch
                let expectedBranches = trimmedBranch.isEmpty ? [] : [trimmedBranch]
                let statusKind: WorktreeStatus.Kind? = {
                    if entry.isLocked { return .locked }
                    if entry.isPrunable { return .prunable }
                    return nil
                }()
                groups.append(WorktreeAgentsGroup(
                    id: "path:\(WorktreeResolver.normalizePath(entry.path) ?? entry.path)",
                    branch: displayBranch,
                    workspaces: [],
                    worktreePath: entry.path,
                    projectId: activeProject.id,
                    statusKind: statusKind,
                    expectedBranches: expectedBranches,
                    needsAttention: statusKind != nil
                ))
            }
        }
        let allWorkspaces = groups.flatMap(\.workspaces)
        let directPullRequestsByBranch: [String: [SidebarPullRequestState]] = Dictionary(
            uniqueKeysWithValues: groups.compactMap { group -> (String, [SidebarPullRequestState])? in
                let pullRequests = worktreePullRequestStore.cachedPullRequests(
                    directory: group.worktreePath,
                    branch: group.branch
                )
                guard !pullRequests.isEmpty else { return nil }
                return (group.id, pullRequests)
            }
        )
        let pullRequestsByWorkspaceId = Dictionary(
            uniqueKeysWithValues: allWorkspaces.map { workspace in
                let orderedPanelIds = workspace.sidebarOrderedPanelIds()
                return (workspace.id, workspace.sidebarPullRequestsInDisplayOrder(orderedPanelIds: orderedPanelIds))
            }
        )

        var groupSummaryByKey: [String: WorktreeAgentsPullRequestSummary.Summary] = [:]
        var workspaceSummaryByKey: [String: WorktreeAgentsPullRequestSummary.Summary] = [:]

        for workspace in allWorkspaces {
            let pullRequests = pullRequestsByWorkspaceId[workspace.id] ?? []
            let summarySet = summarySet(for: pullRequests)
            if let summary = summarySet.all {
                workspaceSummaryByKey[workspaceSummaryKey(workspaceId: workspace.id, statuses: nil)] = summary
            }
            if let summary = summarySet.open {
                workspaceSummaryByKey[workspaceSummaryKey(workspaceId: workspace.id, statuses: [.open])] = summary
            }
            if let summary = summarySet.merged {
                workspaceSummaryByKey[workspaceSummaryKey(workspaceId: workspace.id, statuses: [.merged])] = summary
            }
        }

        var openPullRequests: [WorktreeAgentsGroup] = []
        var mergedPullRequests: [WorktreeAgentsGroup] = []
        var worktrees: [WorktreeAgentsGroup] = []
        let store = TerminalAgentActivityStore.shared
        let branchesNeedingInitialExpansion = groups.compactMap { group in
            store.aggregate(for: group.workspaces).hasVisibleActivity ? group.id : nil
        }

        var allPullRequestsByBranch: [String: [SidebarPullRequestState]] = [:]
        for group in groups {
            var groupPullRequests = group.workspaces.flatMap { pullRequestsByWorkspaceId[$0.id] ?? [] }
            if let directPullRequests = directPullRequestsByBranch[group.id] {
                groupPullRequests.append(contentsOf: directPullRequests)
            }
            let summarySet = summarySet(for: groupPullRequests)
            // `summarySet.all.pullRequests` is already deduped lead-first;
            // reuse it for the badge popover instead of re-running
            // `orderedUniquePullRequests` on the same input.
            if let allSummary = summarySet.all {
                allPullRequestsByBranch[group.id] = allSummary.pullRequests
            }
            if let openSummary = summarySet.open {
                groupSummaryByKey[groupSummaryKey(groupId: group.id, statuses: [.open])] = openSummary
                openPullRequests.append(group)
            } else if let mergedSummary = summarySet.merged {
                groupSummaryByKey[groupSummaryKey(groupId: group.id, statuses: [.merged])] = mergedSummary
                mergedPullRequests.append(group)
            } else {
                if let anySummary = summarySet.all {
                    groupSummaryByKey[groupSummaryKey(groupId: group.id, statuses: nil)] = anySummary
                }
                worktrees.append(group)
            }
        }
        var rowSnapshotsByWorkspaceId: [UUID: WorktreeRowSnapshot] = [:]
        for workspace in allWorkspaces {
            let core = AgentRowSnapshotBuilder.build(
                workspace: workspace,
                branchLabel: workspaceBranchById[workspace.id],
                policy: .livePreferred
            )
            rowSnapshotsByWorkspaceId[workspace.id] = WorktreeRowSnapshot(
                core: core,
                contextMenuSnapshot: ActiveAgentWorkspaceContextMenuSnapshot.build(
                    workspace: workspace,
                    tabs: scopedTabs,
                    context: contextMenuContext
                )
            )
        }

        func rowPriority(_ workspace: Workspace) -> Int {
            guard let row = rowSnapshotsByWorkspaceId[workspace.id] else { return 6 }
            // Selection must not affect ordering. Clicking a row should switch
            // the terminal without making the sidebar jump underneath the pointer.
            return displayPriority(for: row.core.displayState)
        }

        func orderedWorkspaces(_ workspaces: [Workspace]) -> [Workspace] {
            workspaces.sorted { lhs, rhs in
                let lhsPriority = rowPriority(lhs)
                let rhsPriority = rowPriority(rhs)
                if lhsPriority != rhsPriority { return lhsPriority < rhsPriority }
                return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
            }
        }

        let groupPriorityByBranch = Dictionary(
            uniqueKeysWithValues: groups.map { group in
                (group.id, group.workspaces.lazy.map(rowPriority).min() ?? 6)
            }
        )

        func orderedGroups(_ groups: [WorktreeAgentsGroup]) -> [WorktreeAgentsGroup] {
            groups.sorted { lhs, rhs in
                let lhsPriority = groupPriorityByBranch[lhs.id] ?? 6
                let rhsPriority = groupPriorityByBranch[rhs.id] ?? 6
                if lhsPriority != rhsPriority { return lhsPriority < rhsPriority }
                if lhs.branch != rhs.branch {
                    return lhs.branch.localizedStandardCompare(rhs.branch) == .orderedAscending
                }
                return (lhs.worktreePath ?? lhs.id).localizedStandardCompare(rhs.worktreePath ?? rhs.id) == .orderedAscending
            }
        }

        let orderedSections = WorktreeAgentsSectionPartition.Sections(
            openPullRequests: orderedGroups(openPullRequests),
            mergedPullRequests: orderedGroups(mergedPullRequests),
            worktrees: orderedGroups(worktrees)
        )
        let orderedWorkspacesByBranch = Dictionary(
            uniqueKeysWithValues: groups.map { group in
                (group.id, orderedWorkspaces(group.workspaces))
            }
        )
        let branchAttributedStringByBranch = Dictionary(
            uniqueKeysWithValues: groups.map { group in
                (group.id, Self.branchAttributedString(group.branch))
            }
        )

        #if DEBUG
        dlog(
            "worktree.panel.snapshot groups=\(groups.count) open=\(openPullRequests.count) merged=\(mergedPullRequests.count) worktrees=\(worktrees.count) rows=\(rowSnapshotsByWorkspaceId.count)"
        )
        #endif

        var runTargetsByBranch: [String: [RunTargetStore.RunTarget]] = [:]
        var remoteItemBadgeSnapshotsByBranch: [String: [WorktreeGroupRemoteItemBadgeSnapshot]] = [:]
        for group in groups {
            var seenPaths = Set<String>()
            var runTargetsById: [String: RunTargetStore.RunTarget] = [:]
            var remoteItemsById: [String: WorktreeRemoteItemBindingStore.Binding] = [:]
            var paths: [String] = []
            if let path = group.worktreePath {
                paths.append(path)
            }
            paths.append(contentsOf: group.workspaces.compactMap { workspace in
                WorkspaceMetadataStore.shared.reportedStatePath(
                    forWorkspaceId: workspace.id,
                    fallbackPath: workspace.termLoopPresentationCwd()
                )
            })
            for path in paths {
                guard seenPaths.insert(path).inserted else { continue }
                for target in RunTargetStore.shared.targets(forPath: path) {
                    if let existing = runTargetsById[target.id],
                       existing.reportedAt >= target.reportedAt {
                        continue
                    }
                    runTargetsById[target.id] = target
                }
                if let binding = WorktreeRemoteItemBindingStore.shared.binding(forPath: path) {
                    let key = binding.reference.storageKey
                    if let existing = remoteItemsById[key],
                       existing.updatedAt >= binding.updatedAt {
                        continue
                    }
                    remoteItemsById[key] = binding
                }
            }
            if !runTargetsById.isEmpty {
                runTargetsByBranch[group.id] = Array(runTargetsById.values)
                    .sorted { $0.id < $1.id }
            }
            if !remoteItemsById.isEmpty {
                remoteItemBadgeSnapshotsByBranch[group.id] = Array(remoteItemsById.values)
                    .sorted { $0.reference.storageKey < $1.reference.storageKey }
                    .map { binding in
                        WorktreeGroupRemoteItemBadgeSnapshot(
                            binding: binding,
                            snapshot: RemoteWorkItemSnapshotStore.shared.snapshot(for: binding.reference)
                        )
                    }
            }
        }

        return RenderSnapshot(
            orderedSections: orderedSections,
            groupSummaryByKey: groupSummaryByKey,
            workspaceSummaryByKey: workspaceSummaryByKey,
            workspaceBranchById: workspaceBranchById,
            rowSnapshotsByWorkspaceId: rowSnapshotsByWorkspaceId,
            orderedWorkspacesByBranch: orderedWorkspacesByBranch,
            branchAttributedStringByBranch: branchAttributedStringByBranch,
            allWorkspaceIds: allWorkspaces.map(\.id),
            pullRequestLookupInputs: groups.compactMap { group in
                guard let directory = group.worktreePath,
                      group.expectedBranches.count == 1 else { return nil }
                return WorktreeBranchPullRequestStore.LookupInput(
                    directory: directory,
                    branch: group.branch
                )
            },
            branchesNeedingInitialExpansion: branchesNeedingInitialExpansion,
            allPullRequestsByBranch: allPullRequestsByBranch,
            runTargetsByBranch: runTargetsByBranch,
            remoteItemBadgeSnapshotsByBranch: remoteItemBadgeSnapshotsByBranch
        )
    }

    private func projectScopedTabs() -> [Workspace] {
        TermLoopSidebar.projectScopedTabs(allTabs: tabManager.tabs)
    }

    // MARK: - Header

    private func header(
        title: String,
        iconName: String,
        groupCount: Int,
        workspaceCount: Int,
        isCollapsed: Binding<Bool>,
        storageKey: String,
        mediumHeight: CGFloat,
        addWorktreeAction: (() -> Void)? = nil,
        localSetupGroups: [WorktreeAgentsGroup]? = nil
    ) -> some View {
        let hideTooltip = String(
            localized: "worktreeAgents.panel.hide.help",
            defaultValue: "Hide to footer row",
            table: "TermLoop"
        )
        return HStack(spacing: 6) {
            Button {
                isCollapsed.wrappedValue.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed.wrappedValue ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Image(systemName: iconName)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 12, height: 12)
                    Text(TermLoopSidebarTheme.adaptiveSectionTitle(title))
                        .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 11))
                        .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer()
            if let addWorktreeAction {
                Button(action: addWorktreeAction) {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "worktreeAgents.panel.addWorktree.help",
                    defaultValue: "New worktree in Quick Action",
                    table: "TermLoop"
                ))
            }
            if let localSetupGroups {
                worktreeAgentsSectionMenu(groups: localSetupGroups)
            }
            Text(verbatim: sectionCountLabel(
                groupCount: groupCount,
                workspaceCount: workspaceCount,
                short: true
            ))
                .font(TermLoopSidebarTheme.tinyMono)
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .monospacedDigit()
            AgentSidebarPanelSizeCycleButton(
                storageKey: storageKey,
                mediumHeight: mediumHeight
            )
            Button {
                isHidden = true
            } label: {
                Image(systemName: "eye.slash")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 14, height: 14)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(hideTooltip)
        }
        .help(String(
            localized: "worktreeAgents.panel.toggleCollapse.help",
            defaultValue: "Click to expand/collapse",
            table: "TermLoop"
        ))
    }

    private func worktreeAgentsSectionMenu(groups: [WorktreeAgentsGroup]) -> some View {
        let projectId = projectStore.activeProjectId ?? groups.compactMap(\.projectId).first
        let runTargets = groups.compactMap { group -> LocalSetupMenuRunTarget? in
            guard let worktreePath = group.worktreePath,
                  (group.projectId ?? projectId) != nil else { return nil }
            return LocalSetupMenuRunTarget(
                projectId: group.projectId ?? projectId,
                worktreePath: worktreePath,
                label: worktreeMenuLabel(for: group)
            )
        }
        return Menu {
            LocalSetupMenuItems(projectId: projectId, runTargets: runTargets)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(TermLoopSidebarTheme.dim)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(String(
            localized: "worktreeAgents.panel.moreActions.tooltip",
            defaultValue: "More worktree actions",
            table: "TermLoop"
        ))
        .accessibilityLabel(String(
            localized: "worktreeAgents.panel.moreActions.accessibilityLabel",
            defaultValue: "More worktree actions",
            table: "TermLoop"
        ))
    }

    private func worktreeMenuLabel(for group: WorktreeAgentsGroup) -> String {
        if let worktreePath = group.worktreePath {
            let leaf = URL(fileURLWithPath: worktreePath).lastPathComponent
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !leaf.isEmpty, leaf != group.branch {
                return "\(group.branch) · \(leaf)"
            }
        }
        return group.branch
    }

    private func sectionCountLabel(groupCount: Int, workspaceCount: Int, short: Bool = false) -> String {
        if short {
            // Light mode: keep just the agent count — the group/agent split
            // duplicates info already implied by the expanded sub-tree below.
            return "\(workspaceCount)"
        }
        let groupUnit = groupCount == 1 ? "group" : "groups"
        let agentUnit = workspaceCount == 1 ? "agent" : "agents"
        return "\(groupCount) \(groupUnit) · \(workspaceCount) \(agentUnit)"
    }

    private func sectionView(
        storageKey: String,
        title: String,
        emptyMessage: String,
        iconName: String,
        orderedGroups: [WorktreeAgentsGroup],
        sectionKind: WorktreeAgentsSectionKind,
        isCollapsed: Binding<Bool>,
        showsAllGroups: Binding<Bool>,
        pullRequestStatuses: Set<SidebarPullRequestStatus>?,
        renderSnapshot: RenderSnapshot,
        collapsedBranchSet: Set<String>,
        addWorktreeAction: (() -> Void)? = nil
    ) -> some View {
        let visibleLimit = sectionKind.initialVisibleLimit
        let isLimited = orderedGroups.count > visibleLimit && !showsAllGroups.wrappedValue
        let visibleGroups = isLimited ? Array(orderedGroups.prefix(visibleLimit)) : orderedGroups
        let hiddenCount = orderedGroups.count - visibleGroups.count
        return VStack(spacing: 0) {
            TermLoopSidebarRule()
            header(
                title: title,
                iconName: iconName,
                groupCount: orderedGroups.count,
                workspaceCount: orderedGroups.reduce(0) { $0 + $1.workspaces.count },
                isCollapsed: isCollapsed,
                storageKey: storageKey,
                mediumHeight: 180,
                addWorktreeAction: addWorktreeAction,
                localSetupGroups: sectionKind == .worktrees ? orderedGroups : nil
            )
            .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
            .padding(.top, 6)
            .padding(.bottom, isCollapsed.wrappedValue ? 6 : 2)

            if !isCollapsed.wrappedValue {
                if orderedGroups.isEmpty {
                    Text(emptyMessage)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.top, 2)
                        .padding(.bottom, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ResizableSidebarPanelContainer(
                        storageKey: storageKey,
                        mediumHeight: 180,
                        minHeight: 72
                    ) {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(visibleGroups) { group in
                                worktreeGroupView(
                                    group,
                                    sectionKind: sectionKind,
                                    pullRequestStatuses: pullRequestStatuses,
                                    renderSnapshot: renderSnapshot,
                                    collapsedBranchSet: collapsedBranchSet
                                )
                            }
                            if orderedGroups.count > visibleLimit {
                                showMoreGroupsButton(
                                    hiddenCount: hiddenCount,
                                    showsAllGroups: showsAllGroups
                                )
                            }
                        }
                        .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                        .padding(.top, 2)
                        .padding(.bottom, 6)
                    }
                }
            }
        }
    }

    // MARK: - Group

    private func toggleExpanded(branch: String) {
        var set = Set(collapsedBranchesRaw.split(separator: "\n").map(String.init))
        if set.contains(branch) { set.remove(branch) } else { set.insert(branch) }
        collapsedBranchesRaw = set.sorted().joined(separator: "\n")
    }

    private func autoExpandActiveBranches(_ branches: [String]) {
        let candidates = Set(
            branches
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        )
        guard !candidates.isEmpty else { return }
        let collapsed = branchSet(from: collapsedBranchesRaw)
        let next = collapsed.subtracting(candidates)
        guard next != collapsed else { return }
        collapsedBranchesRaw = next.sorted().joined(separator: "\n")
    }

    private func refreshWorktreePullRequests(
        _ inputs: [WorktreeBranchPullRequestStore.LookupInput],
        reason: String
    ) {
        guard !isHidden else { return }
        for input in inputs {
            worktreePullRequestStore.ensureLookup(
                directory: input.directory,
                branch: input.branch,
                reason: reason
            )
        }
    }

    private func refreshWorktreeProjection(for workspaces: [Workspace], reason: String) {
        guard !isHidden else { return }
        var projectIds = Set(workspaces.compactMap { workspace -> UUID? in
            guard let projectId = workspace.projectId,
                  ProjectStore.shared.project(id: projectId) != nil else { return nil }
            return projectId
        })
        if let activeProject = projectStore.activeProject {
            projectIds.insert(activeProject.id)
        }
        guard !projectIds.isEmpty else { return }
        for projectId in projectIds {
            worktreeProjectionStore.refresh(projectId: projectId, reason: "panel.\(reason)")
        }
    }

    private func subscribeToActiveTaskBoardStore() {
        let projectId = projectStore.activeProjectId
        guard projectId != subscribedTaskProjectId else { return }
        subscribedTaskProjectId = projectId
        taskBoardSubscription = nil
        guard let projectId,
              let store = TaskBoardStoreProvider.shared.store(for: projectId) else { return }
        taskBoardSubscription = store.objectWillChange
            .receive(on: RunLoop.main)
            .sink { _ in taskBoardTick &+= 1 }
    }

    private func branchSet(from raw: String) -> Set<String> {
        Set(raw.split(separator: "\n").map(String.init))
    }

    private func sourceWorkspace(for group: WorktreeAgentsGroup) -> Workspace? {
        if let selected = group.workspaces.first(where: { $0.id == tabManager.selectedTabId }) {
            return selected
        }
        return group.workspaces.first
    }

    private func addAgentLabel(for agent: TerminalAgent) -> String {
        let format = String(
            localized: "worktreeAgents.group.addAgent.format",
            defaultValue: "Add %@",
            table: "TermLoop"
        )
        return String.localizedStringWithFormat(format, agent.displayName)
    }

    private func openPullRequests(
        _ pullRequests: [SidebarPullRequestState],
        workspaceIds: [UUID],
        preferredWorkspaceId: UUID?
    ) {
        let uniquePullRequests = WorktreeAgentsPullRequestSummary.orderedUniquePullRequests(from: pullRequests)
        for pullRequest in uniquePullRequests {
            WorktreeURLRouter.open(
                pullRequest.url,
                workspaceIds: workspaceIds,
                preferredWorkspaceId: preferredWorkspaceId
            )
        }
    }

    private func pullRequestBadge(
        summary: WorktreeAgentsPullRequestSummary.Summary?,
        allPullRequests: [SidebarPullRequestState],
        group: WorktreeAgentsGroup
    ) -> some View {
        let workspaceIds = group.workspaces.map(\.id)
        let preferredWorkspaceId = sourceWorkspace(for: group)?.id
        return WorktreeGroupPullRequestBadge(
            summary: summary,
            allPullRequests: allPullRequests,
            openPullRequests: {
                openPullRequests(
                    $0,
                    workspaceIds: workspaceIds,
                    preferredWorkspaceId: preferredWorkspaceId
                )
            },
            openSinglePullRequest: {
                WorktreeURLRouter.open(
                    $0,
                    workspaceIds: workspaceIds,
                    preferredWorkspaceId: preferredWorkspaceId
                )
            }
        )
        .equatable()
    }

    private func worktreeGroupMetadataRow(
        group: WorktreeAgentsGroup,
        pullRequestSummary: WorktreeAgentsPullRequestSummary.Summary?,
        allPullRequests: [SidebarPullRequestState],
        runTargets: [RunTargetStore.RunTarget],
        remoteItemBadges: [WorktreeGroupRemoteItemBadgeSnapshot]
    ) -> some View {
        let preferredWorkspace = sourceWorkspace(for: group)
        let openPullRequests = pullRequestSummary?.pullRequests.filter { $0.status == .open } ?? []
        return HStack(alignment: .center, spacing: 4) {
            worktreeGroupMetadataBadges(
                group: group,
                pullRequestSummary: pullRequestSummary,
                allPullRequests: allPullRequests,
                runTargets: runTargets,
                remoteItemBadges: remoteItemBadges
            )
            WorktreeGroupGitSummaryView(
                group: group,
                preferredWorkspace: preferredWorkspace,
                openPullRequests: openPullRequests
            )
        }
    }

    private func worktreeGroupMetadataBadges(
        group: WorktreeAgentsGroup,
        pullRequestSummary: WorktreeAgentsPullRequestSummary.Summary?,
        allPullRequests: [SidebarPullRequestState],
        runTargets: [RunTargetStore.RunTarget],
        remoteItemBadges: [WorktreeGroupRemoteItemBadgeSnapshot]
    ) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 4) {
                pullRequestBadge(
                    summary: pullRequestSummary,
                    allPullRequests: allPullRequests,
                    group: group
                )
                worktreeGroupSupplementalBadges(
                    group: group,
                    runTargets: runTargets,
                    remoteItemBadges: remoteItemBadges
                )
            }

            VStack(alignment: .trailing, spacing: 2) {
                pullRequestBadge(
                    summary: pullRequestSummary,
                    allPullRequests: allPullRequests,
                    group: group
                )
                worktreeGroupSupplementalBadges(
                    group: group,
                    runTargets: runTargets,
                    remoteItemBadges: remoteItemBadges
                )
            }

            worktreeGroupSupplementalBadges(
                group: group,
                runTargets: runTargets,
                remoteItemBadges: remoteItemBadges
            )

            Color.clear
                .frame(width: 0, height: 0)
        }
    }

    private func worktreeGroupSupplementalBadges(
        group: WorktreeAgentsGroup,
        runTargets: [RunTargetStore.RunTarget],
        remoteItemBadges: [WorktreeGroupRemoteItemBadgeSnapshot]
    ) -> some View {
        HStack(alignment: .center, spacing: 4) {
            if !runTargets.isEmpty {
                WorktreeGroupRunTargetsBadge(
                    targets: runTargets,
                    workspaceIds: group.workspaces.map(\.id),
                    worktreePath: group.worktreePath
                )
            }
            ForEach(remoteItemBadges) { snapshot in
                WorktreeGroupRemoteItemBadge(snapshot: snapshot)
                    .equatable()
            }
        }
    }

    private func addAgent(to group: WorktreeAgentsGroup, agent: TerminalAgent) {
        guard let source = sourceWorkspace(for: group) else {
            guard let projectId = group.projectId,
                  let branch = group.expectedBranches.first,
                  !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return
            }
            QuickActionController.shared.present(
                prefill: QuickActionPresentationRequest(
                    initialSurface: .worktree,
                    worktreeIntent: .createWorkspace,
                    advancedTerminalAgentId: agent.id,
                    reasonTag: "quickAction.worktreePanelAddAgent",
                    projectId: projectId,
                    suggestedBranchName: branch
                )
            )
            return
        }
        // "+" on a worktree row creates a NEW fresh sibling workspace in the
        // same worktree — never a fork/resume. `preferredForkLaunchSource`
        // would route to claude --resume when an existing Claude session
        // exists; `Fork Conversation` in the row context menu owns that flow.
        // `targetWorkspaceId` still carries the worktree's project/branch
        // context for the new spawn, but `.quickAction` keeps it off the
        // source-workspace-launch fast path.
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                targetWorkspaceId: source.id,
                promptText: nil,
                advancedTerminalAgentId: agent.id,
                launchSource: .quickAction,
                reasonTag: "quickAction.freePrompt"
            )
        )
    }

    private func workspaceMergedPublisher(
        for workspaces: [Workspace],
        keyPath: KeyPath<Workspace, AnyPublisher<Void, Never>>,
        throttle: RunLoop.SchedulerTimeType.Stride
    ) -> AnyPublisher<Void, Never> {
        let publishers = workspaces.map { $0[keyPath: keyPath] }
        guard !publishers.isEmpty else {
            return Empty<Void, Never>().eraseToAnyPublisher()
        }
        return Publishers.MergeMany(publishers)
            .throttle(for: throttle, scheduler: RunLoop.main, latest: true)
            .eraseToAnyPublisher()
    }

    private func pullRequestRefreshPublisher(for workspaces: [Workspace]) -> AnyPublisher<Void, Never> {
        workspaceMergedPublisher(
            for: workspaces,
            keyPath: \.sidebarPullRequestObservationPublisher,
            throttle: .milliseconds(250)
        )
    }

    private func displayPriority(for state: TerminalAgentDisplayState) -> Int {
        switch state {
        case .needsInput: return 0
        case .running:    return 1
        case .error:      return 2
        case .ready:      return 3
        case .idle:       return 4
        case .completed:  return 5
        }
    }

    private func showMoreGroupsButton(
        hiddenCount: Int,
        showsAllGroups: Binding<Bool>
    ) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                showsAllGroups.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: showsAllGroups.wrappedValue ? "chevron.up" : "ellipsis")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(width: 12)
                Text(verbatim: showsAllGroups.wrappedValue ? "show fewer" : "show \(hiddenCount) more")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(showsAllGroups.wrappedValue ? "Collapse this section" : "Reveal hidden rows")
    }

    /// Splits a branch name on its first `/` and renders any conventional
    /// flow prefix (`feature/`, `bugfix/`, `hotfix/`, `chore/`, `refactor/`,
    /// `release/`) at dimmer weight so the meaningful tail dominates. Names
    /// without a recognized prefix render as a single primary string.
    private static let dimmedBranchPrefixes: Set<String> = [
        "feature", "feat", "bugfix", "fix", "hotfix",
        "chore", "refactor", "release", "task", "story"
    ]
    private static func branchAttributedString(_ branch: String) -> AttributedString {
        guard let slashIndex = branch.firstIndex(of: "/") else {
            var attr = AttributedString(branch)
            attr.foregroundColor = Color.primary
            return attr
        }
        let prefix = String(branch[..<slashIndex])
        guard Self.dimmedBranchPrefixes.contains(prefix.lowercased()) else {
            var attr = AttributedString(branch)
            attr.foregroundColor = Color.primary
            return attr
        }
        let head = String(branch[..<branch.index(after: slashIndex)])  // includes "/"
        let tail = String(branch[branch.index(after: slashIndex)...])
        var headAttr = AttributedString(head)
        headAttr.foregroundColor = TermLoopSidebarTheme.dimmer
        var tailAttr = AttributedString(tail)
        tailAttr.foregroundColor = Color.primary
        return headAttr + tailAttr
    }

    private func worktreeStatusLabel(for group: WorktreeAgentsGroup) -> String? {
        guard group.needsAttention, let kind = group.statusKind else { return nil }
        switch kind {
        case .branchDrift:
            return "drift"
        case .locked:
            return "locked"
        case .prunable:
            return "prunable"
        case .missingRegistration:
            return "unregistered"
        case .missingPath:
            return "missing"
        case .unknown:
            return "unknown"
        case .unattached, .healthy:
            return nil
        }
    }

    private func worktreeStatusTooltip(for group: WorktreeAgentsGroup) -> String {
        let path = group.worktreePath.map { ($0 as NSString).abbreviatingWithTildeInPath }
        let observed = group.observedRef?.displayName
        var lines: [String] = []
        switch group.statusKind {
        case .branchDrift:
            let expected = group.expectedBranches.joined(separator: ", ")
            if let observed, !expected.isEmpty {
                lines.append("Branch drift: TermLoop expected \(expected), but this worktree is currently on \(observed).")
            } else if !expected.isEmpty {
                lines.append("Branch drift: TermLoop expected \(expected), but Git HEAD moved away.")
            } else if let observed {
                lines.append("Branch drift: this worktree is currently on \(observed), but TermLoop expected a different branch.")
            } else {
                lines.append("Branch drift: Git HEAD no longer matches TermLoop's expected branch.")
            }
            lines.append("This usually happens after running git switch, checkout, rebase, or bisect outside TermLoop.")
            lines.append("Agents are blocked until you switch Git back or choose “Use Current Git Branch as Expected…” from the menu.")
        case .locked:
            lines.append("Git reports this worktree as locked.")
        case .prunable:
            lines.append("Git reports this worktree registration as prunable.")
        case .missingRegistration:
            lines.append("The folder exists, but Git does not list it as a registered worktree.")
        case .missingPath:
            lines.append("The recorded worktree path is missing on disk.")
        case .unknown:
            lines.append("TermLoop could not refresh Git worktree state.")
        case .unattached, .healthy, nil:
            lines.append("Worktree is healthy.")
        }
        if group.statusKind != .branchDrift, !group.expectedBranches.isEmpty {
            lines.append("Expected: \(group.expectedBranches.joined(separator: ", "))")
        }
        if group.statusKind != .branchDrift, let observed {
            lines.append("Observed: \(observed)")
        }
        if let path {
            lines.append(path)
        }
        return lines.joined(separator: "\n")
    }

    private func openTargetLabel(for target: WorktreeOpenTarget?) -> String {
        guard let target else {
            return String(
                localized: "worktreeAgents.group.openTarget.configureFirst",
                defaultValue: "Open Target…",
                table: "TermLoop"
            )
        }
        let rawRelative = target.relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let relative = rawRelative.isEmpty ? "." : rawRelative
        if let appName = target.applicationDisplayName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !appName.isEmpty {
            return String(
                localized: "worktreeAgents.group.openTarget.withApp",
                defaultValue: "Open \(relative) in \(appName)",
                table: "TermLoop"
            )
        }
        return String(
            localized: "worktreeAgents.group.openTarget.default",
            defaultValue: "Open \(relative)",
            table: "TermLoop"
        )
    }

    @ViewBuilder
    private func worktreeGroupView(
        _ group: WorktreeAgentsGroup,
        sectionKind: WorktreeAgentsSectionKind,
        pullRequestStatuses: Set<SidebarPullRequestStatus>?,
        renderSnapshot: RenderSnapshot,
        collapsedBranchSet: Set<String>
    ) -> some View {
        let expanded = !collapsedBranchSet.contains(group.id)
        let path = group.worktreePath.map {
            ($0 as NSString).abbreviatingWithTildeInPath
        }
        let pathLeaf = group.worktreePath.map {
            URL(fileURLWithPath: $0).lastPathComponent
        }?.trimmingCharacters(in: .whitespacesAndNewlines)
        let availableAgents = TerminalAgentRegistry.shared.agents
        let canPerformBranchActions = group.expectedBranches.count == 1
        let singleExpectedBranch = canPerformBranchActions ? group.expectedBranches.first : nil
        let canDeletePhysicalWorktree: Bool = {
            guard group.worktreePath != nil else { return false }
            switch group.statusKind {
            case .missingRegistration, .missingPath, .unknown, .prunable:
                return false
            default:
                return true
            }
        }()
        let canDeleteGroup = canDeletePhysicalWorktree || canPerformBranchActions
        let showsAddAction = hoveredBranch == group.id
            && !availableAgents.isEmpty
            && (sourceWorkspace(for: group) != nil || group.projectId != nil)
            && group.expectedBranches.count == 1
        let showsCollapseAction = !group.workspaces.isEmpty
        let showsDeleteAction = hoveredBranch == group.id && canDeleteGroup
        let isArchivedSection = sectionKind.isArchived
        let orderedWorkspaces = renderSnapshot.orderedWorkspacesByBranch[group.id] ?? group.workspaces
        let runTargets = renderSnapshot.runTargetsByBranch[group.id] ?? []
        let remoteItemBadges = renderSnapshot.remoteItemBadgeSnapshotsByBranch[group.id] ?? []
        let pullRequestSummary = renderSnapshot.groupSummaryByKey[
            groupSummaryKey(groupId: group.id, statuses: pullRequestStatuses)
        ]
        let allBranchPullRequests = renderSnapshot.allPullRequestsByBranch[group.id] ?? []
        VStack(alignment: .leading, spacing: 2) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .center, spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .frame(width: 10)
                    Image(systemName: "shippingbox.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(isArchivedSection ? TermLoopSidebarTheme.dimmer : TermLoopSidebarTheme.dim)
                        .frame(width: 10, height: 10)
                    Text(renderSnapshot.branchAttributedStringByBranch[group.id] ?? Self.branchAttributedString(group.branch))
                        .font(WorktreeAgentsPanelTypography.branchValue)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                        .help(path ?? group.branch)
                    if let pathLeaf, !pathLeaf.isEmpty {
                        Text(verbatim: "· \(pathLeaf)")
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(TermLoopSidebarTheme.dimmer)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .layoutPriority(0)
                            .help(path ?? pathLeaf)
                    }
                    if let statusLabel = worktreeStatusLabel(for: group) {
                        TermLoopSidebarToken(
                            label: statusLabel,
                            iconSystemName: "exclamationmark.triangle.fill",
                            tone: .warning,
                            emphasized: true
                        )
                        .help(worktreeStatusTooltip(for: group))
                    }
                    Spacer()
                    SidebarActionSlot(isVisible: showsCollapseAction, width: 14, height: 14) {
                        Button {
                            _ = WorkspaceHideCoordinator.confirmAndCollapse(
                                workspaces: group.workspaces,
                                tabManager: tabManager,
                                targetName: group.branch
                            )
                        } label: {
                            Image(systemName: "archivebox")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(width: 14, height: 14)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(String(
                            localized: "worktreeAgents.group.collapse.tooltip",
                            defaultValue: "Collapse this worktree and stop its agents",
                            table: "TermLoop"
                        ))
                    }
                    SidebarActionSlot(isVisible: showsAddAction, width: 14, height: 14) {
                        Menu {
                            ForEach(availableAgents, id: \.id) { agent in
                                Button {
                                    addAgent(to: group, agent: agent)
                                } label: {
                                    Label(addAgentLabel(for: agent), systemImage: agent.icon)
                                }
                            }
                        } label: {
                            Text(verbatim: "+")
                                .font(TermLoopSidebarTheme.bodyMonoStrong)
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(width: 14, height: 14)
                                .contentShape(Rectangle())
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .help(String(
                            localized: "worktreeAgents.group.hoverAdd.tooltip",
                            defaultValue: "Add agent on this branch",
                            table: "TermLoop"
                        ))
                    }
                    SidebarActionSlot(isVisible: showsDeleteAction, width: 14, height: 14) {
                        let deleteTooltip = canDeletePhysicalWorktree
                            ? String(
                                localized: "worktreeAgents.group.hoverDelete.worktreeTooltip",
                                defaultValue: "Delete this worktree",
                                table: "TermLoop"
                            )
                            : String(
                                localized: "worktreeAgents.group.hoverDelete.branchTooltip",
                                defaultValue: "Delete this branch",
                                table: "TermLoop"
                            )
                        Button {
                            WorktreeDeletionCoordinator.shared.confirmAndDelete(
                                branch: singleExpectedBranch,
                                worktreePath: canDeletePhysicalWorktree ? group.worktreePath : nil,
                                projectId: sourceWorkspace(for: group)?.projectId ?? group.projectId,
                                fallbackWorkspaceIds: group.workspaces.map(\.id),
                                onDeleted: { worktreeProjectionStore.markChanged(reason: "panel.delete") }
                            )
                        } label: {
                            Image(systemName: "trash")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(width: 14, height: 14)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(deleteTooltip)
                    }
                    Text(verbatim: "\(group.workspaces.count)")
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(isArchivedSection ? TermLoopSidebarTheme.dimmer : TermLoopSidebarTheme.dim)
                        .monospacedDigit()
                }
                worktreeGroupMetadataRow(
                    group: group,
                    pullRequestSummary: pullRequestSummary,
                    allPullRequests: allBranchPullRequests,
                    runTargets: runTargets,
                    remoteItemBadges: remoteItemBadges
                )
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 32)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 1)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isArchivedSection ? TermLoopSidebarTheme.groupHeaderBg.opacity(0.55) : TermLoopSidebarTheme.groupHeaderBg)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(TermLoopSidebarTheme.groupHeaderBorder, lineWidth: 1)
            )
            .opacity(isArchivedSection ? 0.90 : 1.0)
            .contentShape(Rectangle())
            .contextMenu {
                Button {
                    WorktreeRepairCoordinator.shared.refreshStatus(
                        group: group,
                        sourceWorkspace: sourceWorkspace(for: group)
                    ) {
                        worktreeProjectionStore.markChanged(reason: "panel.action")
                    }
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.refreshStatus",
                            defaultValue: "Refresh Git Worktree Status",
                            table: "TermLoop"
                        ),
                        systemImage: "arrow.clockwise"
                    )
                }

                if let worktreePath = group.worktreePath {
                    let projectId = sourceWorkspace(for: group)?.projectId
                        ?? group.projectId
                        ?? group.workspaces.first?.projectId
                    LocalSetupWorktreeMenuItems(projectId: projectId, worktreePath: worktreePath)

                    let openTarget = projectId
                        .flatMap { ProjectStore.shared.project(id: $0)?.worktreeOpenTarget }
                    Menu {
                        Button {
                            WorktreeRepairCoordinator.shared.openFolder(path: worktreePath)
                        } label: {
                            Label(
                                String(
                                    localized: "worktreeAgents.group.openFolder",
                                    defaultValue: "Open Folder",
                                    table: "TermLoop"
                                ),
                                systemImage: "folder"
                            )
                        }

                        Button {
                            WorktreeRepairCoordinator.shared.openConfiguredTarget(
                                projectId: projectId,
                                worktreePath: worktreePath
                            )
                        } label: {
                            Label(
                                openTargetLabel(for: openTarget),
                                systemImage: "arrow.up.right.square"
                            )
                        }

                        Button {
                            WorktreeRepairCoordinator.shared.configureOpenTarget(
                                projectId: projectId,
                                worktreePath: worktreePath
                            )
                        } label: {
                            Label(
                                String(
                                    localized: "worktreeAgents.group.configureOpenTarget",
                                    defaultValue: "Configure Open Target…",
                                    table: "TermLoop"
                                ),
                                systemImage: "slider.horizontal.3"
                            )
                        }

                        if openTarget != nil {
                            Button {
                                WorktreeRepairCoordinator.shared.clearOpenTarget(projectId: projectId)
                            } label: {
                                Label(
                                    String(
                                        localized: "worktreeAgents.group.clearOpenTarget",
                                        defaultValue: "Clear Open Target",
                                        table: "TermLoop"
                                    ),
                                    systemImage: "xmark.circle"
                                )
                            }
                        }

                        Divider()

                        Button {
                            WorktreeRepairCoordinator.shared.reveal(path: worktreePath)
                        } label: {
                            Label(
                                String(
                                    localized: "worktreeAgents.group.revealWorktree",
                                    defaultValue: "Reveal in Finder",
                                    table: "TermLoop"
                                ),
                                systemImage: "magnifyingglass"
                            )
                        }

                        Button {
                            WorktreeRepairCoordinator.shared.copyPath(worktreePath)
                        } label: {
                            Label(
                                String(
                                    localized: "worktreeAgents.group.copyPath",
                                    defaultValue: "Copy Path",
                                    table: "TermLoop"
                                ),
                                systemImage: "doc.on.doc"
                            )
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.openWorktreeMenu",
                                defaultValue: "Open Worktree",
                                table: "TermLoop"
                            ),
                            systemImage: "arrow.up.right.square"
                        )
                    }
                }

                if group.statusKind == .branchDrift,
                   canPerformBranchActions,
                   group.worktreePath != nil {
                    Button {
                        WorktreeRepairCoordinator.shared.switchToExpectedBranch(
                            group: group,
                            sourceWorkspace: sourceWorkspace(for: group)
                        ) {
                            worktreeProjectionStore.markChanged(reason: "panel.action")
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.switchToExpectedBranch",
                                defaultValue: "Switch Git Back to Expected Branch…",
                                table: "TermLoop"
                            ),
                            systemImage: "arrow.triangle.2.circlepath"
                        )
                    }
                }

                if group.statusKind == .branchDrift,
                   group.observedRef?.branchName != nil,
                   group.worktreePath != nil {
                    Button {
                        WorktreeRepairCoordinator.shared.acceptObservedBranch(
                            group: group
                        ) {
                            worktreeProjectionStore.markChanged(reason: "panel.action")
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.acceptObservedBranch",
                                defaultValue: "Use Current Git Branch as Expected…",
                                table: "TermLoop"
                            ),
                            systemImage: "checkmark.circle"
                        )
                    }
                }

                if group.statusKind == .missingRegistration, group.worktreePath != nil {
                    Button {
                        WorktreeRepairCoordinator.shared.repairRegistration(
                            group: group,
                            sourceWorkspace: sourceWorkspace(for: group)
                        ) {
                            worktreeProjectionStore.markChanged(reason: "panel.action")
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.repairRegistration",
                                defaultValue: "Repair Git Registration…",
                                table: "TermLoop"
                            ),
                            systemImage: "wrench.and.screwdriver"
                        )
                    }
                }

                if group.statusKind == .prunable {
                    Button {
                        WorktreeRepairCoordinator.shared.pruneStaleRegistrations(
                            group: group,
                            sourceWorkspace: sourceWorkspace(for: group)
                        ) {
                            worktreeProjectionStore.markChanged(reason: "panel.action")
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.pruneRegistrations",
                                defaultValue: "Prune Stale Registrations…",
                                table: "TermLoop"
                            ),
                            systemImage: "scissors"
                        )
                    }
                }

                Divider()

                if group.needsAttention {
                    Button {
                        WorktreeRepairCoordinator.shared.detachGroupFromWorktree(
                            group: group
                        ) {
                            worktreeProjectionStore.markChanged(reason: "panel.action")
                        }
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.detachFromWorktree",
                                defaultValue: "Detach from Worktree…",
                                table: "TermLoop"
                            ),
                            systemImage: "rectangle.portrait.and.arrow.right"
                        )
                    }
                }

                if !group.workspaces.isEmpty {
                    Button {
                        _ = WorkspaceHideCoordinator.confirmAndCollapse(
                            workspaces: group.workspaces,
                            tabManager: tabManager,
                            targetName: group.branch
                        )
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.collapse",
                                defaultValue: "Collapse Worktree…",
                                table: "TermLoop"
                            ),
                            systemImage: "archivebox"
                        )
                    }
                }

                if canPerformBranchActions, !group.workspaces.isEmpty {
                    Button {
                        moveGroupToCurrentLocalBranch(group)
                    } label: {
                        Label(
                            String(
                                localized: "worktreeAgents.group.moveToCurrentLocalBranch",
                                defaultValue: "Move to current local branch…",
                                table: "TermLoop"
                            ),
                            systemImage: "arrow.turn.up.left"
                        )
                    }
                }

                Divider()
                Button {
                    if let worktreePath = group.worktreePath {
                        RemoteItemBindingPrompt.present(
                            forWorktreePath: worktreePath,
                            workspaceIds: group.workspaces.map(\.id)
                        )
                    } else {
                        RemoteItemBindingPrompt.present(forGroupWorkspaces: group.workspaces)
                    }
                } label: {
                    Label(
                        String(
                            localized: "worktreeAgents.group.setRemoteItem",
                            defaultValue: "Set Remote Item…",
                            table: "TermLoop"
                        ),
                        systemImage: "link"
                    )
                }

                Divider()

                if canDeleteGroup {
                    let deleteLabel = canDeletePhysicalWorktree
                        ? String(
                            localized: "worktreeAgents.group.deleteWorktree",
                            defaultValue: "Delete Worktree…",
                            table: "TermLoop"
                        )
                        : String(
                            localized: "worktreeAgents.group.deleteBranch",
                            defaultValue: "Delete Branch…",
                            table: "TermLoop"
                        )
                    Button {
                        WorktreeDeletionCoordinator.shared.confirmAndDelete(
                            branch: singleExpectedBranch,
                            worktreePath: canDeletePhysicalWorktree ? group.worktreePath : nil,
                            projectId: sourceWorkspace(for: group)?.projectId ?? group.projectId,
                            fallbackWorkspaceIds: group.workspaces.map(\.id),
                            onDeleted: { worktreeProjectionStore.markChanged(reason: "panel.delete") }
                        )
                    } label: {
                        Label(
                            deleteLabel,
                            systemImage: "trash.fill"
                        )
                    }
                }
            }
            .onHover { hovering in
                hoveredBranch = hovering ? group.id : (hoveredBranch == group.id ? nil : hoveredBranch)
            }
            .onTapGesture { toggleExpanded(branch: group.id) }

            if expanded {
                VStack(alignment: .leading, spacing: 1) {
                    if orderedWorkspaces.isEmpty {
                        Text(
                            String(
                                localized: "worktreeAgents.group.noAgents",
                                defaultValue: "No agents attached.",
                                table: "TermLoop"
                            )
                        )
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dimmer)
                        .lineLimit(1)
                        .padding(.vertical, 3)
                    }
                    ForEach(orderedWorkspaces, id: \.id) { ws in
                        VStack(alignment: .leading, spacing: 0) {
                            if let rowSnapshot = renderSnapshot.rowSnapshotsByWorkspaceId[ws.id] {
                                workspaceRow(
                                    workspace: ws,
                                    rowSnapshot: rowSnapshot,
                                    onCollapseGroup: { [groupWorkspaces = group.workspaces] in
                                        let branch = rowSnapshot.core.branchLabel?
                                            .trimmingCharacters(in: .whitespacesAndNewlines)
                                        let targetName = (branch?.isEmpty == false) ? branch : rowSnapshot.core.title
                                        _ = WorkspaceHideCoordinator.confirmAndCollapse(
                                            workspaces: groupWorkspaces,
                                            tabManager: tabManager,
                                            targetName: targetName
                                        )
                                    }
                                )
                            }
                            WorkspaceRowBridgeExtras(
                                workspace: ws,
                                tabManager: tabManager
                            )
                            .padding(.leading, 8)
                        }
                    }
                }
                .padding(.leading, 18)
            }
        }
    }

    private func moveGroupToCurrentLocalBranch(_ group: WorktreeAgentsGroup) {
        do {
            let inspection = try WorktreeCoordinator.shared.inspectDetachToCurrentLocalBranch(
                workspaces: group.workspaces,
                worktreePath: group.worktreePath
            )

            guard inspection.runningWorkspaceIds.isEmpty else {
                presentGroupMoveError(
                    String(
                        localized: "worktreeAgents.group.move.runningError",
                        defaultValue: "Stop running agents in this worktree before moving it back to \(inspection.currentLocalBranch).",
                        table: "TermLoop"
                    )
                )
                return
            }

            guard !inspection.hasUnmergedCommits else {
                presentGroupMoveError(
                    String(
                        localized: "worktreeAgents.group.move.unmergedError",
                        defaultValue: "Branch \(inspection.worktreeBranch) has commits that are not merged into \(inspection.currentLocalBranch). Merge them first.",
                        table: "TermLoop"
                    )
                )
                return
            }

            let policy: WorktreeCoordinator.LocalChangesPolicy
            if inspection.hasLocalChanges {
                guard let selected = selectLocalChangesPolicy(
                    for: inspection,
                    workspaceCount: group.workspaces.count
                ) else { return }
                policy = selected
            } else {
                guard confirmCleanGroupMove(
                    inspection: inspection,
                    workspaceCount: group.workspaces.count
                ) else { return }
                policy = .discardAll
            }

            let result = try WorktreeCoordinator.shared.detachToCurrentLocalBranch(
                workspaces: group.workspaces,
                worktreePath: group.worktreePath,
                localChangesPolicy: policy
            )
            if !result.worktreeRemoved {
                presentGroupMoveInfo(
                    String(
                        localized: "worktreeAgents.group.move.leftOnDisk",
                        defaultValue: "Detached \(result.workspaceCount) workspace(s) to \(result.currentLocalBranch). Local changes were left in the worktree at \(result.worktreePath).",
                        table: "TermLoop"
                    )
                )
            }
        } catch {
            presentGroupMoveError((error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    private func confirmCleanGroupMove(
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

    private func presentGroupMoveError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "worktreeAgents.group.move.errorTitle",
            defaultValue: "Worktree move failed",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }

    private func presentGroupMoveInfo(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = message
        alert.runModal()
    }

    // MARK: - Workspace row

    @ViewBuilder
    private func workspaceRow(
        workspace: Workspace,
        rowSnapshot: WorktreeRowSnapshot,
        onCollapseGroup: @escaping () -> Void
    ) -> some View {
        let workspaceId = rowSnapshot.core.workspaceId
        let isSelected = tabManager.selectedTabId == workspaceId
        // Strip `branchLabel` on grouped rows — the parent group header
        // already shows the branch, repeating it as the row's subtitle is
        // redundant noise and ate a whole line under MERGED PRs.
        let groupedCore = rowSnapshot.core.with(branchLabel: nil, since: rowSnapshot.core.since)
        VStack(alignment: .leading, spacing: 2) {
            AgentRowCoreView(
                core: groupedCore,
                isSelected: isSelected,
                trailingSlot: .collapseButton,
                dismissBehavior: .confirmClose(onConfirm: { [weak tabManager, workspaceId] in
                    guard let tm = tabManager,
                          let ws = tm.tabs.first(where: { $0.id == workspaceId }) else { return }
                    tm.closeWorkspaceFromSidebarPopover(ws)
                }),
                onActivate: { MainAreaActivation.activateWorkspaceTerminal(workspaceId, on: tabManager) },
                onAcknowledgeAttention: {
                    TerminalAgentActivityStore.shared.acknowledgeViewedAttention(forWorkspaceId: workspaceId)
                },
                onTrailingSlotTap: nil,
                onCollapseTap: onCollapseGroup
            )
            .equatable()
            .contextMenu {
                if let snapshot = rowSnapshot.contextMenuSnapshot {
                    ActiveAgentWorkspaceContextMenu(
                        snapshot: snapshot,
                        tabManager: tabManager
                    )
                }
            }
        }
    }

}

struct WorktreeChangesPresentation: Identifiable, Equatable {
    let workspaceId: UUID
    let branch: String?
    let worktreePath: String?
    let preselectedPath: String?
    let baselineHead: String?

    init(
        workspaceId: UUID,
        branch: String?,
        worktreePath: String?,
        preselectedPath: String? = nil,
        baselineHead: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.branch = branch
        self.worktreePath = worktreePath
        self.preselectedPath = preselectedPath
        self.baselineHead = baselineHead
    }

    /// Callers that already hold the `Workspace` value use this. Uses the
    /// presentation cwd helper so opening the changes UI never shells out
    /// during SwiftUI render/update work.
    @MainActor
    init(workspace: Workspace, preselectedPath: String? = nil, baselineHead: String? = nil) {
        self.workspaceId = workspace.id
        self.branch = WorkspaceMetadataStore.shared.branch(for: workspace)
        self.worktreePath = workspace.termLoopPresentationCwd()
        self.preselectedPath = preselectedPath
        self.baselineHead = baselineHead ?? WorkspaceMetadataStore.shared.worktreeBaselineHead(for: workspace)
    }

    var id: UUID { workspaceId }
}

struct WorktreeChangesSheet: View {
    @ObservedObject var workspace: Workspace
    let branch: String?
    let worktreePath: String?
    let preselectedPath: String?
    let onClose: (() -> Void)?
    let baselineHead: String?

    init(
        workspace: Workspace,
        branch: String?,
        worktreePath: String?,
        preselectedPath: String? = nil,
        baselineHead: String? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.workspace = workspace
        self.branch = branch
        self.worktreePath = worktreePath
        self.preselectedPath = preselectedPath
        self.baselineHead = baselineHead
        self.onClose = onClose
    }

    @Environment(\.dismiss) private var dismiss
    @State var selectedSourceID: String = WorktreeChangesSource.local.id
    @State private var selectedPath: String?
    @State private var diffText: String = ""
    @State private var isLoadingDiff = false
    @State private var isLoadingChanges = false
    @State var localChanges: [SidebarGitChangeItem] = []
    @State var baseComparisonTargets: [WorktreeBaseComparisonTarget] = []
    /// Lazy cache — populated on `.baseComparison` selection.
    /// Keyed on the target struct so stale entries (mergeBase moved) drop
    /// naturally when `baseComparisonTargets` is reassigned.
    @State var baseComparisonChangesByTarget: [WorktreeBaseComparisonTarget: [SidebarGitChangeItem]] = [:]
    @State var recentCommits: [WorktreeRecentCommit] = []
    @State var commitChangesBySHA: [String: [SidebarGitChangeItem]] = [:]
    /// File-count pre-fetch populated from `git log --numstat` so every
    /// commit row can show a count without waiting for per-commit selection.
    @State var commitFileCountBySHA: [String: Int] = [:]
    /// Per-commit list of tracked branches whose history contains the SHA.
    /// Empty list is never stored — absence means "not merged anywhere".
    @State var mergedBranchesBySHA: [String: [String]] = [:]
    /// Commit-level diff cache. `.local` and `.baseComparison` reflect
    /// live working-tree state so they are intentionally excluded — only
    /// commit patches are immutable enough to cache safely.
    @State private var commitDiffCache: [String: String] = [:]
    @State private var refreshNonce: UInt64 = 0
    @FocusState private var isFileNavigationFocused: Bool

    private var effectiveDirectory: String {
        worktreePath ?? workspace.termLoopPresentationCwd() ?? workspace.currentDirectory
    }

    private var resolvedBaselineHead: String? {
        let explicit = baselineHead?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !explicit.isEmpty { return explicit }
        let metadata = WorkspaceMetadataStore.shared.worktreeBaselineHead(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return metadata.isEmpty ? nil : metadata
    }

    var availableSources: [WorktreeChangesSource] {
        var sources: [WorktreeChangesSource] = [.local]
        sources.append(contentsOf: baseComparisonTargets.map { .baseComparison($0) })
        sources.append(contentsOf: recentCommits.map { .commit($0) })
        return sources
    }

    var currentSource: WorktreeChangesSource {
        if selectedSourceID == WorktreeChangesSource.local.id {
            return .local
        }
        if let target = baseComparisonTargets.first(where: { $0.id == selectedSourceID }) {
            return .baseComparison(target)
        }
        if let commit = recentCommits.first(where: { WorktreeChangesSource.commit($0).id == selectedSourceID }) {
            return .commit(commit)
        }
        return availableSources.first ?? .local
    }

    private var currentBaseComparisonTarget: WorktreeBaseComparisonTarget? {
        switch currentSource {
        case .baseComparison(let target):
            return target
        case .local, .commit:
            return nil
        }
    }

    private var changes: [SidebarGitChangeItem] {
        switch currentSource {
        case .local:
            return localChanges
        case .baseComparison(let target):
            return baseComparisonChangesByTarget[target] ?? []
        case .commit(let commit):
            return commitChangesBySHA[commit.sha] ?? []
        }
    }

    private var selectedFile: SidebarGitChangeItem? {
        if let selectedPath,
           let selected = changes.first(where: { $0.path == selectedPath }) {
            return selected
        }
        return changes.first
    }

    private var diffLines: [String] {
        diffText.components(separatedBy: "\n")
    }

    private var refreshKey: String {
        "\(workspace.id.uuidString)|\(effectiveDirectory)|\(branch ?? "none")|\(resolvedBaselineHead ?? "none")|\(refreshNonce)"
    }

    private var diffTaskKey: String {
        switch currentSource {
        case .commit:
            return "\(currentSource.id)|\(selectedFile?.path ?? "none")"
        case .local:
            return "\(currentSource.id)|\(selectedFile?.path ?? "none")|\(refreshNonce)"
        case .baseComparison:
            return "\(currentSource.id)|\(selectedFile?.path ?? "none")|\(currentBaseComparisonTarget?.mergeBase ?? "none")|\(refreshNonce)"
        }
    }

    private var changeCountLabel: String {
        let count = changes.count
        return count == 1 ? "1 change" : "\(count) changes"
    }

    private var specialSources: [WorktreeChangesSource] {
        availableSources.filter {
            switch $0 {
            case .local, .baseComparison:
                return true
            case .commit:
                return false
            }
        }
    }

    private var commitSources: [WorktreeChangesSource] {
        availableSources.filter {
            switch $0 {
            case .commit:
                return true
            case .local, .baseComparison:
                return false
            }
        }
    }

    private var currentSourceLabel: String {
        switch currentSource {
        case .local:
            return "Local changes"
        case .baseComparison(let target):
            return baseComparisonLabel(for: target)
        case .commit(let commit):
            return "Commit \(commitIndex(commit) + 1) · \(commit.shortSHA)"
        }
    }

    private var emptyStateTitle: String {
        switch currentSource {
        case .local:
            return "No Git Changes"
        case .baseComparison(let target):
            return "No changes vs \(target.branch)"
        case .commit(let commit):
            return "No changes in \(commit.shortSHA)"
        }
    }

    private var emptyStateDescription: String {
        switch currentSource {
        case .local:
            return "This worktree is clean."
        case .baseComparison(let target):
            return "The current worktree matches \(target.branch) when compared from merge base \(target.shortMergeBase)."
        case .commit(let commit):
            return commit.subject
        }
    }

    private func closeSheet() {
        if let onClose { onClose() } else { dismiss() }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(
                        localized: "worktreeChanges.title",
                        defaultValue: "Worktree changes",
                        table: "TermLoop"
                    ))
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    worktreeMetaLine
                }
                Spacer()
                Text(changeCountLabel)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                Button(String(
                    localized: "worktreeChanges.close",
                    defaultValue: "Done",
                    table: "TermLoop"
                )) {
                    closeSheet()
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.cancelAction)
            }

            Divider()
            sourceToolbar

            HSplitView {
                filePane
                    .frame(minWidth: 260, idealWidth: 340)
                diffPane
                    .frame(minWidth: 480)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .frame(minWidth: onClose == nil ? 940 : nil, minHeight: onClose == nil ? 620 : nil)
        // Without an explicit window background the overlay let the host
        // chrome (terminal portal / dark default) bleed through, so the
        // sheet rendered dark even in light mode. `.windowBackgroundColor`
        // adapts to system appearance — matches `AgentsCatalogMainAreaView`.
        .background(Color(nsColor: .windowBackgroundColor))
        .focusable()
        .focused($isFileNavigationFocused)
        .onAppear {
            isFileNavigationFocused = true
        }
        .onKeyPress(.upArrow) {
            moveFileSelection(offset: -1) ? .handled : .ignored
        }
        .onKeyPress(.downArrow) {
            moveFileSelection(offset: 1) ? .handled : .ignored
        }
        .onExitCommand {
            closeSheet()
        }
        .task(id: refreshKey) {
            await refreshComparisonState()
        }
        .task(id: currentSource.id) {
            await loadSourceChanges()
        }
        .task(id: diffTaskKey) {
            await loadDiff()
        }
        .onChange(of: selectedSourceID) { _, _ in
            syncSelectedPath()
            isFileNavigationFocused = true
        }
        .onReceive(
            Publishers.MergeMany([
                workspace.sidebarGitChangesObservationPublisher,
                workspace.sidebarPullRequestObservationPublisher,
            ])
            .receive(on: RunLoop.main)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
        ) { _ in
            refreshNonce &+= 1
        }
    }

    @ViewBuilder
    private var worktreeMetaLine: some View {
        HStack(spacing: 8) {
            if let branch, !branch.isEmpty {
                Label(branch, systemImage: "arrow.triangle.branch")
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .lineLimit(1)
            }
            if let worktreePath, !worktreePath.isEmpty {
                Text((worktreePath as NSString).abbreviatingWithTildeInPath)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dimmer)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }

    private var sourceContextLine: String {
        switch currentSource {
        case .local:
            return "Showing uncommitted worktree state"
        case .baseComparison(let target):
            return "Comparing current worktree to \(target.branch) from merge base \(target.shortMergeBase)"
        case .commit(let commit):
            return "\(commit.shortSHA) · \(commit.subject)"
        }
    }

    @ViewBuilder
    private var sourceToolbar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button { moveToSource(offset: -1) } label: {
                    Label(
                        String(localized: "worktreeChanges.previous", defaultValue: "Previous", table: "TermLoop"),
                        systemImage: "chevron.left"
                    )
                }
                .buttonStyle(.borderless)
                .disabled(!canMoveSource(offset: -1))

                Button { moveToSource(offset: 1) } label: {
                    Label(
                        String(localized: "worktreeChanges.next", defaultValue: "Next", table: "TermLoop"),
                        systemImage: "chevron.right"
                    )
                }
                .buttonStyle(.borderless)
                .disabled(!canMoveSource(offset: 1))

                Divider()
                    .frame(height: 14)

                VStack(alignment: .leading, spacing: 2) {
                    Text(currentSourceLabel)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text(sourceContextLine)
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .textSelection(.enabled)
                }

                Spacer()

                if case .baseComparison(let target) = currentSource {
                    TermLoopSidebarToken(
                        label: "vs \(target.branch)",
                        tone: .accent,
                        emphasized: true
                    )
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(specialSources.enumerated()), id: \.element.id) { index, source in
                        Button {
                            selectedSourceID = source.id
                        } label: {
                            sourceChip(source: source, index: index, isSpecial: true)
                        }
                        .buttonStyle(.plain)
                    }

                    if !specialSources.isEmpty, !commitSources.isEmpty {
                        Divider()
                            .frame(height: 34)
                            .padding(.horizontal, 2)
                    }

                    ForEach(Array(commitSources.enumerated()), id: \.element.id) { index, source in
                        Button {
                            selectedSourceID = source.id
                        } label: {
                            sourceChip(source: source, index: index, isSpecial: false)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 1)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.035))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.primary.opacity(0.06), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var fileList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    sectionHeader("Files")
                    ForEach(changes, id: \.path) { file in
                        Button {
                            selectedPath = file.path
                            isFileNavigationFocused = true
                        } label: {
                            HStack(spacing: 10) {
                                statusBadge(for: file.status)
                                Text(file.path)
                                    .font(TermLoopSidebarTheme.tinyMono)
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 5)
                            .background(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(selectedPath == file.path ? Color.accentColor.opacity(0.16) : Color.clear)
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(file.path)
                    }
                }
                .padding(.vertical, 4)
            }
            .onAppear {
                scrollSelectedPath(into: proxy, animated: false)
            }
            .onChange(of: selectedPath) { _, _ in
                scrollSelectedPath(into: proxy, animated: true)
            }
            .onChange(of: changes) { _, _ in
                scrollSelectedPath(into: proxy, animated: false)
            }
        }
    }

    @ViewBuilder
    private var filePane: some View {
        if isLoadingChanges {
            VStack {
                sectionHeader("Files")
                Spacer()
                ProgressView()
                Spacer()
            }
        } else if changes.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                sectionHeader("Files")
                Spacer()
                Image(systemName: emptyFilesIconName)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .frame(maxWidth: .infinity)
                Text(emptyStateTitle)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity)
                Text(emptyStateDescription)
                    .font(TermLoopSidebarTheme.tinyMono)
                    .foregroundStyle(TermLoopSidebarTheme.dim)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                Spacer()
            }
            .padding(.vertical, 8)
        } else {
            fileList
        }
    }

    @ViewBuilder
    private var diffPane: some View {
        let hasChanges = !changes.isEmpty
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader("Diff")

            if !hasChanges {
                VStack(spacing: 10) {
                    Spacer()
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    Text("No diff to show")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.primary)
                    Text("This source has no changed files.")
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let selectedFile {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        statusBadge(for: selectedFile.status)
                        Text(selectedFile.path)
                            .font(TermLoopSidebarTheme.tinyMono)
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                        Spacer()
                    }
                    Text(diffKindLabel(for: selectedFile.status))
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(selectedFile.status.sidebarTint)
                }
            }

            if hasChanges {
                Divider()

                if isLoadingDiff {
                    VStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else {
                    ScrollView([.vertical, .horizontal]) {
                        if diffText.isEmpty {
                            Text("No diff available.")
                                .font(.system(size: 11.5, weight: .regular, design: .monospaced))
                                .foregroundStyle(TermLoopSidebarTheme.dim)
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                        } else {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(diffLines.enumerated()), id: \.offset) { _, line in
                                    diffLineView(line)
                                }
                            }
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // Adapts: light mode → very faint gray wash, dark mode →
                    // the previous near-black plate. `controlBackgroundColor`
                    // is the closest semantic NSColor for an inset surface.
                    .background(
                        Color(nsColor: .controlBackgroundColor).opacity(0.6),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
                }
            }
        }
    }

    private func loadDiff() async {
        guard let selectedFile else {
            await MainActor.run {
                diffText = ""
                isLoadingDiff = false
            }
            return
        }

        let source = currentSource
        let file = selectedFile
        let cacheKey = commitDiffCacheKey(for: source, path: file.path)
        if let cacheKey, let cached = await MainActor.run(body: { commitDiffCache[cacheKey] }) {
            await MainActor.run {
                diffText = cached
                isLoadingDiff = false
            }
            return
        }

        await MainActor.run { isLoadingDiff = true }

        let directory = effectiveDirectory
        let patch = await Task.detached(priority: .utility) { () -> String? in
            switch source {
            case .local:
                return WorktreeLocalChangesProvider.fetchUnifiedDiff(
                    directory: directory,
                    relativePath: file.path,
                    status: file.status
                )
            case .baseComparison(let comparisonTarget):
                return WorktreeBaseComparisonProvider.fetchUnifiedDiff(
                    directory: directory,
                    mergeBase: comparisonTarget.mergeBase,
                    relativePath: file.path
                )
            case .commit(let commit):
                return WorktreeCommitDiffProvider.fetchUnifiedDiff(
                    directory: directory,
                    commitSHA: commit.sha,
                    relativePath: file.path
                )
            }
        }.value

        guard !Task.isCancelled else { return }
        let rendered = patch ?? "No diff available."
        await MainActor.run {
            if let cacheKey {
                commitDiffCache[cacheKey] = rendered
            }
            diffText = rendered
            isLoadingDiff = false
        }
    }

    private func commitDiffCacheKey(for source: WorktreeChangesSource, path: String) -> String? {
        if case .commit(let commit) = source {
            return "\(commit.sha)|\(path)"
        }
        return nil
    }

    @MainActor
    private func refreshComparisonState() async {
        isLoadingChanges = true
        let directory = effectiveDirectory
        let baseline = resolvedBaselineHead
        let seed = candidateSeedsFromMainActor()

        async let localChangesTask: [SidebarGitChangeItem] = Task.detached(priority: .utility) {
            GitWorktreePresentationStore.shared.files(for: directory)
        }.value

        async let targetsTask: [WorktreeBaseComparisonTarget] = Task.detached(priority: .utility) {
            WorktreeBaseComparisonProvider.resolveTargets(
                seededCandidates: seed.candidates,
                currentBranch: seed.currentBranch,
                directory: directory,
                projectRoot: seed.projectRoot
            )
        }.value

        async let commitsAndCounts: ([WorktreeRecentCommit], [String: Int]) = await Task.detached(priority: .utility) {
            let commits = WorktreeCommitDiffProvider.fetchRecentCommits(
                directory: directory,
                baselineHead: baseline
            )
            let counts = WorktreeCommitDiffProvider.fetchCommitFileCounts(
                directory: directory,
                baselineHead: baseline
            )
            return (commits, counts)
        }.value

        let localFiles = await localChangesTask
        let (commits, fileCounts) = await commitsAndCounts
        let newTargets = await targetsTask
        guard !Task.isCancelled else { return }

        let commitSHAs = commits.map(\.sha)
        let mergedInfo = await Task.detached(priority: .utility) {
            WorktreeCommitDiffProvider.fetchMergedBranchesByCommitSHA(
                directory: directory,
                targets: newTargets,
                commitSHAs: commitSHAs
            )
        }.value
        guard !Task.isCancelled else { return }

        localChanges = localFiles
        applyLiveLocalChangesToWorkspaceCache(localFiles, directory: directory)
        baseComparisonTargets = newTargets
        let liveKeys = Set(newTargets)
        baseComparisonChangesByTarget = baseComparisonChangesByTarget.filter { liveKeys.contains($0.key) }
        recentCommits = commits
        let liveShas = Set(commitSHAs)
        commitChangesBySHA = commitChangesBySHA.filter { liveShas.contains($0.key) }
        commitFileCountBySHA = fileCounts
        mergedBranchesBySHA = mergedInfo
        commitDiffCache = commitDiffCache.filter { entry in
            guard let sha = entry.key.split(separator: "|").first else { return false }
            return liveShas.contains(String(sha))
        }

        if !availableSources.contains(where: { $0.id == selectedSourceID }) {
            selectedSourceID = WorktreeChangesSource.local.id
        }

        isLoadingChanges = false
        await loadSourceChanges()
        syncSelectedPath()
    }

    @MainActor
    private func loadSourceChanges() async {
        switch currentSource {
        case .local:
            syncSelectedPath()
        case .baseComparison(let target):
            if baseComparisonChangesByTarget[target] != nil {
                syncSelectedPath()
                return
            }
            isLoadingChanges = true
            let directory = effectiveDirectory
            let files = await Task.detached(priority: .utility) {
                WorktreeBaseComparisonProvider.fetchChangedFiles(
                    directory: directory,
                    mergeBase: target.mergeBase
                ) ?? []
            }.value
            guard !Task.isCancelled else { return }
            baseComparisonChangesByTarget[target] = files
            isLoadingChanges = false
            syncSelectedPath()
        case .commit(let commit):
            if commitChangesBySHA[commit.sha] != nil {
                syncSelectedPath()
                return
            }
            isLoadingChanges = true
            let directory = effectiveDirectory
            let files = await Task.detached(priority: .utility) {
                WorktreeCommitDiffProvider.fetchChangedFiles(
                    directory: directory,
                    commitSHA: commit.sha
                ) ?? []
            }.value
            guard !Task.isCancelled else { return }
            commitChangesBySHA[commit.sha] = files
            isLoadingChanges = false
            syncSelectedPath()
        }
    }

    @MainActor
    private func applyLiveLocalChangesToWorkspaceCache(_ files: [SidebarGitChangeItem], directory: String) {
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path

        for (panelId, panelDirectory) in workspace.panelDirectories {
            let normalizedPanelDirectory = URL(fileURLWithPath: panelDirectory).standardizedFileURL.path
            if normalizedPanelDirectory == normalizedDirectory {
                workspace.updatePanelGitChanges(panelId: panelId, files: files)
            }
        }
    }

    @MainActor
    private func syncSelectedPath() {
        if let selectedPath,
           changes.contains(where: { $0.path == selectedPath }) {
            return
        }
        if let preselectedPath,
           changes.contains(where: { $0.path == preselectedPath }) {
            selectedPath = preselectedPath
        } else {
            selectedPath = changes.first?.path
        }
    }

    @MainActor
    private func moveFileSelection(offset: Int) -> Bool {
        guard !changes.isEmpty else { return false }

        let currentIndex = selectedPath.flatMap { path in
            changes.firstIndex { $0.path == path }
        } ?? 0
        let nextIndex = min(max(currentIndex + offset, changes.startIndex), changes.index(before: changes.endIndex))
        selectedPath = changes[nextIndex].path
        isFileNavigationFocused = true
        return true
    }

    @MainActor
    private func scrollSelectedPath(into proxy: ScrollViewProxy, animated: Bool) {
        guard let selectedPath,
              changes.contains(where: { $0.path == selectedPath }) else { return }

        if animated {
            withAnimation(.easeInOut(duration: 0.12)) {
                proxy.scrollTo(selectedPath, anchor: .center)
            }
        } else {
            proxy.scrollTo(selectedPath, anchor: .center)
        }
    }

    @MainActor
    private func candidateSeedsFromMainActor() -> (
        candidates: [String],
        currentBranch: String?,
        projectRoot: String
    ) {
        var seeded: [String] = []
        for state in workspace.sidebarPullRequestsInDisplayOrder() {
            let trimmed = state.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty, !seeded.contains(trimmed) else { continue }
            seeded.append(trimmed)
        }
        let project = workspace.projectId.flatMap { ProjectStore.shared.project(id: $0) }
            ?? ProjectStore.shared.project(containingPath: effectiveDirectory)
        return (
            candidates: seeded,
            currentBranch: branch?.trimmingCharacters(in: .whitespacesAndNewlines),
            projectRoot: project?.folderPath ?? effectiveDirectory
        )
    }
}

private struct WorktreeGroupGitSummarySnapshot: Equatable {
    let changeCount: Int
    let unmergedCommitCount: Int
    let unmergedBaseBranch: String?
    let commitCount: Int
    let resolvedBaselineHead: String?

    var hasVisibleContent: Bool {
        changeCount > 0 || unmergedCommitCount > 0 || commitCount > 0
    }
}

private enum WorktreeGroupGitSummaryProbe {
    static func snapshot(
        worktreePath: String,
        baselineHeads: [String],
        unmergedBaseBranches: [String]
    ) -> WorktreeGroupGitSummarySnapshot {
        let normalized = Array(Set(
            baselineHeads
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        ))
        let baseline = oldestBaseline(in: worktreePath, candidates: normalized)
        let unmergedBaseline = unmergedBaseline(
            in: worktreePath,
            baseBranches: unmergedBaseBranches
        )
        // Group-level badge is the only visible local-change badge in the
        // Worktree Agents panel. Read it fresh here instead of going through
        // the presentation store cache; otherwise the former per-agent badge
        // could be removed while the group header still showed a stale zero
        // until some other git invalidation happened.
        let liveChangeCount = WorktreeLocalChangesProvider.fetchChangedFiles(directory: worktreePath)?.count ?? 0
        #if DEBUG
        dlog(
            "worktree.summary.snapshot path=\(worktreePath) baselineHeads=\(normalized.joined(separator: ",")) unmergedBases=\(unmergedBaseBranches.joined(separator: ",")) baseline=\(baseline ?? "nil") unmerged=\(unmergedBaseline?.branch ?? "nil") changes=\(liveChangeCount)"
        )
        #endif
        return WorktreeGroupGitSummarySnapshot(
            changeCount: liveChangeCount,
            unmergedCommitCount: commitCount(worktreePath: worktreePath, baseline: unmergedBaseline?.mergeBase) ?? 0,
            unmergedBaseBranch: unmergedBaseline?.branch,
            commitCount: commitCount(worktreePath: worktreePath, baseline: baseline) ?? 0,
            resolvedBaselineHead: baseline
        )
    }

    private static func unmergedBaseline(
        in worktreePath: String,
        baseBranches: [String]
    ) -> (branch: String, mergeBase: String)? {
        let uniqueBranches = Array(Set(
            baseBranches
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
        ))
        let candidates = uniqueBranches.compactMap { branch -> (branch: String, mergeBase: String)? in
            guard let ref = WorktreeBaseComparisonProvider.resolvePreferredRef(branch: branch, directory: worktreePath),
                  let mergeBase = WorktreeBaseComparisonProvider.mergeBase(directory: worktreePath, baseRef: ref) else {
                return nil
            }
            return (branch, mergeBase)
        }
        guard var candidate = candidates.first else { return nil }
        guard candidates.count > 1 else { return candidate }

        let service = GitWorktreeService()
        for baseline in candidates.dropFirst() {
            if (try? service.isAncestor(revision: baseline.mergeBase, of: candidate.mergeBase, in: worktreePath)) == true {
                candidate = baseline
            }
        }
        return candidate
    }

    private static func commitCount(worktreePath: String, baseline: String?) -> Int? {
        let git = ProcessGitStateProvider()
        let baseRef =
            WorktreeBaseComparisonProvider.resolvePreferredRef(branch: "dev", directory: worktreePath)
            ?? baseline
        guard let baseRef else { return nil }
        // Count only non-merge commits that are ahead of the primary branch
        // base (prefer `dev`, fall back to the recorded baseline). This keeps
        // the badge aligned with "branch-specific work" instead of raw merge
        // topology.
        guard let output = try? git.runRaw(["rev-list", "--count", "--no-merges", "\(baseRef)..HEAD"], cwd: worktreePath),
              let count = Int(output.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        return count
    }

    private static func oldestBaseline(
        in worktreePath: String,
        candidates: [String]
    ) -> String? {
        guard var candidate = candidates.first else { return nil }
        guard candidates.count > 1 else { return candidate }

        let service = GitWorktreeService()
        for baseline in candidates.dropFirst() {
            if (try? service.isAncestor(revision: baseline, of: candidate, in: worktreePath)) == true {
                candidate = baseline
            }
        }
        return candidate
    }
}

@MainActor
private struct WorktreeGroupGitSummaryView: View {
    let group: WorktreeAgentsGroup
    let preferredWorkspace: Workspace?
    let openPullRequests: [SidebarPullRequestState]

    @State private var snapshot: WorktreeGroupGitSummarySnapshot?
    @State private var refreshNonce: UInt64 = 0
    @State private var observedLocalChangesPath: String?
    @State private var observedLocalChanges: [SidebarGitChangeItem] = []
    @State private var hasObservedLocalChanges = false
    @State private var localChangesSubscription: AnyCancellable?
    @State private var subscribedLocalChangesPath: String?
    /// Stable subscription keyed on `subscribedWorkspaceIds` — rebuilding
    /// `Publishers.MergeMany(...)` inside `body` re-subscribed per render.
    @State private var refreshSubscription: AnyCancellable?
    @State private var subscribedWorkspaceIds: [UUID] = []
    @State private var lastProbedInput: ProbeInput?

    private struct ProbeInput: Equatable {
        let path: String
        let baselineHeads: [String]
        let unmergedBaseBranches: [String]
        let openPullRequestIdentity: String
        let refreshNonce: UInt64
    }

    var body: some View {
        let path = resolvedWorktreePath
        Group {
            if let snapshot, snapshot.hasVisibleContent {
                HStack(spacing: 4) {
                    if snapshot.changeCount > 0 {
                        Button {
                            openViewer()
                        } label: {
                            TermLoopSidebarToken(
                                label: snapshot.changeCount == 1 ? "1 change" : "\(snapshot.changeCount) changes",
                                tone: .neutral,
                                emphasized: false
                            )
                        }
                        .buttonStyle(.plain)
                        .help("Show local worktree changes")
                    }

                    if snapshot.unmergedCommitCount > 0 {
                        Button {
                            openViewer()
                        } label: {
                            TermLoopSidebarToken(
                                label: snapshot.unmergedCommitCount == 1 ? "1 commit" : "\(snapshot.unmergedCommitCount) commits",
                                tone: .neutral,
                                emphasized: false
                            )
                        }
                        .buttonStyle(.plain)
                        .help(unmergedCommitTooltip(snapshot))
                    }

                    if snapshot.commitCount > 0,
                       snapshot.commitCount != snapshot.unmergedCommitCount {
                        Button {
                            openViewer(baseRef: commitComparisonBaseRef)
                        } label: {
                            TermLoopSidebarToken(
                                label: snapshot.commitCount == 1 ? "1 commit" : "\(snapshot.commitCount) commits",
                                tone: .neutral,
                                emphasized: false
                            )
                        }
                        .buttonStyle(.plain)
                        .help("Open worktree changes viewer")
                    }
                }
            } else {
                Color.clear
                    .frame(width: 0, height: 0)
            }
        }
        .task(id: refreshTaskKey) {
            await refreshSnapshot()
        }
        .onAppear {
            ensureRefreshSubscription()
            ensureLocalChangesSubscription(path: path)
        }
        .onChange(of: group.workspaces.map(\.id)) { _ in
            ensureRefreshSubscription()
        }
        .onChange(of: path) { _, newPath in
            observedLocalChangesPath = newPath
            observedLocalChanges = []
            hasObservedLocalChanges = false
            ensureLocalChangesSubscription(path: newPath)
            refreshNonce &+= 1
        }
    }

    private func ensureRefreshSubscription() {
        let ids = group.workspaces.map(\.id)
        guard ids != subscribedWorkspaceIds else { return }
        subscribedWorkspaceIds = ids
        let publishers = group.workspaces.map(\.sidebarGitChangesObservationPublisher)
        guard !publishers.isEmpty else {
            refreshSubscription = nil
            return
        }
        refreshSubscription = Publishers.MergeMany(publishers)
            .receive(on: RunLoop.main)
            .debounce(for: .milliseconds(150), scheduler: RunLoop.main)
            .sink { _ in refreshNonce &+= 1 }
    }

    private func ensureLocalChangesSubscription(path: String?) {
        guard path != subscribedLocalChangesPath else { return }
        subscribedLocalChangesPath = path
        localChangesSubscription = nil
        guard let path else {
            handleObservedLocalChanges([], path: nil)
            return
        }
        localChangesSubscription = localChangesPublisher(for: path)
            .sink { files in
                handleObservedLocalChanges(files, path: path)
            }
    }

    private func localChangesPublisher(for path: String) -> AnyPublisher<[SidebarGitChangeItem], Never> {
        GitWorktreePresentationStore.shared.filesPublisher(for: path)
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .eraseToAnyPublisher()
    }

    private func handleObservedLocalChanges(_ files: [SidebarGitChangeItem], path: String?) {
        if observedLocalChangesPath != path {
            observedLocalChangesPath = path
            observedLocalChanges = files
            hasObservedLocalChanges = true
            return
        }
        defer {
            observedLocalChanges = files
            hasObservedLocalChanges = true
        }
        guard hasObservedLocalChanges, files != observedLocalChanges else { return }
        refreshNonce &+= 1
    }

    private var refreshTaskKey: String {
        let baseKey = openPullRequestBaseBranches.joined(separator: ",")
        return "\(group.branch)|\(resolvedWorktreePath ?? "none")|\(baseKey)|\(openPullRequestIdentityKey)|\(refreshNonce)"
    }

    private var openPullRequestIdentityKey: String {
        openPullRequests.map { state in
            [
                state.label,
                String(state.number),
                state.url.absoluteString,
                state.status.rawValue,
                state.statusDetail ?? "",
                state.branch ?? "",
                state.baseBranch ?? "",
                state.isStale ? "stale" : "fresh"
            ].joined(separator: "|")
        }
        .joined(separator: "\n")
    }

    private var openPullRequestBaseBranches: [String] {
        Array(Set(
            openPullRequests.compactMap { state in
                let trimmed = state.baseBranch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            }
        ))
        .sorted()
    }

    private var resolvedWorktreePath: String? {
        if let preferred = preferredWorkspace?.termLoopPresentationCwd(),
           !preferred.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            #if DEBUG
            dlog("worktree.summary.resolvedPath source=preferred branch=\(group.branch) path=\(preferred)")
            #endif
            return preferred
        }
        for workspace in group.workspaces {
            let candidate = workspace.termLoopPresentationCwd() ?? workspace.currentDirectory
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                #if DEBUG
                dlog("worktree.summary.resolvedPath source=workspace branch=\(group.branch) ws=\(workspace.id.uuidString.prefix(8)) path=\(trimmed)")
                #endif
                return trimmed
            }
        }
        #if DEBUG
        dlog("worktree.summary.resolvedPath source=nil branch=\(group.branch)")
        #endif
        return nil
    }

    /// Keep the commit-count badge and the viewer it opens aligned:
    /// prefer `dev` when available, otherwise fall back to the recorded
    /// worktree baseline.
    private var commitComparisonBaseRef: String? {
        guard let path = resolvedWorktreePath else { return snapshot?.resolvedBaselineHead }
        return WorktreeBaseComparisonProvider.resolvePreferredRef(branch: "dev", directory: path)
            ?? snapshot?.resolvedBaselineHead
    }

    @MainActor
    private func refreshInput() -> ProbeInput? {
        guard let path = resolvedWorktreePath else { return nil }

        let baselineHeads = group.workspaces.compactMap {
            WorkspaceMetadataStore.shared.worktreeBaselineHead(for: $0)
        }
        #if DEBUG
        dlog("worktree.summary.input branch=\(group.branch) path=\(path) baselineHeads=\(baselineHeads.joined(separator: ",")) unmergedBases=\(openPullRequestBaseBranches.joined(separator: ",")) refreshNonce=\(refreshNonce)")
        #endif

        return ProbeInput(
            path: path,
            baselineHeads: baselineHeads,
            unmergedBaseBranches: openPullRequestBaseBranches,
            openPullRequestIdentity: openPullRequestIdentityKey,
            refreshNonce: refreshNonce
        )
    }

    private func refreshSnapshot() async {
        guard let input = refreshInput() else {
            await MainActor.run {
                snapshot = nil
                lastProbedInput = nil
            }
            return
        }
        if input == lastProbedInput { return }
        let branch = group.branch
        #if DEBUG
        dlog("worktree.summary.refresh.begin branch=\(branch) path=\(input.path) refreshNonce=\(input.refreshNonce)")
        #endif

        let result = await Task.detached(priority: .utility) {
            WorktreeGroupGitSummaryProbe.snapshot(
                worktreePath: input.path,
                baselineHeads: input.baselineHeads,
                unmergedBaseBranches: input.unmergedBaseBranches
            )
        }.value

        guard !Task.isCancelled else { return }
        await MainActor.run {
            snapshot = result
            lastProbedInput = input
            #if DEBUG
            dlog("worktree.summary.refresh.result branch=\(branch) path=\(input.path) changes=\(result.changeCount) unmerged=\(result.unmergedCommitCount) commits=\(result.commitCount)")
            #endif
        }
    }

    @MainActor
    private func openViewer(baseRef: String? = nil) {
        guard let workspace = preferredWorkspace ?? group.workspaces.first else { return }
        GitChangesMainAreaStore.shared.show(
            WorktreeChangesPresentation(
                workspaceId: workspace.id,
                branch: group.branch,
                worktreePath: resolvedWorktreePath ?? workspace.termLoopPresentationCwd(),
                preselectedPath: nil,
                baselineHead: baseRef ?? snapshot?.resolvedBaselineHead
            )
        )
    }

    private func unmergedCommitTooltip(_ snapshot: WorktreeGroupGitSummarySnapshot) -> String {
        if let baseBranch = snapshot.unmergedBaseBranch,
           !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Show commits not merged into \(baseBranch)"
        }
        return "Show commits not merged into the pull request base"
    }
}

@MainActor
struct WorktreeAgentsHiddenRow: View {
    @AppStorage(WorktreeAgentsPanelState.hiddenKey) private var isHidden: Bool = false

    var body: some View {
        if isHidden {
            VStack(spacing: 0) {
                TermLoopSidebarRule()
                Button {
                    isHidden = false
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.up")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .frame(width: 10)
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(TermLoopSidebarTheme.dim)
                            .frame(width: 12, height: 12)
                        Text(TermLoopSidebarTheme.caps(String(
                            localized: "worktreeAgents.panel.title",
                            defaultValue: "Worktree Agents",
                            table: "TermLoop"
                        )))
                        .font(TermLoopSidebarTheme.sectionCaps)
                        .foregroundStyle(Color.primary.opacity(0.82))
                        Spacer()
                        Text(String(
                            localized: "worktreeAgents.panel.hidden.restore",
                            defaultValue: "restore",
                            table: "TermLoop"
                        ))
                        .font(TermLoopSidebarTheme.tinyMono)
                        .foregroundStyle(TermLoopSidebarTheme.dim)
                    }
                    .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "worktreeAgents.panel.hidden.help",
                    defaultValue: "Click to restore Worktree Agents",
                    table: "TermLoop"
                ))
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct WorktreeGroupPullRequestBadge: View, Equatable {
    let summary: WorktreeAgentsPullRequestSummary.Summary?
    let allPullRequests: [SidebarPullRequestState]
    let openPullRequests: ([SidebarPullRequestState]) -> Void
    let openSinglePullRequest: (URL) -> Void

    @State private var showingDetails: Bool = false

    nonisolated static func == (
        lhs: WorktreeGroupPullRequestBadge,
        rhs: WorktreeGroupPullRequestBadge
    ) -> Bool {
        // Call sites pass stateless open closures; row identity is driven by
        // PR data, and closure identity churn would defeat `.equatable()`.
        lhs.summary == rhs.summary &&
            lhs.allPullRequests == rhs.allPullRequests
    }

    var body: some View {
        if let summary,
           let primary = summary.primary {
            // Same pill regardless of count. With one PR a click opens it
            // directly. With two or more a click surfaces a popover listing
            // every PR so users can pick one or open them all.
            Button {
                if allPullRequests.count <= 1 {
                    openPullRequests(allPullRequests.isEmpty ? summary.pullRequests : allPullRequests)
                } else {
                    showingDetails.toggle()
                }
            } label: {
                badgeLabel(for: primary, summary: summary)
            }
            .buttonStyle(.plain)
            .help(openTooltip(for: summary))
            .popover(isPresented: $showingDetails, arrowEdge: .bottom) {
                detailsList
            }
        } else {
            Color.clear
                .frame(width: 0, height: 0)
        }
    }

    private var detailsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(allPullRequests.enumerated()), id: \.element.url) { index, pullRequest in
                Button {
                    showingDetails = false
                    openSinglePullRequest(pullRequest.url)
                } label: {
                    HStack(spacing: 8) {
                        statusDot(for: pullRequest.status)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: "\(pullRequest.label) #\(pullRequest.number)")
                                .font(.system(size: 12, weight: .semibold))
                            Text(verbatim: detailLine(for: pullRequest))
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 12)
                        Image(systemName: "arrow.up.right.square")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if index < allPullRequests.count - 1 {
                    Divider().padding(.leading, 26)
                }
            }
            Divider()
            Button {
                showingDetails = false
                openPullRequests(allPullRequests)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "rectangle.stack")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .frame(width: 10)
                    Text(String(
                        localized: "worktreeAgents.pullRequestBadge.openAll",
                        defaultValue: "Open all in browser",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 12))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 4)
        .frame(minWidth: 240)
    }

    private func statusDot(for status: SidebarPullRequestStatus) -> some View {
        Circle()
            .fill(statusColor(status))
            .frame(width: 8, height: 8)
    }

    private func statusColor(_ status: SidebarPullRequestStatus) -> Color {
        switch status {
        case .open:   return .green
        case .merged: return .purple
        case .closed: return .secondary
        }
    }

    private func detailLine(for pullRequest: SidebarPullRequestState) -> String {
        let base = pullRequest.baseBranch.map { " → \($0)" } ?? ""
        return "\(pullRequest.displayStatus)\(base)"
    }

    private func badgeLabel(
        for primary: SidebarPullRequestState,
        summary: WorktreeAgentsPullRequestSummary.Summary
    ) -> some View {
        TermLoopSidebarToken(
            label: summary.headerLabel,
            tone: tone(for: primary.status),
            emphasized: primary.status == .open
        )
    }

    private func openTooltip(for summary: WorktreeAgentsPullRequestSummary.Summary) -> String {
        let action: String
        switch (allPullRequests.count, summary.pullRequests.count) {
        case (2..., _):
            action = String(
                localized: "worktreeAgents.pullRequestBadge.menu.help",
                defaultValue: "Show pull requests",
                table: "TermLoop"
            )
        case (_, 1):
            action = String(
                localized: "worktreeAgents.pullRequestBadge.openSingle.help",
                defaultValue: "Open pull request",
                table: "TermLoop"
            )
        default:
            action = String(
                localized: "worktreeAgents.pullRequestBadge.openMultiple.help",
                defaultValue: "Open pull requests",
                table: "TermLoop"
            )
        }
        let details = summary.tooltip
        return details.isEmpty ? action : "\(action)\n\(details)"
    }

    private func tone(for status: SidebarPullRequestStatus) -> TermLoopSidebarTokenTone {
        switch status {
        case .open:
            return .accent
        case .merged:
            return .neutral
        case .closed:
            return .muted
        }
    }
}

/// User/app-owned remote item chip for the worktree. Agents can read this
/// binding through MCP, but cannot write it.
private struct WorktreeGroupRemoteItemBadge: View, Equatable {
    let snapshot: WorktreeAgentsPanel.WorktreeGroupRemoteItemBadgeSnapshot

    var body: some View {
        let chip = chipContent.help(snapshot.tooltip)
        if let destination = snapshot.destinationURL {
            Button {
                NSWorkspace.shared.open(destination)
            } label: {
                chip
            }
            .buttonStyle(.plain)
        } else {
            chip
        }
    }

    @ViewBuilder
    private var chipContent: some View {
        if snapshot.provider == .jira {
            jiraChip
        } else {
            TermLoopSidebarToken(
                label: snapshot.label,
                tone: .accent,
                emphasized: false
            )
        }
    }

    /// Capsule with a ticket icon — picked specifically because the
    /// generic accent tone (used for PRs/commits) and the warning tone are
    /// already in this row. Ticket gives the chip its own slot in
    /// the visual hierarchy without colliding with either.
    ///
    /// Light/dark adaptive: pure #F7C700 yellow on a near-white sidebar
    /// is unreadable, so light mode drops to a deep amber foreground with
    /// a soft ivory fill; dark mode keeps the bright Jira yellow.
    private var jiraChip: some View {
        HStack(spacing: 4) {
            Image(systemName: "ticket.fill")
                .font(.system(size: 8.5, weight: .semibold))
            Text(verbatim: snapshot.label)
                .lineLimit(1)
                .truncationMode(.middle)
                .monospacedDigit()
        }
        .font(TermLoopSidebarTheme.tinyMono)
        .foregroundStyle(TermLoopSidebarTheme.jiraChipForeground)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(TermLoopSidebarTheme.jiraChipBackground))
        .overlay(Capsule().strokeBorder(TermLoopSidebarTheme.jiraChipBorder, lineWidth: 1))
    }
}
