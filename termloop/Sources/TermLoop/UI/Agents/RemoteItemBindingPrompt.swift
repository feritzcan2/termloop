// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

@MainActor
enum RemoteItemBindingPrompt {
    static func present(forWorkspaceId workspaceId: UUID) {
        let fallbackPath = AppDelegate.shared?
            .workspaceFor(tabId: workspaceId)?
            .termLoopPresentationCwd()
        guard let path = WorkspaceMetadataStore.shared
            .reportedStatePath(forWorkspaceId: workspaceId, fallbackPath: fallbackPath) else {
            presentNoWorktreeError()
            return
        }
        present(forWorktreePath: path, workspaceIds: [workspaceId])
    }

    static func present(forGroupWorkspaces workspaces: [Workspace]) {
        let metadata = WorkspaceMetadataStore.shared
        let resolvedPath = workspaces
            .lazy
            .compactMap {
                metadata.reportedStatePath(
                    forWorkspaceId: $0.id,
                    fallbackPath: $0.termLoopPresentationCwd()
                )
            }
            .first
        guard let resolvedPath else {
            presentNoWorktreeError()
            return
        }
        present(forWorktreePath: resolvedPath, workspaceIds: workspaces.map(\.id))
    }

    private static func present(forWorktreePath path: String, workspaceIds: [UUID]) {
        let store = WorktreeRemoteItemBindingStore.shared
        let prior = store.binding(forPath: path)

        let alert = NSAlert()
        alert.messageText = String(
            localized: "remoteItem.binding.prompt.title",
            defaultValue: "Set Remote Item",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "remoteItem.binding.prompt.body",
            defaultValue: "Paste a Jira key/URL, GitHub issue URL, GitLab issue URL, or owner/repo#number. Only user actions can bind a remote item to a worktree.",
            table: "TermLoop"
        )
        alert.alertStyle = .informational

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false

        let input = NSTextField(string: priorInput(prior))
        input.placeholderString = "UKIE-123 or https://host/browse/UKIE-123"
        input.translatesAutoresizingMaskIntoConstraints = false
        input.font = .systemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(input)
        input.widthAnchor.constraint(equalToConstant: 390).isActive = true

        if let prior {
            let snapshot = RemoteWorkItemSnapshotStore.shared.snapshot(for: prior.reference)
            let current = snapshot?.title.nilIfEmpty ?? prior.reference.key
            let label = NSTextField(labelWithString: String(
                localized: "remoteItem.binding.prompt.current",
                defaultValue: "Currently bound: \(current)",
                table: "TermLoop"
            ))
            label.textColor = .secondaryLabelColor
            label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            stack.addArrangedSubview(label)
        }

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 390, height: prior == nil ? 30 : 52))
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: 390)
        ])
        alert.accessoryView = container

        alert.addButton(withTitle: String(
            localized: "remoteItem.binding.prompt.save",
            defaultValue: "Save",
            table: "TermLoop"
        ))
        if prior != nil {
            alert.addButton(withTitle: String(
                localized: "remoteItem.binding.prompt.clear",
                defaultValue: "Clear",
                table: "TermLoop"
            ))
        }
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        alert.window.initialFirstResponder = input
        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            handleSave(rawInput: input.stringValue, workspaceIds: workspaceIds, worktreePath: path)
        case .alertSecondButtonReturn where prior != nil:
            store.clear(forPath: path)
        default:
            return
        }
    }

    private static func handleSave(rawInput: String, workspaceIds: [UUID], worktreePath: String) {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            presentError(String(
                localized: "remoteItem.binding.error.empty",
                defaultValue: "Enter a remote item key or URL.",
                table: "TermLoop"
            ))
            return
        }
        guard let reference = RemoteWorkItemParser.parse(trimmed) else {
            presentError(String(
                localized: "remoteItem.binding.error.unparsable",
                defaultValue: "Couldn't find a supported remote item in that input.",
                table: "TermLoop"
            ))
            return
        }
        WorktreeRemoteItemBindingStore.shared.bind(reference, forPath: worktreePath)
        guard let firstId = workspaceIds.first else { return }
        RemoteWorkItemBindingRefreshCoordinator.shared.refresh(
            inputs: [
                RemoteWorkItemBindingRefreshCoordinator.Input(
                    workspaceId: firstId,
                    worktreePath: worktreePath,
                    reference: reference
                )
            ],
            reason: "manualRemoteWorkItemLink"
        )
    }

    private static func priorInput(_ prior: WorktreeRemoteItemBindingStore.Binding?) -> String {
        guard let reference = prior?.reference else { return "" }
        return reference.url?.nilIfEmpty ?? reference.key
    }

    private static func presentNoWorktreeError() {
        presentError(String(
            localized: "remoteItem.binding.error.noWorktree",
            defaultValue: "This workspace has no worktree root, so a remote item can't be bound.",
            table: "TermLoop"
        ))
    }

    private static func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "remoteItem.binding.error.title",
            defaultValue: "Remote Item",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }
}

private extension String {
    var nilIfEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
