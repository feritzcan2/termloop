import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class ProjectInstructionStoreAbilityBlockTests: XCTestCase {
    private func makeAbility(
        id: String,
        activation: AbilityActivation,
        body: String = "body"
    ) -> Ability {
        Ability(
            id: id,
            name: id,
            description: "desc",
            activation: activation,
            body: body,
            filePath: URL(fileURLWithPath: "/tmp/\(id).md"),
            metadataFilePath: URL(fileURLWithPath: "/tmp/\(id).json")
        )
    }

    func testOverrideAbilitiesReplacesLoadedSet() {
        let a = makeAbility(id: "git", activation: .always, body: "# git body")
        let prompt = ProjectInstructionStore.composeAbilityBlock(
            abilities: [a],
            isWorktree: false
        )
        XCTAssertNotNil(prompt)
        XCTAssertTrue(prompt!.contains("### git"))
        XCTAssertTrue(prompt!.contains("# git body"))
    }

    func testOverrideAbilitiesRespectsActivationPartitioning() {
        let always = makeAbility(id: "a", activation: .always)
        let dormant = makeAbility(id: "w", activation: .worktree)
        let listed = makeAbility(id: "l", activation: .listed)
        let off = makeAbility(id: "o", activation: .off)

        let nonWorktree = ProjectInstructionStore.composeAbilityBlock(
            abilities: [always, dormant, listed, off],
            isWorktree: false
        )!
        XCTAssertTrue(nonWorktree.contains("### a"))
        XCTAssertFalse(nonWorktree.contains("### w"))
        XCTAssertTrue(nonWorktree.contains("- **l**"))
        XCTAssertFalse(nonWorktree.contains("### o"))

        let worktree = ProjectInstructionStore.composeAbilityBlock(
            abilities: [always, dormant, listed, off],
            isWorktree: true
        )!
        XCTAssertTrue(worktree.contains("### a"))
        XCTAssertTrue(worktree.contains("### w"))
    }

    func testOverrideAbilitiesEmptyReturnsNil() {
        XCTAssertNil(ProjectInstructionStore.composeAbilityBlock(
            abilities: [],
            isWorktree: false
        ))
    }

    func testRequiredSkillAbilityDoesNotInjectInstructionsBody() {
        var ability = makeAbility(
            id: "jira",
            activation: .always,
            body: "SHOULD_NOT_RENDER_INSTRUCTIONS"
        )
        ability.items = [.requiredSkill("working-with-jira")]

        let skill = SkillEntry(
            id: "project:skill:/tmp/SKILL.md",
            name: "working-with-jira",
            displayPath: "working-with-jira",
            description: "Project Jira flow.",
            body: "SKILL_BODY_SHOULD_RENDER",
            source: .project,
            kind: .skill,
            fileURL: URL(fileURLWithPath: "/tmp/SKILL.md")
        )

        let prompt = ProjectInstructionStore.composeAbilityBlock(
            activeAbilities: [ability],
            listedAbilities: [],
            isWorktree: false,
            projectFolderPath: nil,
            referencedSkills: [skill]
        )!

        XCTAssertFalse(prompt.contains("SHOULD_NOT_RENDER_INSTRUCTIONS"))
        XCTAssertTrue(prompt.contains("## Required project skills"))
        XCTAssertTrue(prompt.contains("working-with-jira"))
        XCTAssertTrue(prompt.contains("Project Jira flow."))
    }
}
