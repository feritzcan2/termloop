// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Per-agent surfaceable permission modes for the new-workspace UX.
///
/// `AgentTemplate.PermissionMode` defines every mode the launcher knows
/// about (including legacy aliases). `PermissionModeCatalog` is a smaller,
/// curated subset: only the modes we want to show in the sidebar mode
/// picker and the workspace context-menu mode-change submenu.
struct PermissionModeOption: Equatable, Identifiable {
    enum BadgeColor: Equatable {
        case bypass, plan, acceptEdits, neutral

        var color: Color {
            switch self {
            case .bypass: return .orange
            case .plan: return .accentColor
            case .acceptEdits: return .green
            case .neutral: return .secondary
            }
        }
    }

    /// Stable storage value — matches `AgentTemplate.PermissionMode.rawValue`.
    let mode: AgentTemplate.PermissionMode
    /// Short title shown in pickers and badges (e.g. "Bypass", "Plan").
    let title: String
    /// One-sentence explanation shown under the title in the picker.
    let description: String
    /// Compact preview of the raw CLI flag for power-user disambiguation.
    let flagPreview: String
    /// Color token used by the sidebar pill / picker dot.
    let badgeColor: BadgeColor

    var id: String { mode.rawValue }
}

enum PermissionModeCatalog {
    /// Cached per-agent option arrays. Built once per agent id, then
    /// returned by reference on every subsequent call so the sidebar
    /// badge render path doesn't allocate a fresh array each render.
    private static let cache: [String: [PermissionModeOption]] = [
        "claude": [
            PermissionModeOption(
                mode: .bypassPermissions,
                title: "Bypass",
                description: "Skip all tool-call confirmations.",
                flagPreview: "--dangerously-skip-permissions",
                badgeColor: .bypass
            ),
            PermissionModeOption(
                mode: .plan,
                title: "Plan",
                description: "Read-only research mode.",
                flagPreview: "--permission-mode plan",
                badgeColor: .plan
            ),
            PermissionModeOption(
                mode: .acceptEdits,
                title: "Accept Edits",
                description: "Auto-approve edits, prompt for the rest.",
                flagPreview: "--permission-mode acceptEdits",
                badgeColor: .acceptEdits
            ),
        ],
        "codex": [
            PermissionModeOption(
                mode: .bypassPermissions,
                title: "Bypass",
                description: "Skip approvals and sandbox.",
                flagPreview: "--dangerously-bypass-approvals-and-sandbox",
                badgeColor: .bypass
            ),
            PermissionModeOption(
                mode: .plan,
                title: "Plan",
                description: "Read-only sandbox, ask before acting.",
                flagPreview: "sandbox=read-only",
                badgeColor: .plan
            ),
            PermissionModeOption(
                mode: .acceptEdits,
                title: "Accept Edits",
                description: "Workspace-write sandbox, on-failure approval.",
                flagPreview: "sandbox=workspace-write",
                badgeColor: .acceptEdits
            ),
        ],
    ]

    /// Returns the curated mode list for the given agent id, in the order
    /// they should appear in pickers. The first entry is the default when
    /// no last-used mode is recorded for the agent. Empty for single-mode
    /// agents (gemini, opencode) — caller skips the picker.
    static func surfaceableModes(forAgentId agentId: String) -> [PermissionModeOption] {
        cache[agentId] ?? []
    }

    /// Looks up the catalog entry for the given agent + raw mode rawValue.
    /// Returns nil for agents/modes not in the curated catalog.
    static func option(forAgentId agentId: String, modeRawValue: String?) -> PermissionModeOption? {
        guard let raw = modeRawValue, !raw.isEmpty,
              let modes = cache[agentId] else { return nil }
        return modes.first { $0.mode.rawValue == raw }
    }
}
