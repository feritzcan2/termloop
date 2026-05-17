// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

struct LocalSetupMenuRunTarget: Identifiable, Equatable {
    let id: String
    let projectId: UUID?
    let worktreePath: String
    let label: String

    init(projectId: UUID?, worktreePath: String, label: String) {
        self.projectId = projectId
        self.worktreePath = worktreePath
        self.label = label
        self.id = "\(projectId?.uuidString ?? "unknown")|\(worktreePath)"
    }
}

struct LocalSetupMenuItems: View {
    let projectId: UUID?
    let runTargets: [LocalSetupMenuRunTarget]
    var directRunLabel: String = String(
        localized: "worktreeSetup.menu.run",
        defaultValue: "Run Local Setup",
        table: "TermLoop"
    )

    var body: some View {
        Button {
            LocalSetupActions.showHelp()
        } label: {
            Label(
                String(localized: "worktreeSetup.menu.help", defaultValue: "What is Local Setup?", table: "TermLoop"),
                systemImage: "questionmark.circle"
            )
        }

        Divider()

        Button {
            LocalSetupActions.openGenerator(projectId: projectId)
        } label: {
            Label(
                String(localized: "worktreeSetup.menu.generate", defaultValue: "Generate Local Setup with Agent…", table: "TermLoop"),
                systemImage: "sparkles"
            )
        }
        .disabled(projectId == nil)

        Button {
            LocalSetupActions.openConfig(projectId: projectId)
        } label: {
            Label(
                String(localized: "worktreeSetup.menu.configure", defaultValue: "Configure Local Setup…", table: "TermLoop"),
                systemImage: "doc.text"
            )
        }
        .disabled(projectId == nil)

        if !runTargets.isEmpty {
            Divider()
            if runTargets.count == 1, let target = runTargets.first {
                runButton(target: target, label: directRunLabel)
            } else {
                Menu {
                    ForEach(runTargets) { target in
                        runButton(target: target, label: target.label)
                    }
                } label: {
                    Label(
                        String(localized: "worktreeSetup.menu.runForWorktree", defaultValue: "Run Local Setup", table: "TermLoop"),
                        systemImage: "wrench.and.screwdriver"
                    )
                }
            }
        }
    }

    private func runButton(target: LocalSetupMenuRunTarget, label: String) -> some View {
        Button {
            LocalSetupActions.run(projectId: target.projectId ?? projectId, worktreePath: target.worktreePath, force: true)
        } label: {
            Label(label, systemImage: "wrench.and.screwdriver")
        }
        .disabled((target.projectId ?? projectId) == nil || isRunning(target: target))
    }

    private func isRunning(target: LocalSetupMenuRunTarget) -> Bool {
        guard let resolvedProjectId = target.projectId ?? projectId else { return false }
        return WorktreeSetupCoordinator.shared.visibleStatus(
            projectId: resolvedProjectId,
            worktreePath: target.worktreePath
        )?.phase == .running
    }
}

struct LocalSetupWorktreeMenuItems: View {
    let projectId: UUID?
    let worktreePath: String?

    var body: some View {
        LocalSetupMenuItems(
            projectId: projectId,
            runTargets: worktreePath.map {
                [LocalSetupMenuRunTarget(projectId: projectId, worktreePath: $0, label: $0)]
            } ?? []
        )
    }
}
