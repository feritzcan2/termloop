// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
struct AgentSessionSummary: Identifiable, Equatable {
    enum Kind: Equatable {
        case worktree
        case workspace
        case projectRoot
    }

    let id: String
    let kind: Kind
    let projectId: UUID?
    let branch: String?
    let repoRootPath: String?
    let workspaceIds: [UUID]
    let title: String
    let memberTitles: [String]

    var workspaceCount: Int { workspaceIds.count }
    var isWorktreeBacked: Bool { kind == .worktree }
    var isShared: Bool { workspaceIds.count > 1 }

    var repoName: String {
        guard let repoRootPath else { return "Project" }
        return URL(fileURLWithPath: repoRootPath).lastPathComponent
    }
}

struct AgentSessionSummaryIndex {
    let summaries: [AgentSessionSummary]
    let summaryByWorkspaceId: [UUID: AgentSessionSummary]
    let summaryById: [String: AgentSessionSummary]

    func summary(workspaceId: UUID?, repoRootPath: String) -> AgentSessionSummary {
        if let workspaceId,
           let summary = summaryByWorkspaceId[workspaceId] {
            return summary
        }

        let repoName = URL(fileURLWithPath: repoRootPath).lastPathComponent
        return AgentSessionSummary(
            id: "project:\(repoRootPath)",
            kind: .projectRoot,
            projectId: nil,
            branch: nil,
            repoRootPath: repoRootPath,
            workspaceIds: [],
            title: repoName,
            memberTitles: []
        )
    }
}

private struct AgentSessionAccumulator {
    let id: String
    let kind: AgentSessionSummary.Kind
    let projectId: UUID?
    let branch: String?
    let repoRootPath: String?
    var workspaceIds: [UUID]
    var memberTitles: [String]
}

@MainActor
extension WorkspaceMetadataStore {
    func agentSessionSummaryIndex(workspaces: [Workspace]) -> AgentSessionSummaryIndex {
        var grouped: [String: AgentSessionAccumulator] = [:]
        var order: [String] = []

        for workspace in workspaces {
            let meta = metadata(for: workspace)
            let normalizedBranch = normalizedBranch(meta.branch)
            let projectId = meta.projectId
            let repoRootPath = resolvedRepoRootPath(for: workspace, projectId: projectId)
            let displayTitle = workspaceDisplayTitle(workspace)

            let key: String
            let kind: AgentSessionSummary.Kind
            if let projectId, let normalizedBranch {
                key = "worktree:\(projectId.uuidString):\(normalizedBranch.lowercased())"
                kind = .worktree
            } else {
                key = "workspace:\(workspace.id.uuidString)"
                kind = .workspace
            }

            if grouped[key] == nil {
                grouped[key] = AgentSessionAccumulator(
                    id: key,
                    kind: kind,
                    projectId: projectId,
                    branch: normalizedBranch,
                    repoRootPath: repoRootPath,
                    workspaceIds: [workspace.id],
                    memberTitles: [displayTitle]
                )
                order.append(key)
            } else {
                grouped[key]?.workspaceIds.append(workspace.id)
                grouped[key]?.memberTitles.append(displayTitle)
            }
        }

        let summaries: [AgentSessionSummary] = order.compactMap { key -> AgentSessionSummary? in
            guard let item = grouped[key] else { return nil }
            return AgentSessionSummary(
                id: item.id,
                kind: item.kind,
                projectId: item.projectId,
                branch: item.branch,
                repoRootPath: item.repoRootPath,
                workspaceIds: item.workspaceIds,
                title: title(for: item),
                memberTitles: item.memberTitles
            )
        }

        var summaryByWorkspaceId: [UUID: AgentSessionSummary] = [:]
        var summaryById: [String: AgentSessionSummary] = [:]
        for summary in summaries {
            summaryById[summary.id] = summary
            for workspaceId in summary.workspaceIds {
                summaryByWorkspaceId[workspaceId] = summary
            }
        }

        return AgentSessionSummaryIndex(
            summaries: summaries,
            summaryByWorkspaceId: summaryByWorkspaceId,
            summaryById: summaryById
        )
    }

    func agentSessionSummaries(workspaces: [Workspace]) -> [AgentSessionSummary] {
        agentSessionSummaryIndex(workspaces: workspaces).summaries
    }

    func agentSessionSummary(workspaceId: UUID?, repoRootPath: String) -> AgentSessionSummary {
        if let workspaceId,
           let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) {
            return agentSessionSummary(for: workspace)
        }

        let repoName = URL(fileURLWithPath: repoRootPath).lastPathComponent
        return AgentSessionSummary(
            id: "project:\(repoRootPath)",
            kind: .projectRoot,
            projectId: nil,
            branch: nil,
            repoRootPath: repoRootPath,
            workspaceIds: [],
            title: repoName,
            memberTitles: []
        )
    }

    func agentSessionSummary(for workspace: Workspace) -> AgentSessionSummary {
        agentSessionSummaryIndex(workspaces: AppDelegate.shared?.tabManager?.tabs ?? [workspace])
            .summaryByWorkspaceId[workspace.id]
            ?? AgentSessionSummary(
                id: "workspace:\(workspace.id.uuidString)",
                kind: .workspace,
                projectId: metadata(for: workspace).projectId,
                branch: normalizedBranch(metadata(for: workspace).branch),
                repoRootPath: resolvedRepoRootPath(
                    for: workspace,
                    projectId: metadata(for: workspace).projectId
                ),
                workspaceIds: [workspace.id],
                title: workspaceDisplayTitle(workspace),
                memberTitles: [workspaceDisplayTitle(workspace)]
            )
    }

    private func title(for item: AgentSessionAccumulator) -> String {
        if item.memberTitles.count == 1, let only = item.memberTitles.first, !only.isEmpty {
            return only
        }
        if let branch = item.branch, !branch.isEmpty {
            return branch
        }
        if let repoRootPath = item.repoRootPath {
            return URL(fileURLWithPath: repoRootPath).lastPathComponent
        }
        return "Session"
    }

    private func workspaceDisplayTitle(_ workspace: Workspace) -> String {
        let custom = workspace.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return custom.isEmpty ? workspace.title : custom
    }

    private func normalizedBranch(_ branch: String?) -> String? {
        let trimmed = branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private func resolvedRepoRootPath(for workspace: Workspace, projectId: UUID?) -> String? {
        if let projectId,
           let path = ProjectStore.shared.project(id: projectId)?.folderPath,
           !path.isEmpty {
            return path
        }
        let cwd = workspace.currentDirectory.trimmingCharacters(in: .whitespacesAndNewlines)
        return cwd.isEmpty ? nil : cwd
    }
}
