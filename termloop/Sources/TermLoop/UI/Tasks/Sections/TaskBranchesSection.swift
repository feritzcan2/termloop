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
    let taskWorkspaceId: UUID?
    var selectedAgentWorkspaceId: UUID? = nil
    var onOpenAgentTerminal: ((UUID) -> Void)? = nil

    @ObservedObject private var metadataStore = WorkspaceMetadataStore.shared
    @ObservedObject private var activityStore = TerminalAgentActivityStore.shared
    @EnvironmentObject private var tabManager: TabManager

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.branches",
                       defaultValue: "WORKTREE AGENTS", table: "TermLoop")
            )

            if normalizedWorktreePath == nil && currentBranchName == nil {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.branches.empty",
                           defaultValue: "No worktree info.", table: "TermLoop")
                )
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    liveCheckoutStrip
                    agentsPanel

                    let others = secondaryBranches
                    if !others.isEmpty {
                        recordedBranchesStrip(others)
                    }

                    if let path = normalizedWorktreePath {
                        pathLine(path)
                    }
                }
            }
        }
    }

    private var liveCheckoutStrip: some View {
        HStack(spacing: 7) {
            Image(systemName: "largecircle.fill.circle")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.accentColor)
                .frame(width: 14)
            Text(String(localized: "tasks.sidebar.section.branches.currentCheckout",
                        defaultValue: "current", table: "TermLoop"))
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(.accentColor)
            Text(currentBranchName ?? detachedLabel)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            let agents = currentAgentRows
            if !agents.isEmpty {
                Text(agentCountText(agents.count))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .padding(.vertical, 2)
                    .padding(.horizontal, 6)
                    .background(Color.white.opacity(0.055))
                    .clipShape(Capsule())
            }
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.075))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var agentsPanel: some View {
        let agents = currentAgentRows
        return VStack(alignment: .leading, spacing: 7) {
            if agents.isEmpty {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.branches.noAgents",
                           defaultValue: "No agents are attached to this worktree.", table: "TermLoop")
                )
                .padding(.vertical, 4)
            } else {
                ForEach(agents, id: \.workspaceId) { agent in
                    agentRow(agent)
                }
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func recordedBranchesStrip(_ branches: [String]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(String(localized: "tasks.sidebar.section.branches.otherBindings",
                        defaultValue: "RECORDED BRANCHES", table: "TermLoop"))
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.secondary.opacity(0.75))
            VStack(alignment: .leading, spacing: 4) {
                ForEach(branches, id: \.self) { branch in
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundColor(.secondary.opacity(0.75))
                        Text(branch)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.2))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func pathLine(_ path: String) -> some View {
        HStack(spacing: 4) {
            Text(String(localized: "tasks.sidebar.section.branches.pathLabel",
                        defaultValue: "path", table: "TermLoop"))
            Text("·")
            Text(compactPath(path))
                .truncationMode(.middle)
        }
        .font(.system(size: 10, design: .monospaced))
        .foregroundColor(.secondary.opacity(0.78))
        .lineLimit(1)
        .help(path)
    }

    private var currentAgentRows: [AgentRowPresentationSnapshot] {
        _ = metadataStore
        _ = activityStore
        return TaskAgentProjectionBuilder.agentRowSnapshots(
            worktreePath: worktreePath,
            taskWorkspaceId: taskWorkspaceId,
            workspaces: tabManager.tabs,
            branchLabel: currentBranchName,
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

    private var secondaryBranches: [String] {
        var values: [String] = []
        values.append(contentsOf: TaskAgentProjectionBuilder.recordedBranches(
            worktreePath: worktreePath,
            expectedBranch: normalizedBranch
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

    private func agentCountText(_ count: Int) -> String {
        if count == 1 {
            return String(localized: "tasks.sidebar.section.branches.agentCount.one",
                          defaultValue: "1 agent",
                          table: "TermLoop")
        }
        return String(localized: "tasks.sidebar.section.branches.agentCount.many",
                      defaultValue: "\(count) agents",
                      table: "TermLoop")
    }

    private func compactPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        let leaf = url.lastPathComponent
        let parent = url.deletingLastPathComponent().lastPathComponent
        guard !parent.isEmpty else { return leaf }
        return "…/\(parent)/\(leaf)"
    }

}

struct TaskSidebarSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.system(size: 10, weight: .medium))
            .foregroundColor(.secondary)
    }
}

struct TaskSidebarEmptyText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundColor(.secondary)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
