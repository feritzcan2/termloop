// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Per-run override state for preview composition. D1(B) side-channel: mute /
/// force-include never flow into launch. Preview callers build one from chip
/// state and pass it to `AgentInvocationComposer.previewPlan(_:overrides:)`.
struct PreviewOverrides: Equatable {
    var muted: Set<String>
    var forceIncluded: Set<String>

    static let none = PreviewOverrides(muted: [], forceIncluded: [])

    var isEmpty: Bool { muted.isEmpty && forceIncluded.isEmpty }
}

extension PreviewOverrides {
    /// Applies mute + force-include to a pre-partitioned base (already
    /// filtered for `.off` and worktree-dormant). Overrides can only
    /// subtract (mute) or promote-within-visible (force-include); they
    /// cannot resurrect abilities the base filtered out.
    static func applyToBasePartition(
        active: [Ability],
        listed: [Ability],
        overrides: PreviewOverrides
    ) -> (active: [Ability], listed: [Ability]) {
        var newActive: [Ability] = []
        var newListed: [Ability] = []
        for ability in active where !overrides.muted.contains(ability.id) {
            newActive.append(ability)
        }
        for ability in listed where !overrides.muted.contains(ability.id) {
            if overrides.forceIncluded.contains(ability.id) {
                var promoted = ability
                promoted.activation = .always
                newActive.append(promoted)
            } else {
                newListed.append(ability)
            }
        }
        return (newActive, newListed)
    }

    /// Partitions the raw ability list (including `.off` and worktree-
    /// dormant) into effective injected + listed, applying activation
    /// filters and the override layer in one pass. Used by preview-VM
    /// chip rendering.
    static func partition(
        from abilities: [Ability],
        overrides: PreviewOverrides,
        isWorktree: Bool
    ) -> (injected: [Ability], listed: [Ability]) {
        var injected: [Ability] = []
        var listed: [Ability] = []
        for ability in abilities where !overrides.muted.contains(ability.id) {
            switch ability.activation {
            case .always:
                injected.append(ability)
            case .worktree:
                if isWorktree { injected.append(ability) }
            case .listed:
                if overrides.forceIncluded.contains(ability.id) {
                    var promoted = ability
                    promoted.activation = .always
                    injected.append(promoted)
                } else {
                    listed.append(ability)
                }
            case .off:
                continue
            }
        }
        return (injected, listed)
    }
}
