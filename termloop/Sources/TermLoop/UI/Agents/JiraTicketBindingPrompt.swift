// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import Foundation

/// Manual user-side counterpart to the `set_jira_ticket` MCP tool. Lets the
/// user paste a Jira URL (or just a key) on a worktree row without waiting
/// for an agent to call the MCP tool. Storage is the same path-keyed
/// `AgentReportedStateStore`, so the chip and `get_jira_ticket` reads stay
/// consistent regardless of whether the binding was set by an agent or a
/// user click.
@MainActor
enum JiraTicketBindingPrompt {

    static let bindingId = "ticket"

    /// Cached so we don't recompile on every paste-and-save.
    /// Pattern: 1+ uppercase letter project code, dash, 1+ digits.
    private static let keyRegex: NSRegularExpression? = {
        try? NSRegularExpression(pattern: #"\b[A-Z][A-Z0-9_]*-\d+\b"#)
    }()

    /// Whether the Jira ability is enabled for the project that owns this
    /// workspace. Reads `.termloop/abilities/working-with-jira/ability.json`
    /// directly because `AbilityStore.shared` only mirrors the *active*
    /// project, while a sidebar row can belong to any project the user has
    /// open. Same `activation != .off` predicate `TerminalAgentRunner` uses.
    static func isJiraAbilityActive(forWorkspace workspace: Workspace) -> Bool {
        guard let projectId = workspace.projectId else { return false }
        return isJiraAbilityActive(forProjectId: projectId)
    }

    static func isJiraAbilityActive(forGroupWorkspaces workspaces: [Workspace]) -> Bool {
        guard let projectId = workspaces.lazy.compactMap(\.projectId).first else {
            return false
        }
        return isJiraAbilityActive(forProjectId: projectId)
    }

    private static func isJiraAbilityActive(forProjectId projectId: UUID) -> Bool {
        // Fast path: if the active project matches and the in-memory store is
        // already populated, skip disk I/O.
        if ProjectStore.shared.activeProjectId == projectId {
            AbilityStore.shared.start()
            if let inMemory = AbilityStore.shared.abilities.first(where: {
                $0.id == TermLoopBuiltInMCP.jiraAbilityId
            }) {
                return inMemory.activation != .off
            }
        }
        guard let project = ProjectStore.shared.project(id: projectId) else {
            return false
        }
        let bundleDir = URL(fileURLWithPath: project.folderPath, isDirectory: true)
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
            .appendingPathComponent(TermLoopBuiltInMCP.jiraAbilityId, isDirectory: true)
        guard let ability = try? AbilityBundleStore.load(from: bundleDir) else {
            return false
        }
        return ability.activation != .off
    }

    /// Show the prompt for a single workspace. Binding storage is path-keyed
    /// at the worktree root, so calling this for any workspace inside a
    /// worktree updates the chip for every workspace in that worktree.
    static func present(forWorkspaceId workspaceId: UUID) {
        guard let path = WorkspaceMetadataStore.shared
            .worktreeRootPath(forWorkspaceId: workspaceId) else {
            presentNoWorktreeError()
            return
        }
        present(forWorktreePath: path, workspaceIds: [workspaceId])
    }

    /// Show the prompt for a worktree group. Picks any workspace from the
    /// group to resolve the worktree path; persists once and the binding
    /// surfaces for every workspace sharing that worktree.
    static func present(forGroupWorkspaces workspaces: [Workspace]) {
        let metadata = WorkspaceMetadataStore.shared
        let resolvedPath = workspaces
            .lazy
            .compactMap { metadata.worktreeRootPath(forWorkspaceId: $0.id) }
            .first
        guard let resolvedPath else {
            presentNoWorktreeError()
            return
        }
        present(forWorktreePath: resolvedPath, workspaceIds: workspaces.map(\.id))
    }

    private static func present(forWorktreePath path: String, workspaceIds: [UUID]) {
        let prior = AgentReportedStateStore.shared.binding(
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: bindingId,
            forPath: path
        )

        let alert = NSAlert()
        alert.messageText = String(
            localized: "jira.ticketBinding.prompt.title",
            defaultValue: "Set Jira Ticket",
            table: "TermLoop"
        )
        alert.informativeText = String(
            localized: "jira.ticketBinding.prompt.body",
            defaultValue: "Paste a Jira issue URL (or just the key, e.g. PROJ-123). Updates the worktree chip and what get_jira_ticket returns.",
            table: "TermLoop"
        )
        alert.alertStyle = .informational

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false

        let urlField = NSTextField(string: prior?.url ?? "")
        urlField.placeholderString = "https://yourorg.atlassian.net/browse/PROJ-123"
        urlField.translatesAutoresizingMaskIntoConstraints = false
        let statusField = NSTextField(string: prior?.status ?? "")
        statusField.placeholderString = String(
            localized: "jira.ticketBinding.prompt.statusPlaceholder",
            defaultValue: "Status (optional, e.g. In Progress)",
            table: "TermLoop"
        )
        statusField.translatesAutoresizingMaskIntoConstraints = false

        for field in [urlField, statusField] {
            field.font = .systemFont(ofSize: NSFont.systemFontSize)
            stack.addArrangedSubview(field)
            field.widthAnchor.constraint(equalToConstant: 360).isActive = true
        }
        if let prior {
            let priorLabel = NSTextField(labelWithString: String(
                localized: "jira.ticketBinding.prompt.current",
                defaultValue: "Currently bound: \(prior.label)",
                table: "TermLoop"
            ))
            priorLabel.textColor = .secondaryLabelColor
            priorLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
            stack.addArrangedSubview(priorLabel)
        }

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 64))
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: 360)
        ])
        alert.accessoryView = container

        alert.addButton(withTitle: String(
            localized: "jira.ticketBinding.prompt.save",
            defaultValue: "Save",
            table: "TermLoop"
        ))
        if prior != nil {
            alert.addButton(withTitle: String(
                localized: "jira.ticketBinding.prompt.clear",
                defaultValue: "Clear",
                table: "TermLoop"
            ))
        }
        alert.addButton(withTitle: String(
            localized: "common.cancel",
            defaultValue: "Cancel",
            table: "TermLoop"
        ))

        alert.window.initialFirstResponder = urlField
        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            handleSave(
                rawInput: urlField.stringValue,
                rawStatus: statusField.stringValue,
                workspaceIds: workspaceIds
            )
        case .alertSecondButtonReturn where prior != nil:
            handleClear(workspaceIds: workspaceIds)
        default:
            return
        }
    }

    private static func handleSave(
        rawInput: String,
        rawStatus: String,
        workspaceIds: [UUID]
    ) {
        let trimmed = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            presentError(String(
                localized: "jira.ticketBinding.error.empty",
                defaultValue: "Enter a Jira URL or issue key.",
                table: "TermLoop"
            ))
            return
        }
        guard let parsed = parse(trimmed) else {
            presentError(String(
                localized: "jira.ticketBinding.error.unparsable",
                defaultValue: "Couldn't find a Jira issue key (e.g. PROJ-123) in that input.",
                table: "TermLoop"
            ))
            return
        }
        let normalizedStatus: String? = {
            let s = rawStatus.trimmingCharacters(in: .whitespacesAndNewlines)
            return s.isEmpty ? nil : s
        }()

        let value = AgentReportedStateStore.AgentReportedBinding(
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: bindingId,
            label: parsed.key,
            status: normalizedStatus,
            url: parsed.url,
            reportedAt: Date()
        )
        guard let firstId = workspaceIds.first else { return }
        let outcome = WorkspaceMetadataStore.shared.setReportedBinding(
            value,
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: bindingId,
            forWorkspaceId: firstId
        )
        if case .noWorktree = outcome {
            presentNoWorktreeError()
        }
    }

    private static func handleClear(workspaceIds: [UUID]) {
        guard let firstId = workspaceIds.first else { return }
        WorkspaceMetadataStore.shared.setReportedBinding(
            nil,
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            bindingId: bindingId,
            forWorkspaceId: firstId
        )
    }

    private static func parse(_ raw: String) -> (key: String, url: String?)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let key = extractKey(from: trimmed) else { return nil }

        let url: String?
        if let parsed = URL(string: trimmed),
           let scheme = parsed.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            url = parsed.absoluteString
        } else {
            url = nil
        }
        return (key, url)
    }

    private static func extractKey(from input: String) -> String? {
        guard let regex = keyRegex else { return nil }
        let upper = input.uppercased()
        let range = NSRange(upper.startIndex..<upper.endIndex, in: upper)
        guard let match = regex.firstMatch(in: upper, range: range),
              let r = Range(match.range, in: upper) else { return nil }
        return String(upper[r])
    }

    private static func presentNoWorktreeError() {
        presentError(String(
            localized: "jira.ticketBinding.error.noWorktree",
            defaultValue: "This workspace has no worktree root, so a Jira ticket can't be bound.",
            table: "TermLoop"
        ))
    }

    private static func presentError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = String(
            localized: "jira.ticketBinding.error.title",
            defaultValue: "Jira Ticket",
            table: "TermLoop"
        )
        alert.informativeText = message
        alert.runModal()
    }
}
