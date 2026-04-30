// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Bridge / ask-agent preset catalog. Owns the per-target agent identity,
/// the conversation-shape presets (consult, debug, ...), the loop-mode
/// shaping, and the verbatim source/target prompts each preset hands to
/// the bridge.
///
/// Phase 5: previously these enums lived as `private` types inside
/// `BridgeKickoffSheet.swift`, so view code held the full prompt strings
/// directly. Moving them under `AgentInputs/` keeps the bridge runtime
/// (WorkspaceBridgeStore / BridgeCoordinator) untouched while consolidating
/// **input** assembly with the rest of the agent-input domain.
///
/// Bridge helper launches that go through the composer should set
/// `AgentInvocationSource.bridgeKickoff` or `.askAgent` so row renderers
/// can suppress turn-1 chrome via `AgentInputQueries.isBridgeHelperLaunch`.

enum AskTargetAgent: String, CaseIterable, Identifiable {
    case codex
    case claude
    case gemini

    var id: String { rawValue }
    var agentId: String { rawValue }

    var title: String {
        switch self {
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .gemini: return "Gemini"
        }
    }

    var defaultWorkspaceTitle: String { title }

    var isRuntimeSupported: Bool {
        switch self {
        case .codex, .claude, .gemini: return true
        }
    }

    var availabilityNote: String? {
        isRuntimeSupported ? nil : "Coming soon"
    }
}

enum AskAgentPreset: String, CaseIterable, Identifiable {
    case ask
    case debug
    case review

    var id: String { rawValue }

    var title: String {
        switch self {
        case .ask: return "Ask"
        case .debug: return "Debug"
        case .review: return "Review"
        }
    }

    var summary: String {
        switch self {
        case .ask: return "Share where you're at, hear them out."
        case .debug: return "Second pair of eyes on what's broken."
        case .review: return "Hand it over, see what they'd flag."
        }
    }

    func defaultSourcePromptTemplate(target: AskTargetAgent) -> String {
        let targetName = "{{target_name}}"
        switch self {
        case .ask:
            return """
            You have a linked \(targetName) workspace — a second opinion before you commit to an approach.

            Write a short message to \(targetName) (3–4 sentences): what you're trying to do, what you're thinking, and where the work is — local changes in the worktree, or the relevant commits.{{worktree_note}} Then ask what they think.

            That message is your next reply — \(targetName) sees it verbatim. No tools, no investigation first.

            Workspace: {{workspace_title}}{{workspace_location}}
            """
        case .debug:
            return """
            You have a linked \(targetName) workspace — a second pair of eyes on a bug.

            Write a short message to \(targetName) (3–4 sentences): what you've been doing, the errors in broad strokes, and where to look — local changes in the worktree, or the relevant commits.{{worktree_note}} Then ask what they see.

            That message is your next reply — \(targetName) sees it verbatim. No tools, no investigation first.

            Workspace: {{workspace_title}}{{workspace_location}}
            """
        case .review:
            return """
            You have a linked \(targetName) workspace for a review.

            Write a short message to \(targetName) (3–4 sentences): what you built, the rough approach, and where to look — local changes in the worktree, or the relevant commits.{{worktree_note}} Then ask what they'd flag.

            That message is your next reply — \(targetName) sees it verbatim. No tools, no investigation first.

            Workspace: {{workspace_title}}{{workspace_location}}
            """
        }
    }

    @MainActor
    func sourcePrompt(target: AskTargetAgent, workspaceTitle: String, cwd: String?) -> String {
        let projectFolderPath = ProjectStore.shared.activeProjectId.flatMap { ProjectStore.shared.project(id: $0)?.folderPath }
        let template = AgentPromptStore.body(
            id: AgentPromptStore.bridgeSourceDocumentID(self),
            projectFolderPath: projectFolderPath
        ) ?? defaultSourcePromptTemplate(target: target)
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let location = trimmedCwd.isEmpty ? "" : "\nWorkspace cwd: \(trimmedCwd)"
        // Helper forks the source workspace and inherits the same cwd, so
        // if the source is inside an termloop worktree the helper can
        // `git diff / log / show` the in-flight work directly. Only emit
        // the note in that case — on plain master/dev checkouts there's
        // usually no branch-level context worth pointing at.
        let worktreeNote: String = WorktreeResolver.worktreeRoot(containing: trimmedCwd) != nil
            ? " If you're on a feature branch, name it."
            : ""
        return AgentPromptStore.render(
            template: template,
            replacements: [
                "target_name": target.title,
                "workspace_title": workspaceTitle,
                "workspace_location": location,
                "cwd": cwd ?? "",
                "worktree_note": worktreeNote
            ]
        )
    }

}

/// Universal helper-agent system prompt for ask-to launches. Without this
/// the helper (especially Claude) opens with preface replies like
/// "I'll ground the review in the code first..." that end the turn
/// without an actual answer, and bridge forwards that preamble back to
/// the source as noise. Keep the text terse — appended after Claude's
/// default system prompt via `--append-system-prompt`.
enum BridgeHelperSystemPrompt {
    static let antiPreamble: String = """
    Answer the incoming message directly in one reply. No preamble, no acknowledgments, no "I'll do X first" — lead with the substantive answer. If the question needs code inspection, do it silently and return the conclusion in the same turn.
    """

    static func compose(userOverride: String) -> String {
        let trimmed = userOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? antiPreamble : "\(antiPreamble)\n\n\(trimmed)"
    }
}
