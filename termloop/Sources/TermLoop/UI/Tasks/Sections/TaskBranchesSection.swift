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
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.branches",
                       defaultValue: "Worktree Agents", table: "TermLoop")
            )

            if normalizedWorktreePath == nil && currentBranchName == nil {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.branches.empty",
                           defaultValue: "No worktree info.", table: "TermLoop")
                )
            } else {
                metaLine
                agentList
                if !secondaryBranches.isEmpty {
                    otherBranchesLine(secondaryBranches)
                }
            }
        }
    }

    /// Single quiet line that gives the worktree context the agent rows
    /// run in: live branch (or `detached@<sha>`) followed by a compact path
    /// (`…/parent/leaf`). Replaces the previous tinted "current" strip + the
    /// dedicated path row — the user does not need a billboard for this
    /// information, just a one-line caption.
    @ViewBuilder
    private var metaLine: some View {
        let parts: [String] = {
            var out: [String] = []
            out.append(currentBranchName ?? detachedLabel)
            if let path = normalizedWorktreePath {
                out.append(compactPath(path))
            }
            return out
        }()
        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(normalizedWorktreePath ?? (currentBranchName ?? ""))
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
        Text(TermLoopSidebarTheme.adaptiveSectionTitle(title))
            .font(TermLoopSidebarTheme.adaptiveSectionFont(size: 13))
            .foregroundStyle(TermLoopSidebarTheme.adaptiveSectionColor)
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
            .foregroundColor(.secondary)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
