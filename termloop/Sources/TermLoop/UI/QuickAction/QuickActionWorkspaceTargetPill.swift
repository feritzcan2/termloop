// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct QuickActionWorkspaceTargetPill: View {
    @ObservedObject var viewModel: QuickActionViewModel
    @State private var resolvedCwd: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(contextLabel)
                .font(.caption)
                .foregroundColor(.secondary)
            Menu {
                let groups = Self.projectWorkspaceGroups()
                if groups.isEmpty {
                    Text(String(
                        localized: "quickAction.noProjectWorkspaces",
                        defaultValue: "No workspaces in active project",
                        table: "TermLoop"
                    ))
                } else {
                    ForEach(groups, id: \.id) { group in
                        Section(group.title) {
                            ForEach(group.workspaces, id: \.id) { ws in
                                Button(Self.workspaceDisplayName(ws)) {
                                    viewModel.targetWorkspaceId = ws.id
                                }
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(currentTargetLabel())
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
            if let cwd = resolvedCwd {
                Text("·")
                    .font(.caption)
                    .foregroundColor(.secondary)
                Image(systemName: "folder")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Text(cwd)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 260, alignment: .leading)
                    .help(cwd)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { resolvedCwd = effectiveCwdDisplay() }
        .onChange(of: viewModel.targetWorkspaceId) { _, _ in
            resolvedCwd = effectiveCwdDisplay()
        }
    }

    private var contextLabel: String {
        if viewModel.launchSource.isForkLike {
            return String(
                localized: "quickAction.source",
                defaultValue: "Source:",
                table: "TermLoop"
            )
        }
        return String(
            localized: "quickAction.target",
            defaultValue: "Target:",
            table: "TermLoop"
        )
    }

    struct ProjectWorkspaceGroup {
        let id: String
        let title: String
        let workspaces: [Workspace]
    }

    static func projectWorkspaceGroups() -> [ProjectWorkspaceGroup] {
        guard let projectId = ProjectStore.shared.activeProjectId,
              let tabs = AppDelegate.shared?.tabManager?.tabs else {
            return []
        }
        let projectTabs = tabs.filter { $0.projectId == projectId }
        guard !projectTabs.isEmpty else { return [] }
        return [
            ProjectWorkspaceGroup(
                id: "all",
                title: String(
                    localized: "quickAction.workspaces",
                    defaultValue: "Workspaces",
                    table: "TermLoop"
                ),
                workspaces: projectTabs.sorted(by: workspaceSortOrder)
            )
        ]
    }

    static func workspaceSortOrder(_ a: Workspace, _ b: Workspace) -> Bool {
        workspaceDisplayName(a).localizedCaseInsensitiveCompare(workspaceDisplayName(b)) == .orderedAscending
    }

    static func workspaceDisplayName(_ ws: Workspace) -> String {
        let custom = ws.customTitle?.trimmingCharacters(in: .whitespaces) ?? ""
        if !custom.isEmpty { return custom }
        return ws.title.isEmpty ? String(ws.id.uuidString.prefix(8)) : ws.title
    }

    private func currentTargetLabel() -> String {
        if let id = viewModel.targetWorkspaceId,
           let ws = AppDelegate.shared?.workspaceFor(tabId: id) {
            return Self.workspaceDisplayName(ws)
        }
        return String(
            localized: "quickAction.detach",
            defaultValue: "Detach",
            table: "TermLoop"
        )
    }

    private func effectiveCwdDisplay() -> String? {
        let homePath = FileManager.default.homeDirectoryForCurrentUser.path
        let path: String?
        if let wsId = viewModel.targetWorkspaceId,
           let ws = AppDelegate.shared?.workspaceFor(tabId: wsId) {
            var resolved: String?
            resolved = ws.termLoopPresentationCwd()
            if resolved == nil || resolved == homePath {
                let meta = WorkspaceMetadataStore.shared.metadata(forWorkspaceId: ws.id)
                if let pid = meta.projectId,
                   let proj = ProjectStore.shared.projects.first(where: { $0.id == pid }) {
                    resolved = (proj.folderPath as NSString).expandingTildeInPath
                } else if let active = ProjectStore.shared.activeProject {
                    resolved = (active.folderPath as NSString).expandingTildeInPath
                }
            }
            path = resolved
        } else if let active = ProjectStore.shared.activeProject {
            path = (active.folderPath as NSString).expandingTildeInPath
        } else {
            path = nil
        }
        guard var p = path else { return nil }
        if p.hasPrefix(homePath) {
            p = "~" + p.dropFirst(homePath.count)
        }
        return p
    }
}
