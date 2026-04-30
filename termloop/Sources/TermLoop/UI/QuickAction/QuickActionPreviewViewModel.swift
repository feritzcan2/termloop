// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Combine
import Foundation

@MainActor
final class QuickActionPreviewViewModel: ObservableObject {
    struct Chip: Identifiable, Equatable {
        let ability: Ability
        let state: ChipState
        var id: String { ability.id }
    }

    enum ChipState: Equatable {
        case active          // injected as full body
        case listed          // on-demand reference
        case worktreeDormant // worktree-only, cwd is not a worktree
        case mutedForRun     // visible but excluded from this run
        case forceIncluded   // listed ability promoted to injected for this run
    }

    /// Composer-produced plan layered with the VM's current `PreviewOverrides`.
    /// Source of truth for all derived state below.
    @Published private(set) var plan: AgentInvocationPlan?
    @Published private(set) var mutedIds: Set<String> = []
    @Published private(set) var forceIncludedIds: Set<String> = []

    var allAbilities: [Ability] { plan?.instructions.allAbilities ?? [] }
    var isWorktree: Bool { plan?.instructions.isWorktree ?? false }

    var currentOverrides: PreviewOverrides {
        PreviewOverrides(muted: mutedIds, forceIncluded: forceIncludedIds)
    }

    /// Called by `QuickActionViewModel.refreshPreview()` after composing a
    /// fresh plan with the current overrides applied. Drops stale
    /// overrides for abilities that no longer exist. Writes to
    /// `mutedIds` / `forceIncludedIds` are guarded so a no-op filter
    /// doesn't bounce the parent's `$mutedIds` subscriber back into
    /// another `refreshPreview()`.
    func setPlan(_ newPlan: AgentInvocationPlan?) {
        if plan != newPlan {
            plan = newPlan
        }
        let existing = Set(newPlan?.instructions.allAbilities.map(\.id) ?? [])
        let filteredMuted = mutedIds.intersection(existing)
        if filteredMuted != mutedIds { mutedIds = filteredMuted }
        let filteredForced = forceIncludedIds.intersection(existing)
        if filteredForced != forceIncludedIds { forceIncludedIds = filteredForced }
    }

    func togglePerRunMute(_ id: String) {
        if mutedIds.contains(id) {
            mutedIds.remove(id)
        } else {
            mutedIds.insert(id)
        }
    }

    func clearPerRunMutes() {
        mutedIds.removeAll()
    }

    /// Force-include is only meaningful for `listed` abilities; silently
    /// ignored for any other activation.
    func setForceInclude(_ id: String, include: Bool) {
        guard let ability = allAbilities.first(where: { $0.id == id }),
              ability.activation == .listed else { return }
        if include {
            forceIncludedIds.insert(id)
        } else {
            forceIncludedIds.remove(id)
        }
    }

    // MARK: Derived state

    var effectiveInjected: [Ability] { plan?.instructions.activeAbilities ?? [] }
    var effectiveListed: [Ability] { plan?.instructions.listedAbilities ?? [] }

    /// Chips for PreviewBar. `off` abilities are excluded.
    var visibleChips: [Chip] {
        allAbilities.compactMap { ability -> Chip? in
            if ability.activation == .off { return nil }
            if mutedIds.contains(ability.id) {
                return Chip(ability: ability, state: .mutedForRun)
            }
            switch ability.activation {
            case .always:
                return Chip(ability: ability, state: .active)
            case .worktree:
                return Chip(
                    ability: ability,
                    state: isWorktree ? .active : .worktreeDormant
                )
            case .listed:
                return Chip(
                    ability: ability,
                    state: forceIncludedIds.contains(ability.id)
                        ? .forceIncluded
                        : .listed
                )
            case .off:
                return nil
            }
        }
    }

    /// The `--append-system-prompt` payload the composer produced for this
    /// preview (overrides already applied in `composer.previewPlan`).
    var renderedSystemPrompt: String? {
        plan?.instructions.composedAppendSystemPrompt
    }
}
