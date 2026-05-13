// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionWorkspaceTargetPill: View {
    @ObservedObject var viewModel: QuickActionViewModel
    @ObservedObject private var worktreeProjectionStore = WorktreeProjectionStore.shared

    var body: some View {
        HStack(spacing: 6) {
            Text(contextLabel)
                .font(.caption)
                .foregroundColor(.secondary)

            if viewModel.launchSource.usesSourceWorkspaceLaunch {
                readOnlySourceChip
            } else {
                runTargetMenu
            }

            if let path = detailPath {
                Text("·")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Image(systemName: "folder")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Text(path)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 260, alignment: .leading)
                    .help(path)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var contextLabel: String {
        if viewModel.launchSource.usesSourceWorkspaceLaunch {
            return String(
                localized: "quickAction.continuingFrom",
                defaultValue: "Continuing from:",
                table: "TermLoop"
            )
        }
        return String(
            localized: "quickAction.runIn",
            defaultValue: "Run in:",
            table: "TermLoop"
        )
    }

    private var readOnlySourceChip: some View {
        HStack(spacing: 4) {
            Text(sourceSessionLabel)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
        }
        .foregroundColor(.primary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var runTargetMenu: some View {
        Menu {
            if let project = menuProject {
                Button(projectRootLabel(project)) {
                    viewModel.runTarget = .projectRoot(project.id)
                }

                let rows = worktreeRows(for: project)
                if rows.isEmpty {
                    Text(String(
                        localized: "quickAction.noProjectWorktrees",
                        defaultValue: "No worktrees in this project yet",
                        table: "TermLoop"
                    ))
                } else {
                    Section(String(localized: "quickAction.worktrees",
                                   defaultValue: "Worktrees",
                                   table: "TermLoop")) {
                        ForEach(rows) { row in
                            Button(row.title) {
                                viewModel.runTarget = row.target
                            }
                        }
                    }
                }
            }

            Divider()
            Button(String(localized: "quickAction.detach",
                          defaultValue: "Detach",
                          table: "TermLoop")) {
                viewModel.runTarget = .detached
            }
        } label: {
            HStack(spacing: 4) {
                Text(currentRunTargetLabel)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .foregroundColor(.primary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .menuStyle(.borderlessButton)
    }

    private struct WorktreeRow: Identifiable {
        let id: String
        let title: String
        let target: QuickActionRunTarget
    }

    private var menuProject: Project? {
        if let projectId = viewModel.runTarget.projectId,
           let project = ProjectStore.shared.project(id: projectId) {
            return project
        }
        return ProjectStore.shared.activeProject
    }

    private func worktreeRows(for project: Project) -> [WorktreeRow] {
        let tabs = AppDelegate.shared?.tabManager?.tabs ?? []
        let snapshot = worktreeProjectionStore.snapshot(
            project: project,
            workspaces: tabs
        )
        return snapshot.entries
            .filter { !$0.isMain }
            .map { entry in
                let title = Self.worktreeTitle(path: entry.path, branch: entry.branch)
                let workspaceId = entry.workspaceIds.first { AppDelegate.shared?.workspaceFor(tabId: $0) != nil }
                    ?? entry.workspaceIds.first
                return WorktreeRow(
                    id: entry.pathKey,
                    title: title,
                    target: .worktree(
                        projectId: project.id,
                        path: entry.path,
                        branch: entry.branch,
                        workspaceId: workspaceId
                    )
                )
            }
            .sorted {
                $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
    }

    private var currentRunTargetLabel: String {
        switch viewModel.runTarget {
        case .projectRoot(let projectId):
            if let project = ProjectStore.shared.project(id: projectId) {
                return projectRootLabel(project)
            }
            return String(localized: "quickAction.projectRoot",
                          defaultValue: "Project root",
                          table: "TermLoop")
        case .worktree(_, let path, let branch, _):
            return Self.worktreeTitle(path: path, branch: branch)
        case .detached:
            return String(localized: "quickAction.detach",
                          defaultValue: "Detach",
                          table: "TermLoop")
        }
    }

    private var sourceSessionLabel: String {
        guard let workspaceId = viewModel.sourceSessionId,
              let workspace = AppDelegate.shared?.workspaceFor(tabId: workspaceId) else {
            return String(localized: "quickAction.sourceAgent.missing",
                          defaultValue: "Agent session",
                          table: "TermLoop")
        }
        let metadata = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: workspaceId)
        let agentId = TerminalAgentActivityStore.shared.presentation(forWorkspaceId: workspaceId)?.agentId
            ?? metadata.terminalAgentId
            ?? metadata.persistedAgentSession?.agentId
        let agentName = TerminalAgentDisplayFormatter.agentDisplayLabel(
            agentId: agentId,
            fallback: Self.workspaceDisplayName(workspace)
        )
        if let branch = WorkspaceMetadataStore.shared.branch(for: workspace)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty {
            return "\(agentName) · \(branch)"
        }
        return agentName
    }

    static func workspaceDisplayName(_ ws: Workspace) -> String {
        let custom = ws.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
        if !custom.isEmpty { return custom }
        return ws.title.isEmpty ? String(ws.id.uuidString.prefix(8)) : ws.title
    }

    private static func worktreeTitle(path: String, branch: String?) -> String {
        branch?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? URL(fileURLWithPath: path).lastPathComponent
    }

    private func projectRootLabel(_ project: Project) -> String {
        String(localized: "quickAction.projectRoot.named",
               defaultValue: "\(project.name) · project root",
               table: "TermLoop")
    }

    private var detailPath: String? {
        if viewModel.launchSource.usesSourceWorkspaceLaunch,
           let sourceSessionId = viewModel.sourceSessionId,
           let workspace = AppDelegate.shared?.workspaceFor(tabId: sourceSessionId) {
            return formatPath(workspace.termLoopPresentationCwd())
        }
        return formatPath(viewModel.resolvedRunCwdForPreview())
    }

    private func formatPath(_ rawPath: String?) -> String? {
        let homePath = FileManager.default.homeDirectoryForCurrentUser.path
        guard var p = rawPath else { return nil }
        if p.hasPrefix(homePath) {
            p = "~" + p.dropFirst(homePath.count)
        }
        return p
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
