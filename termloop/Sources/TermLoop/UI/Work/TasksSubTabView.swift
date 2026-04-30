// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct TasksSubTabView: View {
    let projectId: UUID
    let onNewTask: () -> Void
    @EnvironmentObject var tabManager: TabManager
    @ObservedObject var store: TaskStore = .shared
    @State private var selectedTaskId: UUID?
    @State private var visibilityToken: UUID?
    @State private var deleteCandidate: TermLoopTask?

    var body: some View {
        let tasks = store.tasks(for: projectId)
            .sorted { $0.updatedAt > $1.updatedAt }

        VStack(spacing: 0) {
            header
            Group {
                if tasks.isEmpty { emptyState } else { listBody(tasks: tasks) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TaskScratchpadRouter())
        .onAppear {
            visibilityToken = TaskSyncViewRegistry.shared.register(projectId: projectId)
        }
        .onDisappear {
            if let token = visibilityToken {
                TaskSyncViewRegistry.shared.unregister(projectId: projectId, token: token)
                visibilityToken = nil
            }
        }
        .sheet(item: $deleteCandidate) { t in
            DeleteTaskDialog(
                task: t,
                onConfirm: { opts in
                    Task { @MainActor in
                        await performDelete(task: t, options: opts)
                    }
                    deleteCandidate = nil
                },
                onCancel: { deleteCandidate = nil }
            )
        }
    }

    @MainActor
    private func performDelete(task: TermLoopTask, options: TaskDeletionCoordinator.Options) async {
        let tm = tabManager
        let coord = TaskDeletionCoordinator(
            store: .shared,
            detachWorktree: { taskId in
                guard let ws = tm.tabs.first(where: {
                    WorkspaceMetadataStore.shared.taskId(for: $0.id) == taskId
                }) else { return }
                _ = try WorktreeCoordinator.shared.detach(workspace: ws, prune: .auto)
            },
            deleteBranch: { pid, b in
                let root = ProjectStore.shared.projects.first(where: { $0.id == pid })?.folderPath ?? "/"
                _ = try? ProcessGitStateProvider().runRaw(["branch", "-D", b], cwd: root)
            },
            snapshotBoundWorkspaces: { taskId in
                tm.tabs.compactMap {
                    WorkspaceMetadataStore.shared.taskId(for: $0.id) == taskId ? $0.id : nil
                }
            },
            setTaskIdOnWorkspace: { wsId, taskId in
                WorkspaceMetadataStore.shared.setTaskId(taskId, for: wsId)
            },
            projectRootProvider: { pid in
                URL(fileURLWithPath: ProjectStore.shared.projects.first(where: { $0.id == pid })?.folderPath ?? "/")
            }
        )
        try? await coord.delete(task: task, options: options)
    }


    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(String(
                    localized: "sidebar.workSubTab.tasks",
                    defaultValue: "Tasks",
                    table: "TermLoop"
                ))
                .font(TermLoopSidebarTheme.headerLabel)
                .foregroundStyle(Color.primary)

                Spacer(minLength: 0)

                Button(action: onNewTask) {
                    Label(
                        String(
                            localized: "sidebar.workSubTab.tasks.new.help",
                            defaultValue: "New task",
                            table: "TermLoop"
                        ),
                        systemImage: "plus"
                    )
                    .font(TermLoopSidebarTheme.tinyMono)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        Capsule()
                            .fill(TermLoopSidebarTheme.activeBg)
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(TermLoopSidebarTheme.accent.opacity(0.24), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .help(String(
                    localized: "sidebar.workSubTab.tasks.new.help",
                    defaultValue: "New task",
                    table: "TermLoop"
                ))
            }
            .padding(.horizontal, TermLoopSidebarTheme.rowInsetH)
            .padding(.top, 10)
            .padding(.bottom, 10)

            TermLoopSidebarRule()
        }
    }

    @ViewBuilder
    private func listBody(tasks: [TermLoopTask]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(tasks) { task in
                    VStack(spacing: 0) {
                        TaskRowView(
                            task: task,
                            workspaceCount: workspaceCount(for: task.id),
                            isSelected: selectedTaskId == task.id,
                            onTap: {
                                selectedTaskId = (selectedTaskId == task.id) ? nil : task.id
                            }
                        )
                        if selectedTaskId == task.id {
                            TaskDetailInlineView(
                                task: task,
                                workspaces: workspaces(for: task.id),
                                onOpenScratchpad: { openScratchpad(task) },
                                onNewWorkspace: { newWorkspace(task) },
                                onDelete: { deleteCandidate = task },
                                onRefresh: {
                                    Task { @MainActor in
                                        TaskSyncRegistry.shared.refreshNow(projectId: projectId)
                                    }
                                },
                                onOpenWorktreeInFinder: {
                                    NSWorkspace.shared.activateFileViewerSelecting([
                                        URL(fileURLWithPath: task.worktreePath)
                                    ])
                                }
                            )
                        }
                        Divider()
                    }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text(String(
                localized: "tasks.empty.title",
                defaultValue: "No tasks yet.",
                table: "TermLoop"
            ))
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text(String(
                localized: "tasks.empty.subtitle",
                defaultValue: "+ New task — creates a new branch + worktree",
                table: "TermLoop"
            ))
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 40)
    }

    private func workspaces(for taskId: UUID) -> [Workspace] {
        tabManager.tabs.filter {
            WorkspaceMetadataStore.shared.taskId(for: $0.id) == taskId
        }
    }

    private func workspaceCount(for taskId: UUID) -> Int {
        workspaces(for: taskId).count
    }

    private func openScratchpad(_ task: TermLoopTask) {
        let root = ProjectStore.shared.projects.first(where: { $0.id == task.projectId })
            .map { URL(fileURLWithPath: $0.folderPath) }
        guard let root else { return }
        let path = root.appendingPathComponent(".termloop/tasks/\(task.id.uuidString)/scratchpad.md")
        NotificationCenter.default.post(
            name: .termLoopOpenFileInMainPanel,
            object: nil, userInfo: ["path": path]
        )
    }

    private func newWorkspace(_ task: TermLoopTask) {
        _ = tabManager.addWorkspace(
            title: task.title,
            workingDirectory: task.worktreePath,
            projectId: task.projectId,
            taskId: task.id,
            terminalAgentId: nil
        )
    }
}

extension Notification.Name {
    static let termLoopOpenFileInMainPanel = Notification.Name("termLoopOpenFileInMainPanel")
}
