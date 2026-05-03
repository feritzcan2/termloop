import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class QuickActionPreviewViewModelTests: XCTestCase {
    private func ab(_ id: String, _ a: AbilityActivation) -> Ability {
        let payload = payloadBlock(
            abilityId: id,
            id: "010-rules",
            title: id,
            body: "body-\(id)"
        )
        return Ability(
            id: id, name: id, description: "d", activation: a,
            payloadBlocks: [payload],
            metadataFilePath: URL(fileURLWithPath: "/tmp/\(id).json")
        )
    }

    private func payloadBlock(
        abilityId: String,
        id: String,
        title: String,
        body: String,
        bundleURL: URL? = nil,
        mcpToolName: String? = nil,
        includeInSkillFooter: Bool = false
    ) -> AbilityPayloadBlock {
        let fileURL: URL
        if let bundleURL {
            fileURL = bundleURL
                .appendingPathComponent(AbilityBundleManifest.payloadDirectoryName, isDirectory: true)
                .appendingPathComponent("\(id).md")
        } else {
            fileURL = URL(fileURLWithPath: "/tmp/\(abilityId)/payload/\(id).md")
        }
        return AbilityPayloadBlock(
            id: id,
            title: title,
            description: "",
            enabled: true,
            body: body,
            fileURL: fileURL,
            mcpToolName: mcpToolName,
            includeInSkillFooter: includeInSkillFooter
        )
    }

    /// Builds a plan with the given ability list + run overrides applied as
    /// if `AgentInvocationComposer.compose(_:overrides:)` had produced it.
    /// Tests stand in for the composer here because the preview VM only
    /// reads from the plan; composer behavior is covered by focused tests
    /// in this file.
    private func plan(
        all: [Ability],
        isWorktree: Bool,
        overrides: InstructionRunOverrides
    ) -> AgentInvocationPlan {
        let (injected, listed) = InstructionRunOverrides.partition(
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
                projectFolderPath: nil,
                disabledGenerated: overrides.disabledGenerated
            )
        let snapshot = ProjectInstructionSnapshot(
            activeAbilities: injected,
            listedAbilities: listed,
            allAbilities: all,
            referencedSkills: [],
            composedAppendSystemPrompt: composed,
            disabledGeneratedParts: overrides.disabledGenerated,
            hasRunOverrides: !overrides.isEmpty,
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

    func testComposerAppliesRunOverridesToResolvedSystemInstructions() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let previousProjectSnapshot = ProjectStore.shared.sessionSnapshot
        let previousActiveProjectId = ProjectStore.shared.activeProjectId
        let previousOpenProjectIds = ProjectStore.shared.openProjectIds
        defer {
            ProjectStore.shared.restoreFromSidecar(
                projects: previousProjectSnapshot,
                activeProjectId: previousActiveProjectId,
                openProjectIds: previousOpenProjectIds
            )
        }

        try writeProjectAbility(
            projectRoot: tmp,
            id: "launch-muted",
            name: "Launch Muted",
            activation: .always,
            body: "MUTED_ABILITY_BODY"
        )
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )
        let request = AgentInvocationRequest(
            agentId: TerminalAgent.claudeId,
            userPrompt: "Launch with current sheet overrides",
            projectId: project.id,
            runCwd: tmp,
            source: .quickAction
        )

        let base = try AgentInvocationComposer.compose(request)
        XCTAssertTrue(base.resolvedSystemInstructions?.contains("MUTED_ABILITY_BODY") == true)

        let muted = try AgentInvocationComposer.compose(
            request,
            overrides: InstructionRunOverrides(
                mutedAbilityIds: ["launch-muted"],
                forceIncludedAbilityIds: []
            )
        )
        XCTAssertNil(muted.resolvedSystemInstructions)
        XCTAssertTrue(muted.launchProvidedFullContext)
        XCTAssertTrue(muted.instructions.activeAbilities.isEmpty)
    }

    func testComposerAppliesLinkedPayloadBlockOverrides() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let previousProjectSnapshot = ProjectStore.shared.sessionSnapshot
        let previousActiveProjectId = ProjectStore.shared.activeProjectId
        let previousOpenProjectIds = ProjectStore.shared.openProjectIds
        defer {
            ProjectStore.shared.restoreFromSidecar(
                projects: previousProjectSnapshot,
                activeProjectId: previousActiveProjectId,
                openProjectIds: previousOpenProjectIds
            )
        }

        try writeProjectAbility(
            projectRoot: tmp,
            id: TermLoopBuiltInMCP.jiraAbilityId,
            name: "Working With Jira",
            activation: .always,
            body: "Use the Jira workflow.",
            payloadBlocks: { bundleURL in
                self.jiraTelemetryPayloadBlocks(bundleURL: bundleURL)
            }
        )
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )
        let request = AgentInvocationRequest(
            agentId: TerminalAgent.claudeId,
            userPrompt: "Launch with generated overrides",
            projectId: project.id,
            runCwd: tmp,
            source: .quickAction
        )
        let disabledSet = InstructionRunOverrides.GeneratedPartKind.toolLinkedPayload(
            abilityId: TermLoopBuiltInMCP.jiraAbilityId,
            toolName: TermLoopBuiltInMCP.setJiraTicketToolName
        )

        let plan = try AgentInvocationComposer.compose(
            request,
            overrides: InstructionRunOverrides(disabledGenerated: [disabledSet])
        )

        XCTAssertFalse(plan.resolvedSystemInstructions?.contains("mcp__termloop__set_jira_ticket") == true)
        XCTAssertTrue(plan.resolvedSystemInstructions?.contains("mcp__termloop__get_jira_ticket") == true)
        let disabledPart = AgentInputQueries.instructionParts(from: plan).first {
            $0.kind == .abilityPayloadBlock(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                blockId: "030-update-ticket-chip",
                mcpToolName: TermLoopBuiltInMCP.setJiraTicketToolName
            )
        }
        XCTAssertEqual(disabledPart?.enabled, false)
        XCTAssertEqual(disabledPart?.disableReason, "Disabled for this run.")
        XCTAssertTrue(plan.launchProvidedFullContext)
    }

    func testInstructionPartsExposePayloadBlocks() {
        var ability = ab(TermLoopBuiltInMCP.jiraAbilityId, .always)
        ability.name = "Working With Jira"
        ability.payloadBlocks = jiraPayloadBlocks()

        let composedPlan = plan(all: [ability], isWorktree: false, overrides: .none)
        let parts = AgentInputQueries.instructionParts(from: composedPlan)

        XCTAssertTrue(parts.contains {
            $0.kind == .abilityPayloadBlock(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                blockId: "010-use-jira-skill",
                mcpToolName: nil
            )
                && $0.body == "Use the Jira workflow."
        })
    }

    func testPayloadBlockOpensPayloadSource() throws {
        let block = payloadBlock(
            abilityId: "workflow",
            id: "010-workflow",
            title: "Workflow",
            body: "Use the workflow."
        )
        let ability = Ability(
            id: "workflow",
            name: "Workflow",
            description: "Workflow rules",
            activation: .always,
            payloadBlocks: [block],
            metadataFilePath: URL(fileURLWithPath: "/tmp/workflow/ability.json")
        )
        let parts = AgentInputQueries.abilityInstructionParts(
            for: ability,
            projectFolderPath: nil
        )
        let reminder = try XCTUnwrap(parts.first {
            $0.kind == .abilityPayloadBlock(
                abilityId: "workflow",
                blockId: "010-workflow",
                mcpToolName: nil
            )
        })

        XCTAssertEqual(reminder.source, .file(block.fileURL))
        XCTAssertEqual(reminder.editability, .openFile(block.fileURL))
    }

    func testOnDemandAbilityListDoesNotAdvertiseInlineSourceToggle() {
        let ability = Ability(
            id: "listed-skill",
            name: "Listed Skill",
            description: "Use when requested",
            activation: .listed,
            metadataFilePath: URL(fileURLWithPath: "/tmp/listed-skill/ability.json")
        )

        let parts = AgentInputQueries.abilityInstructionParts(
            for: ability,
            projectFolderPath: nil
        )
        let list = parts.first { $0.kind == .onDemandAbilityList }

        XCTAssertEqual(
            list?.editability,
            .notEditable("Toggle the ability's activation in the Abilities panel.")
        )
    }

    func testMaterializedSkillFootersUsePayloadBlocks() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let skillId = "jira-skill"
        let canonicalSkillDirectory = tmp
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent(skillId, isDirectory: true)
        try FileManager.default.createDirectory(
            at: canonicalSkillDirectory,
            withIntermediateDirectories: true
        )
        try "# Jira Skill\n".write(
            to: canonicalSkillDirectory.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        let abilityDirectory = tmp
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
            .appendingPathComponent(TermLoopBuiltInMCP.jiraAbilityId, isDirectory: true)
        let ability = Ability(
            id: TermLoopBuiltInMCP.jiraAbilityId,
            name: "Working With Jira",
            description: "Jira workflow",
            activation: .always,
            payloadBlocks: jiraTelemetryPayloadBlocks(),
            items: [.requiredSkill(skillId)],
            metadataFilePath: abilityDirectory.appendingPathComponent("ability.json")
        )

        ProjectSkillMaterializer.materialize(
            projectFolderPath: tmp.path,
            abilities: [ability]
        )

        let nativeSkill = tmp
            .appendingPathComponent(".claude", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
            .appendingPathComponent(skillId, isDirectory: true)
            .appendingPathComponent("SKILL.md")
        let materialized = try String(contentsOf: nativeSkill, encoding: .utf8)
        XCTAssertTrue(materialized.contains("mcp__termloop__set_jira_ticket"))
        XCTAssertTrue(materialized.contains("mcp__termloop__get_jira_ticket"))

        let nativeSkillRoot = tmp
            .appendingPathComponent(".claude", isDirectory: true)
            .appendingPathComponent("skills", isDirectory: true)
        try? FileManager.default.removeItem(at: nativeSkillRoot)

        ProjectSkillMaterializer.materialize(
            projectFolderPath: tmp.path,
            abilities: [ability],
            disabledGenerated: [
                .toolLinkedPayload(
                    abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                    toolName: TermLoopBuiltInMCP.setJiraTicketToolName
                )
            ]
        )
        let materializedWithOverride = try String(contentsOf: nativeSkill, encoding: .utf8)
        XCTAssertFalse(materializedWithOverride.contains("mcp__termloop__set_jira_ticket"))
        XCTAssertTrue(materializedWithOverride.contains("mcp__termloop__get_jira_ticket"))
    }

    private func writeProjectAbility(
        projectRoot: URL,
        id: String,
        name: String,
        activation: AbilityActivation,
        body: String,
        payloadBlocks: ((URL) -> [AbilityPayloadBlock])? = nil
    ) throws {
        let abilitiesDir = projectRoot
            .appendingPathComponent(".termloop", isDirectory: true)
            .appendingPathComponent("abilities", isDirectory: true)
        let bundleURL = AbilityBundleStore.bundleDirectoryURL(parentDirectory: abilitiesDir, slug: id)
        let ability = Ability(
            id: id,
            name: name,
            description: "Test ability",
            activation: activation,
            payloadBlocks: payloadBlocks?(bundleURL)
                ?? defaultPayloadBlocks(abilityId: id, body: body, bundleURL: bundleURL),
            metadataFilePath: bundleURL.appendingPathComponent("ability.json")
        )
        try AbilityBundleStore.save(ability)
    }

    private func defaultPayloadBlocks(abilityId: String, body: String, bundleURL: URL) -> [AbilityPayloadBlock] {
        guard abilityId == TermLoopBuiltInMCP.jiraAbilityId else {
            return [
                payloadBlock(
                    abilityId: abilityId,
                    id: "010-rules",
                    title: "Rules",
                    body: body,
                    bundleURL: bundleURL
                )
            ]
        }
        return [
            payloadBlock(
                abilityId: abilityId,
                id: "010-use-jira-skill",
                title: "Use the Jira skill",
                body: body,
                bundleURL: bundleURL
            )
        ]
    }

    private func jiraPayloadBlocks(bundleURL: URL? = nil) -> [AbilityPayloadBlock] {
        [
            payloadBlock(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                id: "010-use-jira-skill",
                title: "Use the Jira skill",
                body: "Use the Jira workflow.",
                bundleURL: bundleURL
            )
        ]
    }

    private func jiraTelemetryPayloadBlocks(bundleURL: URL? = nil) -> [AbilityPayloadBlock] {
        jiraPayloadBlocks(bundleURL: bundleURL) + [
            payloadBlock(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                id: "020-resume-bound-ticket",
                title: "Resume bound ticket",
                body: "When resuming, call `mcp__termloop__get_jira_ticket`.",
                bundleURL: bundleURL,
                mcpToolName: TermLoopBuiltInMCP.getJiraTicketToolName,
                includeInSkillFooter: true
            ),
            payloadBlock(
                abilityId: TermLoopBuiltInMCP.jiraAbilityId,
                id: "030-update-ticket-chip",
                title: "Update ticket chip",
                body: "Telemetry: call `mcp__termloop__set_jira_ticket`.",
                bundleURL: bundleURL,
                mcpToolName: TermLoopBuiltInMCP.setJiraTicketToolName,
                includeInSkillFooter: true
            )
        ]
    }
}
