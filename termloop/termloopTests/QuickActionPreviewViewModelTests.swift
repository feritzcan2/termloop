import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class QuickActionPreviewViewModelTests: XCTestCase {
    private func ab(_ id: String, _ a: AbilityActivation) -> Ability {
        Ability(
            id: id, name: id, description: "d", activation: a, body: "body-\(id)",
            filePath: URL(fileURLWithPath: "/tmp/\(id).md"),
            metadataFilePath: URL(fileURLWithPath: "/tmp/\(id).json")
        )
    }

    /// Builds a plan with the given ability list + overrides applied as if
    /// `AgentInvocationComposer.previewPlan(_:overrides:)` had produced it.
    /// Tests stand in for the composer here because the preview VM only
    /// reads from the plan — the composer's computation is exercised in
    /// `AgentInvocationComposerTests`.
    private func plan(
        all: [Ability],
        isWorktree: Bool,
        overrides: PreviewOverrides
    ) -> AgentInvocationPlan {
        let (injected, listed) = PreviewOverrides.partition(
            from: all,
            overrides: overrides,
            isWorktree: isWorktree
        )
        let composed: String? = (injected.isEmpty && listed.isEmpty)
            ? nil
            : ProjectInstructionStore.composeAbilityBlock(
                activeAbilities: injected,
                listedAbilities: listed,
                isWorktree: isWorktree,
                projectFolderPath: nil
            )
        let snapshot = ProjectInstructionSnapshot(
            activeAbilities: injected,
            listedAbilities: listed,
            allAbilities: all,
            referencedSkills: [],
            composedAppendSystemPrompt: composed,
            isWorktree: isWorktree
        )
        return AgentInvocationPlan(
            agentId: "claude",
            resolvedModel: .default,
            resolvedReasoning: nil,
            resolvedPermission: nil,
            template: nil,
            resolvedPromptBody: nil,
            resolvedUserSystemPrompt: nil,
            resolvedSystemInstructions: composed,
            reportedContextBlock: nil,
            worktreeContextBlock: nil,
            instructions: snapshot,
            runCwd: nil,
            workspaceId: nil,
            projectId: nil,
            branchName: nil,
            repoRootPath: nil,
            source: .quickAction,
            reasonTag: nil,
            previewSummary: AgentInvocationPlan.PreviewSummary(
                title: "test",
                snippet: nil,
                injectedAbilityNames: injected.map(\.name),
                listedAbilityNames: listed.map(\.name),
                referencedSkillNames: []
            )
        )
    }

    private func seed(
        _ vm: QuickActionPreviewViewModel,
        all: [Ability],
        isWorktree: Bool
    ) {
        vm.setPlan(plan(all: all, isWorktree: isWorktree, overrides: vm.currentOverrides))
    }

    /// Mirrors the QuickActionViewModel refresh loop: after any override
    /// mutation, parent recomposes with the new override layer.
    private func recompose(_ vm: QuickActionPreviewViewModel, all: [Ability], isWorktree: Bool) {
        vm.setPlan(plan(all: all, isWorktree: isWorktree, overrides: vm.currentOverrides))
    }

    func testPartitionByActivation() {
        let vm = QuickActionPreviewViewModel()
        seed(vm, all: [ab("a", .always), ab("w", .worktree), ab("l", .listed), ab("o", .off)],
             isWorktree: true)
        XCTAssertEqual(Set(vm.effectiveInjected.map(\.id)), ["a", "w"])
        XCTAssertEqual(Set(vm.effectiveListed.map(\.id)), ["l"])
        XCTAssertEqual(Set(vm.visibleChips.map(\.ability.id)), ["a", "w", "l"])
    }

    func testWorktreeDormantMarked() {
        let vm = QuickActionPreviewViewModel()
        seed(vm, all: [ab("w", .worktree)], isWorktree: false)
        let chip = vm.visibleChips.first { $0.ability.id == "w" }
        XCTAssertEqual(chip?.state, .worktreeDormant)
    }

    func testPerRunMuteExcludesFromInjection() {
        let vm = QuickActionPreviewViewModel()
        let abilities = [ab("a", .always), ab("b", .always)]
        seed(vm, all: abilities, isWorktree: false)
        vm.togglePerRunMute("a")
        recompose(vm, all: abilities, isWorktree: false)
        XCTAssertEqual(Set(vm.effectiveInjected.map(\.id)), ["b"])
        XCTAssertEqual(vm.mutedIds, ["a"])
        let chip = vm.visibleChips.first { $0.ability.id == "a" }
        XCTAssertEqual(chip?.state, .mutedForRun)
    }

    func testForceIncludePromotesListedToInjected() {
        let vm = QuickActionPreviewViewModel()
        let abilities = [ab("l", .listed)]
        seed(vm, all: abilities, isWorktree: false)
        vm.setForceInclude("l", include: true)
        recompose(vm, all: abilities, isWorktree: false)
        XCTAssertEqual(Set(vm.effectiveInjected.map(\.id)), ["l"])
        XCTAssertEqual(Set(vm.effectiveListed.map(\.id)), [])
    }

    func testForceIncludeOnlyAppliesToListed() {
        let vm = QuickActionPreviewViewModel()
        seed(vm, all: [ab("a", .always)], isWorktree: false)
        vm.setForceInclude("a", include: true)
        XCTAssertFalse(vm.forceIncludedIds.contains("a"))
    }

    func testClearMutesRestores() {
        let vm = QuickActionPreviewViewModel()
        let abilities = [ab("a", .always)]
        seed(vm, all: abilities, isWorktree: false)
        vm.togglePerRunMute("a")
        recompose(vm, all: abilities, isWorktree: false)
        vm.clearPerRunMutes()
        recompose(vm, all: abilities, isWorktree: false)
        XCTAssertTrue(vm.mutedIds.isEmpty)
        XCTAssertEqual(Set(vm.effectiveInjected.map(\.id)), ["a"])
    }

    func testRenderedSystemPromptMatchesInjectorOutput() {
        let vm = QuickActionPreviewViewModel()
        seed(vm, all: [ab("a", .always)], isWorktree: false)
        let expected = ProjectInstructionStore.composeAbilityBlock(
            abilities: [ab("a", .always)],
            isWorktree: false
        )
        XCTAssertEqual(vm.renderedSystemPrompt, expected)
    }
}
