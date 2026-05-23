// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

@MainActor
enum LocalSetupActions {
    static func showHelp() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = String(
            localized: "worktreeSetup.help.title",
            defaultValue: "What is Local Setup?",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "worktreeSetup.help.body",
            defaultValue: "Local Setup runs project-level preparation once per worktree before dev servers or tests need it. Use it for copied ignored files, local config files, folders, or install/build commands that every branch worktree needs. It is separate from a dev server profile setup command, which is only for one specific run profile.",
            table: "TermLoop"
        )
        alert.addButton(withTitle: String(
            localized: "common.ok",
            defaultValue: "OK",
            table: "TermLoop"
        ))
        alert.runModal()
    }

    static func run(projectId: UUID?, worktreePath: String?, force: Bool = true) {
        guard let projectId,
              let worktreePath else {
            NSSound.beep()
            return
        }
        do {
            _ = try WorktreeSetupCoordinator.shared.start(
                projectId: projectId,
                taskId: nil,
                worktreePath: worktreePath,
                force: force,
                reason: "manual"
            )
        } catch {
            NSSound.beep()
        }
    }

    static func skip(projectId: UUID?, worktreePath: String?) {
        guard let projectId,
              let worktreePath else {
            NSSound.beep()
            return
        }
        do {
            try WorktreeSetupCoordinator.shared.skip(projectId: projectId, worktreePath: worktreePath)
        } catch {
            NSSound.beep()
        }
    }

    static func cancel(projectId: UUID?, worktreePath: String?) {
        guard let projectId,
              let worktreePath else {
            NSSound.beep()
            return
        }
        WorktreeSetupCoordinator.shared.cancel(projectId: projectId, worktreePath: worktreePath)
    }

    static func openConfig(projectId: UUID?) {
        guard let projectId else {
            NSSound.beep()
            return
        }
        do {
            let url = try WorktreeSetupCoordinator.shared.openOrCreateConfig(projectId: projectId)
            MarkdownDocumentStore.shared.open(
                fileURL: url,
                folderName: String(
                    localized: "worktreeSetup.config.folderTitle",
                    defaultValue: "LOCAL SETUP",
                    table: "TermLoop"
                ),
                displayTitle: url.lastPathComponent,
                mode: .edit,
                allowEdit: true
            )
        } catch {
            NSSound.beep()
        }
    }

    static func openGenerator(projectId: UUID?) {
        guard let projectId else {
            NSSound.beep()
            return
        }
        QuickActionController.shared.present(
            prefill: QuickActionPresentationRequest(
                initialSurface: .run,
                composition: .template(id: "local-setup-generator"),
                systemPromptDocumentId: "system.template.local-setup-generator",
                advancedTitle: String(
                    localized: "worktreeSetup.agent.workspaceTitle",
                    defaultValue: "Generate local setup",
                    table: "TermLoop"
                ),
                launchSource: .quickAction,
                reasonTag: "worktreeSetup.generator",
                projectId: projectId,
                runTarget: .projectRoot(projectId),
                openAdvanced: true,
                onLaunchedWorkspace: { workspace in
                    WorkspaceMetadataStore.shared.setProjectId(projectId, forWorkspaceId: workspace.id)
                    WorkspaceMetadataStore.shared.setLastUserPromptAt(Date(), forWorkspaceId: workspace.id)
                    TerminalAgentActivityStore.shared.refreshPresentations(forWorkspaceIds: [workspace.id])
                    TermLoopHooks.saveCriticalAgentRestoreStateSync()
                }
            )
        )
    }
}
