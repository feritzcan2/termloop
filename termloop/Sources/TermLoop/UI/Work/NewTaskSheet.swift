// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct NewTaskSheet: View {
    let projectId: UUID
    let onCreated: (TermLoopTask) -> Void
    let onCancel: () -> Void

    @EnvironmentObject var tabManager: TabManager

    @State private var title = ""
    @State private var branchMode: Mode = .new
    @State private var branchName = ""
    @State private var baseBranch = "main"
    @State private var externalLinkText = ""
    @State private var helperAgentId: String? = nil
    @State private var workspaceTerminalAgentId: String? = nil
    @State private var errorText: String?

    enum Mode: String, CaseIterable, Identifiable {
        case new, existing
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Task").font(.title3).bold()

            field(label: "Title *") {
                TextField("Add org switcher", text: $title)
            }

            field(label: "Branch *") {
                Picker("", selection: $branchMode) {
                    Text("new branch").tag(Mode.new)
                    Text("existing").tag(Mode.existing)
                }
                .pickerStyle(.segmented)
            }

            field(label: branchMode == .new ? "New branch name" : "Existing branch") {
                TextField("feat/...", text: $branchName)
                    .font(.system(.body, design: .monospaced))
            }

            if branchMode == .new {
                field(label: "Base") {
                    TextField("main", text: $baseBranch)
                }
            }

            field(label: "External link (optional)") {
                TextField("https://acme.atlassian.net/browse/KEY-1", text: $externalLinkText)
            }

            field(label: "Helper agent (optional)") {
                Picker("", selection: $helperAgentId) {
                    Text("none").tag(String?.none)
                    ForEach(TerminalAgentRegistry.shared.agents, id: \.id) { agent in
                        Text(agent.displayName).tag(Optional(agent.id))
                    }
                }
            }

            if let errorText {
                Text(errorText).foregroundStyle(.red).font(.caption)
            }

            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button("Create") { Task { await create() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid)
            }
        }
        .padding(16)
        .frame(width: 420)
    }

    private var isValid: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty &&
        !branchName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func field<C: View>(label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            content()
        }
    }

    @MainActor
    private func create() async {
        errorText = nil
        let tm = tabManager
        let branchModeLocal = branchMode
        let baseLocal = baseBranch
        let spawner = TaskWorktreeSpawner(tabManager: tm)
        let coord = TaskCreationCoordinator(
            store: .shared,
            projectRootProvider: { pid in
                URL(fileURLWithPath: ProjectStore.shared.projects.first(where: { $0.id == pid })?.folderPath ?? "/")
            },
            prepareWorkspace: { pid, seedTitle, branch, baseRef, createIfMissing, terminalAgentId in
                guard let project = ProjectStore.shared.projects.first(where: { $0.id == pid }) else {
                    throw NSError(domain: "NewTaskSheet", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "project not found"])
                }
                let result = try spawner.spawn(
                    project: project,
                    title: seedTitle,
                    branch: branch,
                    baseRef: baseRef,
                    createIfMissing: createIfMissing,
                    terminalAgentId: terminalAgentId
                )
                return TaskCreationCoordinator.PreparedWorkspace(
                    workspaceId: result.workspaceId,
                    worktreePath: result.worktreePath,
                    createdWorktree: result.createdWorktree
                )
            },
            rollbackWorkspace: { pid, prepared in
                guard let project = ProjectStore.shared.projects.first(where: { $0.id == pid }) else {
                    if let ws = tm.tabs.first(where: { $0.id == prepared.workspaceId }) {
                        tm.closeWorkspace(ws)
                    }
                    return
                }
                spawner.rollback(
                    project: project,
                    result: TaskWorktreeSpawner.SpawnResult(
                        workspaceId: prepared.workspaceId,
                        worktreePath: prepared.worktreePath,
                        createdWorktree: prepared.createdWorktree,
                        createdBranch: false
                    )
                )
            },
            setTaskIdOnWorkspace: { wsId, taskId in
                WorkspaceMetadataStore.shared.setTaskId(taskId, for: wsId)
            },
            dirtyCheck: { pid in
                guard let root = ProjectStore.shared.projects.first(where: { $0.id == pid })?.folderPath
                else { return false }
                return ProcessGitStateProvider().isDirty(projectRoot: root)
            }
        )
        do {
            let task = try await coord.create(input: .init(
                projectId: projectId,
                title: title.trimmingCharacters(in: .whitespaces),
                branchMode: branchModeLocal == .new
                    ? .new(name: branchName, base: baseLocal)
                    : .existing(name: branchName),
                externalLinkURL: externalLinkText.isEmpty ? nil : externalLinkText,
                helperAgentId: helperAgentId,
                terminalAgentId: workspaceTerminalAgentId
            ))
            onCreated(task)
        } catch {
            errorText = error.localizedDescription
        }
    }
}
