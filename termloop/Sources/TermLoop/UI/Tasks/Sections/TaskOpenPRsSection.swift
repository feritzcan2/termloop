// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Sidebar drill-in section: PRs for the selected task's branch.
struct TaskOpenPRsSection: View {
    let workspaceId: UUID?
    let worktreePath: String?
    let branch: String?

    @ObservedObject private var pullRequestStore = WorktreeBranchPullRequestStore.shared

    private var pullRequests: [SidebarPullRequestState] {
        guard let branch = normalizedBranch else { return [] }
        return WorktreeAgentsPullRequestSummary.orderedUniquePullRequests(
            from: pullRequestStore.cachedPullRequests(directory: normalizedWorktreePath, branch: branch)
        )
    }

    private var openPullRequests: [SidebarPullRequestState] {
        pullRequests.filter { $0.status == .open }
    }

    private var mergedPullRequests: [SidebarPullRequestState] {
        pullRequests.filter { $0.status == .merged }
    }

    private var closedPullRequests: [SidebarPullRequestState] {
        pullRequests.filter { $0.status == .closed }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskSidebarSectionTitle(
                String(localized: "tasks.sidebar.section.pullRequests",
                       defaultValue: "Pull Requests", table: "TermLoop")
            )
            if normalizedBranch == nil {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.openPRs.noBranch",
                           defaultValue: "No branch attached.", table: "TermLoop")
                )
            } else if normalizedWorktreePath == nil {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.openPRs.noPath",
                           defaultValue: "No worktree path attached.", table: "TermLoop")
                )
            } else if pullRequests.isEmpty {
                TaskSidebarEmptyText(
                    String(localized: "tasks.sidebar.section.pullRequests.empty",
                           defaultValue: "No PRs found.", table: "TermLoop")
                )
            } else {
                summaryLine
                prGroups
            }
        }
        .onAppear { ensureLookup() }
        .onChange(of: normalizedWorktreePath) { _, _ in ensureLookup() }
        .onChange(of: normalizedBranch) { _, _ in ensureLookup() }
    }

    private var prGroups: some View {
        VStack(alignment: .leading, spacing: 7) {
            prGroup(
                title: String(localized: "tasks.sidebar.section.openPRs",
                              defaultValue: "OPEN PRS", table: "TermLoop"),
                pullRequests: openPullRequests,
                emptyText: String(localized: "tasks.sidebar.section.openPRs.empty",
                                  defaultValue: "No open PRs.", table: "TermLoop")
            )
            if !mergedPullRequests.isEmpty {
                prGroup(
                    title: String(localized: "tasks.sidebar.section.mergedPRs",
                                  defaultValue: "MERGED PRS", table: "TermLoop"),
                    pullRequests: mergedPullRequests,
                    emptyText: ""
                )
            }
            if !closedPullRequests.isEmpty {
                prGroup(
                    title: String(localized: "tasks.sidebar.section.closedPRs",
                                  defaultValue: "CLOSED PRS", table: "TermLoop"),
                    pullRequests: closedPullRequests,
                    emptyText: ""
                )
            }
        }
    }

    private var summaryLine: some View {
        HStack(spacing: 6) {
            summaryChip(
                count: openPullRequests.count,
                label: String(localized: "tasks.sidebar.section.pullRequests.summary.open",
                              defaultValue: "open",
                              table: "TermLoop"),
                color: .green
            )
            if !mergedPullRequests.isEmpty {
                summaryChip(
                    count: mergedPullRequests.count,
                    label: String(localized: "tasks.sidebar.section.pullRequests.summary.merged",
                                  defaultValue: "merged",
                                  table: "TermLoop"),
                    color: .purple
                )
            }
            if !closedPullRequests.isEmpty {
                summaryChip(
                    count: closedPullRequests.count,
                    label: String(localized: "tasks.sidebar.section.pullRequests.summary.closed",
                                  defaultValue: "closed",
                                  table: "TermLoop"),
                    color: .secondary
                )
            }
            Spacer(minLength: 0)
        }
    }

    private func summaryChip(count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text("\(count) \(label)")
                .lineLimit(1)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(color)
        .padding(.vertical, 2)
        .padding(.horizontal, 6)
        .background(color.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }

    private func prGroup(title: String, pullRequests: [SidebarPullRequestState], emptyText: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary.opacity(0.85))
                Text("\(pullRequests.count)")
                    .font(.system(size: 9, weight: .semibold, design: .monospaced))
                    .foregroundColor(.secondary)
                    .padding(.vertical, 1)
                    .padding(.horizontal, 5)
                    .background(Color.white.opacity(0.045))
                    .clipShape(Capsule())
            }
            if pullRequests.isEmpty {
                TaskSidebarEmptyText(emptyText)
            } else {
                ForEach(pullRequests, id: \.url) { pullRequest in
                    prRow(pullRequest)
                }
            }
        }
    }

    private func prRow(_ pullRequest: SidebarPullRequestState) -> some View {
        Button {
            WorktreeURLRouter.open(
                pullRequest.url,
                workspaceIds: workspaceId.map { [$0] } ?? [],
                preferredWorkspaceId: workspaceId
            )
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor(pullRequest.status))
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(pullRequest.label) #\(pullRequest.number)")
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                    Text(detailLine(for: pullRequest))
                        .font(.system(size: 10))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(pullRequest.url.absoluteString)
    }

    private var normalizedWorktreePath: String? {
        guard let worktreePath else { return nil }
        return TaskPathNormalization.resolveDisplayAndKey(worktreePath)?.displayPath
    }

    private var normalizedBranch: String? {
        guard let branch else { return nil }
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func ensureLookup() {
        guard let path = normalizedWorktreePath, let branch = normalizedBranch else { return }
        pullRequestStore.ensureLookup(directory: path, branch: branch, reason: "tasks.sidebar")
    }

    private func detailLine(for pullRequest: SidebarPullRequestState) -> String {
        let base = pullRequest.baseBranch.map { " → \($0)" } ?? ""
        let staleText = String(localized: "tasks.sidebar.section.pullRequests.stale",
                               defaultValue: "stale",
                               table: "TermLoop")
        let stale = pullRequest.isStale ? " · \(staleText)" : ""
        return "\(pullRequest.displayStatus)\(base)\(stale)"
    }

    private func statusColor(_ status: SidebarPullRequestStatus) -> Color {
        switch status {
        case .open: return .green
        case .merged: return .purple
        case .closed: return .secondary
        }
    }
}
