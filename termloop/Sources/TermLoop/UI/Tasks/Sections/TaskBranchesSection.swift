// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: agents attached to the selected task worktree,
/// with the live checkout as compact context. The task sidebar should not make
/// expected-branch drift the primary story; the current checkout already tells
/// the user where the agents are running.
struct TaskBranchesSection: View {
    let branch: String?
    let worktreePath: String?
    let projectId: UUID?
    let taskWorkspaceId: UUID?
    let provisionState: TaskProvisionState
    var selectedAgentWorkspaceId: UUID? = nil
    var onOpenWorktree: (() -> Void)? = nil
    var onStartAgent: (() -> Void)? = nil
    var onCreateWorktree: (() -> Void)? = nil
    var onLinkWorktree: (() -> Void)? = nil
    var onClearWorktreeError: (() -> Void)? = nil
    var onRebind: (() -> Void)? = nil
    var onUnbind: (() -> Void)? = nil
    var onArchive: (() -> Void)? = nil
    var onOpenAgentTerminal: ((UUID) -> Void)? = nil

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared
    @ObservedObject private var localSetupCoordinator = WorktreeSetupCoordinator.shared
    @EnvironmentObject private var tabManager: TabManager

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.branches",
                       defaultValue: "Worktree Agents", table: "TermLoop")
            )

            if hasWorktreeContext {
                worktreeContext
                actionRow
                localSetupStatusRow
                repairBannerIfNeeded
                agentList
                if !secondaryBranches.isEmpty {
                    otherBranchesLine(secondaryBranches)
                }
            } else {
                TaskWorktreeSetupCard(
                    state: provisionState,
                    isCreateDisabled: onCreateWorktree == nil,
                    isLinkDisabled: onLinkWorktree == nil,
                    onCreate: { onCreateWorktree?() },
                    onLink: { onLinkWorktree?() },
                    onClearError: { onClearWorktreeError?() }
                )
            }
        }
    }

    /// Single compact context block for where the task's agents run. The task
    /// header stays focused on task identity; worktree details live here with
    /// the actions that operate on that checkout.
    @ViewBuilder
    private var worktreeContext: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(currentBranchName ?? detachedLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.primary.opacity(0.86))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let path = normalizedWorktreePath {
                    Text(compactPath(path))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(path)
                } else {
                    Text(String(localized: "tasks.sidebar.section.branches.noPath",
                                defaultValue: "Worktree metadata is present, but no path is recorded.",
                                table: "TermLoop"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .contextMenu {
            if projectId != nil {
                LocalSetupWorktreeMenuItems(projectId: projectId, worktreePath: normalizedWorktreePath)
                Divider()
            }
            if let group = taskWorktreeGroup {
                WorktreeGroupContextMenu(
                    group: group,
                    sourceWorkspace: sourceWorkspace(for: group),
                    tabManager: tabManager,
                    onChanged: { worktreeProjectionStore.markChanged(reason: "taskSidebar.contextMenu") },
                    onDeleted: { worktreeProjectionStore.markChanged(reason: "taskSidebar.delete") }
                )
            }
        }
    }

    private var actionRow: some View {
        HStack(spacing: 6) {
            Button {
                onOpenWorktree?()
            } label: {
                Label(String(localized: "tasks.sidebar.action.openWorktree",
                             defaultValue: "Open Worktree",
                             table: "TermLoop"),
                      systemImage: "terminal")
            }
            .disabled(!canOpenWorktree)

            Button {
                onStartAgent?()
            } label: {
                Label(String(localized: "tasks.sidebar.action.agent",
                             defaultValue: "Start Agent",
                             table: "TermLoop"),
                      systemImage: "plus")
            }
            .disabled(!canStartAgent)

            localSetupMenu
        }
        .buttonStyle(.bordered)
        .controlSize(.mini)
        .font(.system(size: 12, weight: .medium))
    }

    @ViewBuilder
    private var localSetupMenu: some View {
        Spacer(minLength: 0)
        if projectId != nil {
            Menu {
                LocalSetupWorktreeMenuItems(projectId: projectId, worktreePath: normalizedWorktreePath)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .frame(width: 24)
            .help(String(localized: "worktreeSetup.menu.help", defaultValue: "Local setup actions", table: "TermLoop"))
        }
    }

    @ViewBuilder
    private var localSetupStatusRow: some View {
        if let status = localSetupStatus, let projectId {
            LocalSetupInlineStatusRow(
                status: status,
                logs: localSetupCoordinator.logs(projectId: projectId, worktreePath: status.worktreePath),
                onPrepare: { LocalSetupActions.run(projectId: projectId, worktreePath: status.worktreePath, force: status.phase == .failed) },
                onSkip: { LocalSetupActions.skip(projectId: projectId, worktreePath: status.worktreePath) },
                onCancel: { LocalSetupActions.cancel(projectId: projectId, worktreePath: status.worktreePath) },
                onOpenConfig: { LocalSetupActions.openConfig(projectId: projectId) },
                onGenerate: { LocalSetupActions.openGenerator(projectId: projectId) }
            )
        }
    }

    @ViewBuilder
    private var repairBannerIfNeeded: some View {
        if case .failed = provisionState {
            TaskRepairBanner(
                reason: provisionState.failureDisplayText ?? "",
                onRebind: { onRebind?() },
                onUnbind: { onUnbind?() },
                onArchive: { onArchive?() }
            )
        }
    }

    @ViewBuilder
    private var agentList: some View {
        let agents = currentAgentRows
        if agents.isEmpty {
            TaskSidebarEmptyText(
                String(localized: "tasks.sidebar.section.branches.noAgents",
                       defaultValue: "No agents attached.", table: "TermLoop")
            )
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(agents, id: \.workspaceId) { agent in
                    agentRow(agent)
                }
            }
        }
    }

    /// Recorded branches that are *not* the current checkout. Rare, but when
    /// present they hint at past drift between expected and live branches.
    /// One inline line — no header, no card. The chevron icon carries the
    /// "branch" semantic.
    private func otherBranchesLine(_ branches: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(String(
                localized: "tasks.sidebar.section.branches.otherInline",
                defaultValue: "Other:",
                table: "TermLoop"
            ))
                .foregroundStyle(.tertiary)
            Text(branches.joined(separator: ", "))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.system(size: 12))
    }

    private var currentAgentRows: [AgentRowPresentationSnapshot] {
        // Intentional subscription reads: rows reuse Loop's live agent
        // presentation while this section stays projection-only.
        _ = metadataStore
        _ = activityStore
        _ = worktreeProjectionStore.version
        return TaskAgentProjectionBuilder.agentRowSnapshots(
            worktreePath: worktreePath,
            taskWorkspaceId: taskWorkspaceId,
            workspaces: tabManager.tabs,
            branchLabel: currentBranchName,
            projectId: projectId,
            fallbackAgentLabel: fallbackAgentLabel
        )
    }

    @ViewBuilder
    private func agentRow(_ core: AgentRowPresentationSnapshot) -> some View {
        let workspaceId = core.workspaceId
        AgentRowCoreView(
            core: core,
            isSelected: selectedAgentWorkspaceId == workspaceId,
            trailingSlot: .none,
            dismissBehavior: .none,
            onActivate: {
                onOpenAgentTerminal?(workspaceId)
            },
            onAcknowledgeAttention: {
                TerminalAgentActivityStore.shared.acknowledgeViewedAttention(forWorkspaceId: workspaceId)
            },
            onTrailingSlotTap: nil
        )
        .equatable()
        .disabled(onOpenAgentTerminal == nil)
        .opacity(onOpenAgentTerminal == nil ? 0.70 : 1.0)
        .help(onOpenAgentTerminal == nil ? "" : String(localized: "tasks.sidebar.section.branches.openTerminal",
                                                        defaultValue: "Open this agent terminal below the board",
                                                        table: "TermLoop"))
    }

    private var currentBranchName: String? {
        liveBranch ?? normalizedBranch
    }

    private var taskWorktreeGroup: WorktreeAgentsGroup? {
        guard let path = normalizedWorktreePath else { return nil }
        let workspaces = taskWorktreeWorkspaces
        let status = taskWorktreeStatus(path: path, workspaces: workspaces)
        let expectedBranches = [normalizedBranch ?? liveBranch].compactMap { value in
            value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        }
        let branchLabel = currentBranchName
            ?? TaskAgentProjectionBuilder.pathLeaf(path)
            ?? String(localized: "tasks.sidebar.section.branches.detached",
                      defaultValue: "Detached HEAD", table: "TermLoop")
        return WorktreeAgentsGroup(
            id: "path:\(WorktreeResolver.normalizePath(path) ?? path)",
            branch: branchLabel,
            workspaces: workspaces,
            worktreePath: path,
            projectId: projectId,
            statusKind: status?.kind,
            observedRef: status?.observedRef,
            expectedBranches: expectedBranches,
            needsAttention: status?.needsUserAttention ?? false
        )
    }

    private var taskWorktreeWorkspaces: [Workspace] {
        var orderedIds: [UUID] = []
        func append(_ workspaceId: UUID?) {
            guard let workspaceId, !orderedIds.contains(workspaceId) else { return }
            orderedIds.append(workspaceId)
        }

        if let path = normalizedWorktreePath {
            taskWorktreeProjectionEntry?.workspaceIds.forEach { append($0) }
            WorkspaceMetadataStore.shared
                .workspaceIds(withWorktreePath: path, projectId: projectId)
                .forEach { append($0) }
        }
        append(taskWorkspaceId)

        let workspaceById = Dictionary(
            uniqueKeysWithValues: tabManager.tabs.map { ($0.id, $0) }
        )
        return orderedIds.compactMap { workspaceById[$0] }
    }

    private var taskWorktreeProjectionEntry: WorktreeProjectionEntry? {
        guard let projectId,
              let path = normalizedWorktreePath else { return nil }
        return WorktreeProjectionStore.shared
            .snapshot(projectId: projectId, workspaces: tabManager.tabs)?
            .entry(forWorktreePath: path)
    }

    private func taskWorktreeStatus(path: String, workspaces: [Workspace]) -> WorktreeStatus? {
        let workspaceStatuses = workspaces.compactMap {
            $0.termLoopCachedWorktreeStatus(maximumAge: 60)
        }
        if let attention = workspaceStatuses.first(where: \.needsUserAttention) {
            return attention
        }
        if let first = workspaceStatuses.first {
            return first
        }

        if let projectId,
           let project = ProjectStore.shared.project(id: projectId),
           let snapshot = WorktreeRegistry.shared.cachedSnapshot(
                projectFolder: project.folderPath,
                maximumAge: 60
           ) {
            return WorktreeReconciler.status(
                for: WorktreeReconciler.Binding(
                    expectedBranch: normalizedBranch,
                    worktreePath: path
                ),
                entries: snapshot.entries
            )
        }

        guard let expected = normalizedBranch,
              let observed = TermLoopWorktreeHeadReader.currentObservedRefWithoutGit(checkoutPath: path),
              observed.branchName != expected else {
            return nil
        }
        return WorktreeStatus(
            kind: .branchDrift,
            expectedBranch: expected,
            path: path,
            pathSource: .metadata,
            observedRef: observed,
            isMain: false,
            isLocked: false,
            isPrunable: false,
            message: nil
        )
    }

    private func sourceWorkspace(for group: WorktreeAgentsGroup) -> Workspace? {
        if let taskWorkspaceId,
           let workspace = tabManager.tabs.first(where: { $0.id == taskWorkspaceId }) {
            return workspace
        }
        if let selected = group.workspaces.first(where: { $0.id == tabManager.selectedTabId }) {
            return selected
        }
        return group.workspaces.first
    }

    private var hasWorktreeContext: Bool {
        normalizedWorktreePath != nil || taskWorkspaceId != nil || currentBranchName != nil
    }

    private var canOpenWorktree: Bool {
        onOpenWorktree != nil && (taskWorkspaceId != nil || normalizedWorktreePath != nil)
    }

    private var canStartAgent: Bool {
        guard onStartAgent != nil else { return false }
        guard taskWorkspaceId != nil || normalizedWorktreePath != nil else { return false }
        return provisionState != .pending
    }

    private var localSetupStatus: WorktreeSetupStatusSnapshot? {
        _ = localSetupCoordinator.version
        guard let projectId,
              let path = normalizedWorktreePath else {
            return nil
        }
        return localSetupCoordinator.visibleStatus(projectId: projectId, worktreePath: path)
    }

    private var secondaryBranches: [String] {
        var values: [String] = []
        _ = worktreeProjectionStore.version
        values.append(contentsOf: TaskAgentProjectionBuilder.recordedBranches(
            worktreePath: worktreePath,
            expectedBranch: normalizedBranch,
            projectId: projectId
        ))
        let current = currentBranchName
        return Array(Set(values))
            .filter { $0 != current }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private var liveBranch: String? {
        guard let path = normalizedWorktreePath else { return nil }
        return GitWorktreePresentationStore.shared.branch(for: path)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    private var detachedLabel: String {
        if let path = normalizedWorktreePath,
           let head = GitWorktreePresentationStore.shared.snapshot(for: path)?.headSHA {
            return "detached@\(String(head.prefix(12)))"
        }
        return String(localized: "tasks.sidebar.section.branches.detached",
                      defaultValue: "Detached HEAD", table: "TermLoop")
    }

    private var normalizedBranch: String? {
        branch?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }

    private var normalizedWorktreePath: String? {
        guard let worktreePath else { return nil }
        return TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
    }

    private var fallbackAgentLabel: String {
        String(localized: "tasks.sidebar.section.branches.agent",
               defaultValue: "agent", table: "TermLoop")
    }

    private func compactPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        let leaf = url.lastPathComponent
        let parent = url.deletingLastPathComponent().lastPathComponent
        guard !parent.isEmpty else { return leaf }
        return "…/\(parent)/\(leaf)"
    }
}

private struct TaskWorktreeSetupCard: View {
    let state: TaskProvisionState
    var isCreateDisabled = false
    var isLinkDisabled = false
    let onCreate: () -> Void
    var onLink: (() -> Void)? = nil
    let onClearError: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                statusIcon
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.primary)
                    Text(bodyText)
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            if let detailText {
                Text(detailText)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(5)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 6) {
                Button(action: onCreate) {
                    if isPending {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: 12, height: 12)
                    } else {
                        Image(systemName: primaryIcon)
                    }
                    Text(primaryTitle)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(isPending || isCreateDisabled)

                if let onLink {
                    Button(action: onLink) {
                        Image(systemName: "link")
                        Text(String(localized: "tasks.sidebar.worktreeSetup.link",
                                    defaultValue: "Link Worktree",
                                    table: "TermLoop"))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(isPending || isLinkDisabled)
                }

                if isFailed {
                    Button(action: onClearError) {
                        Text(String(localized: "tasks.sidebar.worktreeSetup.clearError",
                                    defaultValue: "Clear error",
                                    table: "TermLoop"))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardTint.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(cardTint.opacity(0.24), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var statusIcon: some View {
        if isPending {
            ProgressView()
                .controlSize(.small)
        } else {
            Image(systemName: isFailed ? "exclamationmark.triangle" : "arrow.triangle.branch")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(cardTint)
        }
    }

    private var title: String {
        if isPending {
            return String(localized: "tasks.sidebar.worktreeSetup.pendingTitle",
                          defaultValue: "Creating worktree",
                          table: "TermLoop")
        }
        if isDirtySourceFailure {
            return String(localized: "tasks.sidebar.worktreeSetup.dirtyTitle",
                          defaultValue: "Project checkout has local changes",
                          table: "TermLoop")
        }
        if isFailed {
            return String(localized: "tasks.sidebar.worktreeSetup.failedTitle",
                          defaultValue: "Worktree setup failed",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.worktreeSetup.title",
                      defaultValue: "Create a worktree for this task",
                      table: "TermLoop")
    }

    private var bodyText: String {
        if isPending {
            return String(localized: "tasks.sidebar.worktreeSetup.pendingBody",
                          defaultValue: "TermLoop is creating an isolated checkout and binding this task to it.",
                          table: "TermLoop")
        }
        if isDirtySourceFailure {
            return String(localized: "tasks.sidebar.worktreeSetup.dirtyBody",
                          defaultValue: "Choose a base branch and create from HEAD only to leave uncommitted project changes in the current checkout.",
                          table: "TermLoop")
        }
        if isFailed {
            return String(localized: "tasks.sidebar.worktreeSetup.failedBody",
                          defaultValue: "Fix the project state and retry. TermLoop will create a task checkout before starting the agent.",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.worktreeSetup.body",
                      defaultValue: "Create an isolated checkout for this task. You can start an agent from this section after the worktree exists.",
                      table: "TermLoop")
    }

    private var detailText: String? {
        guard isFailed, !isDirtySourceFailure else { return nil }
        return failureReason ?? state.failureDisplayText
    }

    private var primaryTitle: String {
        if isPending {
            return String(localized: "tasks.sidebar.worktreeSetup.creating",
                          defaultValue: "Creating...",
                          table: "TermLoop")
        }
        if isFailed {
            return String(localized: "tasks.sidebar.worktreeSetup.retry",
                          defaultValue: "Retry Create Worktree",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.worktreeSetup.create",
                      defaultValue: "Create Worktree",
                      table: "TermLoop")
    }

    private var primaryIcon: String {
        isFailed ? "arrow.triangle.2.circlepath" : "plus"
    }

    private var cardTint: Color {
        if isPending { return .orange }
        if isFailed { return .red }
        return .accentColor
    }

    private var failureReason: String? {
        guard case .failed(let reason) = state else { return nil }
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var isDirtySourceFailure: Bool {
        failureReason.map(TaskProvisionFailureReason.isDirtySourceCheckout) ?? false
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }

    private var isPending: Bool {
        state == .pending
    }
}

struct TaskSidebarSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(TermLoopSidebarTheme.adaptiveSectionTitle(title))
            .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 13))
            .foregroundStyle(Color.primary.opacity(0.72))
    }
}

struct TaskSidebarEmptyText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundColor(.secondary.opacity(0.92))
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
