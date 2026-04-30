// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Pure selectors / preview helpers that read a composed
/// `AgentInvocationPlan` and project it into UI-friendly slices. No state
/// ownership and no recomposition: if the plan is wrong, queries are wrong
/// — the fix is in the composer, not here.
///
/// Cross-cutting on purpose: queries operate on the plan (single object),
/// not per-store. The plan already aggregates catalog + template +
/// instruction snapshots.
enum AgentInputQueries {

    // MARK: - Abilities

    static func injectedAbilityNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.injectedAbilityNames
    }

    static func listedAbilityNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.listedAbilityNames
    }

    static func hasInjectedAbilities(_ plan: AgentInvocationPlan) -> Bool {
        !plan.previewSummary.injectedAbilityNames.isEmpty
    }

    // MARK: - Skills

    static func referencedSkillNames(_ plan: AgentInvocationPlan) -> [String] {
        plan.previewSummary.referencedSkillNames
    }

    // MARK: - Display

    /// Title shown in run rows / chips. Already resolved by the composer
    /// (template name, free-prompt snippet, or agent display name).
    static func displayTitle(_ plan: AgentInvocationPlan) -> String {
        plan.previewSummary.title
    }

    static func promptSnippet(_ plan: AgentInvocationPlan) -> String? {
        plan.previewSummary.snippet
    }

    /// Compact chip-row label for the resolved model. Hidden when the plan
    /// resolves to `.default` (no point cluttering rows with a no-op).
    static func modelBadge(_ plan: AgentInvocationPlan) -> String? {
        guard plan.resolvedModel != .default else { return nil }
        return plan.resolvedModel.displayLabel
    }

    static func permissionBadge(_ plan: AgentInvocationPlan) -> String? {
        switch plan.resolvedPermission {
        case .none: return nil
        case .auto, .bypassPermissions: return "bypass"
        case .ask, .default: return "default"
        case .acceptEdits: return "accept-edits"
        case .dontAsk: return "dont-ask"
        case .plan: return "plan"
        }
    }

    static func reasoningBadge(_ plan: AgentInvocationPlan) -> String? {
        switch plan.resolvedReasoning {
        case .none, .some(.default):
            return nil
        case .some(let effort):
            return effort.rawValue
        }
    }

    // MARK: - Source

    /// Whether this run originated from the quick-action free-prompt row
    /// (used by row renderers to choose snippet-vs-name display).
    static func isFreePrompt(_ plan: AgentInvocationPlan) -> Bool {
        plan.source == .quickActionFreePrompt || plan.reasonTag == "quickAction.freePrompt"
    }

    /// True when the run is part of a bridge helper kickoff or ask-agent
    /// invocation (used to suppress noisy turn-1 chrome).
    static func isBridgeHelperLaunch(_ plan: AgentInvocationPlan) -> Bool {
        switch plan.source {
        case .bridgeKickoff, .askAgent: return true
        default: return false
        }
    }
}
