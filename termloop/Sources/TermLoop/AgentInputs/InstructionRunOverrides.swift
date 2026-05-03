// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Sheet-scoped per-run override state for instruction composition. Preview
/// and launch both pass this to `AgentInvocationComposer.compose`, so the
/// reviewed payload and launched payload stay in lockstep.
struct InstructionRunOverrides: Equatable {
    enum GeneratedPartKind: Hashable {
        case worktreeContext
        case reportedContext
        case toolLinkedPayload(abilityId: String, toolName: String)
    }

    var mutedAbilityIds: Set<String>
    var forceIncludedAbilityIds: Set<String>
    var disabledGenerated: Set<GeneratedPartKind>

    init(
        mutedAbilityIds: Set<String> = [],
        forceIncludedAbilityIds: Set<String> = [],
        disabledGenerated: Set<GeneratedPartKind> = []
    ) {
        self.mutedAbilityIds = mutedAbilityIds
        self.forceIncludedAbilityIds = forceIncludedAbilityIds
        self.disabledGenerated = disabledGenerated
    }

    static let none = InstructionRunOverrides()

    var isEmpty: Bool {
        mutedAbilityIds.isEmpty
            && forceIncludedAbilityIds.isEmpty
            && disabledGenerated.isEmpty
    }
}

extension InstructionRunOverrides {
    /// Applies mute + force-include to a pre-partitioned base (already
    /// filtered for `.off` and worktree-dormant). Overrides can only
    /// subtract (mute) or promote-within-visible (force-include); they
    /// cannot resurrect abilities the base filtered out.
    static func applyToBasePartition(
        active: [Ability],
        listed: [Ability],
        overrides: InstructionRunOverrides
    ) -> (active: [Ability], listed: [Ability]) {
        var newActive: [Ability] = []
        var newListed: [Ability] = []
        for ability in active where !overrides.mutedAbilityIds.contains(ability.id) {
            newActive.append(ability)
        }
        for ability in listed where !overrides.mutedAbilityIds.contains(ability.id) {
            if overrides.forceIncludedAbilityIds.contains(ability.id) {
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
        overrides: InstructionRunOverrides,
        isWorktree: Bool
    ) -> (injected: [Ability], listed: [Ability]) {
        var injected: [Ability] = []
        var listed: [Ability] = []
        for ability in abilities where !overrides.mutedAbilityIds.contains(ability.id) {
            switch ability.activation {
            case .always:
                injected.append(ability)
            case .worktree:
                if isWorktree { injected.append(ability) }
            case .listed:
                if overrides.forceIncludedAbilityIds.contains(ability.id) {
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
