import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class AbilityStoreTests: XCTestCase {
    func testResolveProjectFolderPathInfersOuterProjectFromWorktreeCwd() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let worktreeCwd = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: "feature-x")
        )

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }
        _ = try projectStore.create(
            name: "ability-root-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )

        XCTAssertEqual(
            AbilityInjector.resolveProjectFolderPath(
                projectFolderPath: nil,
                runCwd: worktreeCwd
            ),
            repo.path
        )
    }

    func testResolveProjectFolderPathIgnoresGlobalWorktreeWithoutRegisteredProject() throws {
        let cwd = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: "/tmp/unregistered-repo", branch: "feature-x")
        )
        XCTAssertEqual(
            AbilityInjector.resolveProjectFolderPath(
                projectFolderPath: nil,
                runCwd: cwd
            ),
            nil
        )
    }

    func testResolveProjectFolderPathNormalizesExplicitWorktreeProjectFolder() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let worktreeRoot = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: "feature-x")
        )

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }
        _ = try projectStore.create(
            name: "ability-root-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )

        XCTAssertEqual(
            AbilityInjector.resolveProjectFolderPath(
                projectFolderPath: worktreeRoot,
                runCwd: worktreeRoot
            ),
            repo.path
        )
    }

    func testProjectFolderPathMatchingRunCwdFindsLongestProjectRoot() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let nested = repo.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        _ = try projectStore.create(
            name: "ability-root-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        _ = try projectStore.create(
            name: "ability-nested-\(UUID().uuidString.prefix(6))",
            folderPath: nested.path
        )

        XCTAssertEqual(
            AbilityInjector.projectFolderPath(matchingRunCwd: nested.appendingPathComponent("src").path),
            nested.path
        )
        XCTAssertEqual(
            AbilityInjector.projectFolderPath(matchingRunCwd: repo.appendingPathComponent("other").path),
            repo.path
        )
    }

    func testAbilityInjectorLoadsProjectAbilitiesFromDiskAndFiltersWorktreeActivation() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let abilitiesDir = repo
            .appendingPathComponent(".termloop/abilities", isDirectory: true)
        try FileManager.default.createDirectory(at: abilitiesDir, withIntermediateDirectories: true)

        try """
        ---
        name: Always Rule
        description: Use when always testing.
        activation: always
        ---
        ALWAYS-TOKEN
        """.write(
            to: abilitiesDir.appendingPathComponent("always-rule.md"),
            atomically: true,
            encoding: .utf8
        )

        try """
        ---
        name: Worktree Rule
        description: Use in worktrees.
        activation: worktree
        ---
        WORKTREE-TOKEN
        """.write(
            to: abilitiesDir.appendingPathComponent("worktree-rule.md"),
            atomically: true,
            encoding: .utf8
        )

        let rootPrompt = ProjectInstructionStore.snapshot(
            projectFolderPath: repo.path,
            runCwd: repo.path
        ).composedAppendSystemPrompt
        XCTAssertNotNil(rootPrompt)
        XCTAssertTrue(rootPrompt?.contains("ALWAYS-TOKEN") == true)
        XCTAssertFalse(rootPrompt?.contains("WORKTREE-TOKEN") == true)

        let worktreeCwd = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: "feature-x")
        )
        try FileManager.default.createDirectory(
            atPath: worktreeCwd,
            withIntermediateDirectories: true
        )
        let worktreePrompt = ProjectInstructionStore.snapshot(
            projectFolderPath: repo.path,
            runCwd: worktreeCwd
        ).composedAppendSystemPrompt
        XCTAssertNotNil(worktreePrompt)
        XCTAssertTrue(worktreePrompt?.contains("ALWAYS-TOKEN") == true, worktreePrompt ?? "nil")
        XCTAssertTrue(worktreePrompt?.contains("WORKTREE-TOKEN") == true, worktreePrompt ?? "nil")
    }

    func testInitializeDirectoryCreatesAbilitiesDirectoryWithoutSeedingTemplates() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        let store = AbilityStore.shared
        store.start()

        let project = try projectStore.create(
            name: "ability-seed-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        _ = project
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        store.initializeDirectory()

        let abilitiesDir = repo
            .appendingPathComponent(".termloop/abilities")
        XCTAssertTrue(FileManager.default.fileExists(atPath: abilitiesDir.path))
        XCTAssertNil(store.ability(id: "working-with-worktrees"))
    }

    func testInstallStarterCreatesJiraAbilityBundle() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        let store = AbilityStore.shared
        store.start()

        _ = try projectStore.create(
            name: "ability-template-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        guard let starter = ProjectInstructionStore.loadStarters().first(where: { $0.id == "working-with-jira" }) else {
            return XCTFail("expected bundled working-with-jira starter")
        }
        let ability = store.installStarter(starter)
        XCTAssertNotNil(ability)

        let manifestURL = repo
            .appendingPathComponent(".termloop/abilities/working-with-jira/ability.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: manifestURL.path))

        guard let installed = store.ability(id: "working-with-jira") else {
            return XCTFail("expected installed working-with-jira ability")
        }
        XCTAssertEqual(installed.name, "Working With Jira")
        XCTAssertEqual(installed.activation, .off)
        XCTAssertTrue(installed.systemReminderBody?.contains("Jira") ?? false)

        store.toggleActivation(id: "working-with-jira")
        XCTAssertEqual(store.ability(id: "working-with-jira")?.activation, .worktree)
    }

    func testInstallSystemTemplateCreatesWorkingWithDebuggingAbilityFromBundledMarkdown() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        defer {
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        let store = AbilityStore.shared
        store.start()

        _ = try projectStore.create(
            name: "ability-debugging-template-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))

        guard let starter = ProjectInstructionStore.loadStarters().first(where: { $0.id == "working-with-debugging" }) else {
            return XCTFail("expected bundled working-with-debugging starter")
        }
        let ability = store.installStarter(starter)
        XCTAssertNotNil(ability)

        let manifestURL = repo
            .appendingPathComponent(".termloop/abilities/working-with-debugging/ability.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: manifestURL.path))

        guard let installed = store.ability(id: "working-with-debugging") else {
            return XCTFail("expected installed working-with-debugging ability")
        }
        XCTAssertEqual(installed.name, "Working With Debugging")
        XCTAssertEqual(
            installed.description,
            "Use when the task involves debugging crashes, logs, instrumentation, runtime behavior, or performance in this project."
        )
        XCTAssertEqual(installed.activation, .off)
        XCTAssertTrue(installed.customizerPromptBody?.contains("Debugging Doc Customizer") ?? false)
    }


    func testAbilityBindingDecodesMissingOptionalDisplayFields() throws {
        struct Box: Decodable {
            let bindings: [AbilityBinding]
        }
        let data = #"""
        {
          "bindings": [
            { "id": "ticket", "title": "Jira Ticket" },
            { "id": "deploy", "title": "Deploy", "defaultLabel": "prod", "displayAs": "chip" }
          ]
        }
        """#.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(Box.self, from: data)

        XCTAssertEqual(decoded.bindings[0].displayAs, .chip)
        XCTAssertNil(decoded.bindings[0].defaultLabel)
        XCTAssertEqual(decoded.bindings[1].displayAs, .chip)
        XCTAssertEqual(decoded.bindings[1].defaultLabel, "prod")
    }

    func testProjectSkillMaterializerLinksCanonicalSkillToAgentCatalogs() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let canonical = repo
            .appendingPathComponent(".termloop/skills/working-with-jira", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        try """
        ---
        name: working-with-jira
        description: Project workflow.
        ---

        # Workflow
        """.write(
            to: canonical.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        ProjectSkillMaterializer.materialize(
            projectFolderPath: repo.path,
            skillIds: ["working-with-jira"]
        )

        for nativeRoot in [".claude", ".agents"] {
            let skillDir = repo
                .appendingPathComponent(nativeRoot, isDirectory: true)
                .appendingPathComponent("skills/working-with-jira", isDirectory: true)
            let skillFile = skillDir.appendingPathComponent("SKILL.md")
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: skillFile.path),
                "expected \(nativeRoot) managed skill copy"
            )
            XCTAssertThrowsError(
                try FileManager.default.destinationOfSymbolicLink(atPath: skillFile.path),
                "\(nativeRoot) managed SKILL.md should be a real file"
            )
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: skillDir.appendingPathComponent(".termloop-managed-skill").path),
                "expected \(nativeRoot) managed marker"
            )
        }

        let codexDir = repo
            .appendingPathComponent(".codex/skills/working-with-jira", isDirectory: true)
        let codexSkill = codexDir.appendingPathComponent("SKILL.md")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: codexSkill.path),
            "expected Codex managed skill copy"
        )
        XCTAssertThrowsError(
            try FileManager.default.destinationOfSymbolicLink(atPath: codexSkill.path),
            "Codex ignores symlinked SKILL.md files, so this must be a real file"
        )
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: codexDir.appendingPathComponent(".termloop-managed-skill").path),
            "expected Codex managed marker"
        )

        try "updated".write(
            to: canonical.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )
        ProjectSkillMaterializer.materialize(
            projectFolderPath: repo.path,
            skillIds: ["working-with-jira"]
        )
        XCTAssertEqual(try String(contentsOf: codexSkill, encoding: .utf8), "updated")
    }

    func testProjectSkillMaterializerEditURLPointsCodexBackToCanonical() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let canonical = repo
            .appendingPathComponent(".termloop/skills/working-with-jira", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        try "canonical".write(
            to: canonical.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        ProjectSkillMaterializer.materialize(
            projectFolderPath: repo.path,
            skillIds: ["working-with-jira"]
        )

        let locations = ProjectSkillMaterializer.skillLocations(
            projectFolderPath: repo.path,
            skillId: "working-with-jira"
        )
        guard let codexLocation = locations.first(where: { $0.label == "Codex native" }) else {
            return XCTFail("expected Codex native location")
        }
        XCTAssertEqual(
            codexLocation.editURL.standardizedFileURL.path,
            canonical.appendingPathComponent("SKILL.md").standardizedFileURL.path
        )
    }

    func testProjectSkillMaterializerDoesNotOverwriteUnmanagedAgentSkill() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let canonical = repo
            .appendingPathComponent(".termloop/skills/working-with-jira", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        try "canonical".write(
            to: canonical.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        let unmanaged = repo
            .appendingPathComponent(".codex/skills/working-with-jira", isDirectory: true)
        try FileManager.default.createDirectory(at: unmanaged, withIntermediateDirectories: true)
        try "user-owned".write(
            to: unmanaged.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )

        ProjectSkillMaterializer.materialize(
            projectFolderPath: repo.path,
            skillIds: ["working-with-jira"]
        )

        let body = try String(contentsOf: unmanaged.appendingPathComponent("SKILL.md"), encoding: .utf8)
        XCTAssertEqual(body, "user-owned")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: unmanaged.appendingPathComponent(".termloop-managed-skill").path)
        )
    }

    func testResolveReferencedSkillsFindsCanonicalProjectSkillBeforeNativeSync() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let canonical = repo
            .appendingPathComponent(".termloop/skills/running-your-application", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        let skillFile = canonical.appendingPathComponent("SKILL.md")
        try "canonical".write(to: skillFile, atomically: true, encoding: .utf8)

        let ability = Ability(
            id: "running-your-application",
            name: "Running Your Application",
            description: "Use when running.",
            activation: .listed,
            body: "",
            items: [
                .requiredSkill("running-your-application")
            ],
            filePath: URL(fileURLWithPath: "/tmp/running.md"),
            metadataFilePath: URL(fileURLWithPath: "/tmp/running.json")
        )

        let skills = ProjectInstructionStore.resolveReferencedSkills(
            abilities: [ability],
            projectFolderPath: repo.path
        )

        XCTAssertEqual(skills.map(\.name), ["running-your-application"])
        XCTAssertEqual(skills.first?.fileURL.standardizedFileURL.path, skillFile.standardizedFileURL.path)
    }

    func testProjectSkillMaterializerCopiesCanonicalSkillIntoWorktreeAgentCatalogs() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let repo = tmp.appendingPathComponent("repo")
        let canonical = repo
            .appendingPathComponent(".termloop/skills/running-your-application", isDirectory: true)
        try FileManager.default.createDirectory(at: canonical, withIntermediateDirectories: true)
        try "canonical".write(
            to: canonical.appendingPathComponent("SKILL.md"),
            atomically: true,
            encoding: .utf8
        )
        let worktreePath = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: "feature/run")
        )
        try FileManager.default.createDirectory(atPath: worktreePath, withIntermediateDirectories: true)
        let ability = Ability(
            id: "running-your-application",
            name: "Running Your Application",
            description: "Use when running.",
            activation: .listed,
            body: "",
            items: [
                .requiredSkill("running-your-application")
            ],
            filePath: URL(fileURLWithPath: "/tmp/running.md"),
            metadataFilePath: URL(fileURLWithPath: "/tmp/running.json")
        )

        ProjectSkillMaterializer.materialize(
            projectFolderPath: repo.path,
            agentCwdPath: worktreePath,
            abilities: [ability]
        )

        XCTAssertTrue(FileManager.default.fileExists(
            atPath: repo.appendingPathComponent(".codex/skills/running-your-application/SKILL.md").path
        ))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: URL(fileURLWithPath: worktreePath)
                .appendingPathComponent(".codex/skills/running-your-application/SKILL.md")
                .path
        ))
    }

    func testComposeAbilityBlockFallsBackToBodyWhenRequiredSkillIsMissing() {
        let ability = Ability(
            id: "working-with-jira",
            name: "Working With Jira",
            description: "Use when...",
            activation: .listed,
            body: "Fallback body content.",
            items: [
                .requiredSkill("working-with-jira")
            ],
            filePath: URL(fileURLWithPath: "/tmp/working-with-jira.md"),
            metadataFilePath: URL(fileURLWithPath: "/tmp/working-with-jira.json")
        )

        let output = ProjectInstructionStore.composeAbilityBlock(
            activeAbilities: [ability],
            listedAbilities: [],
            isWorktree: false,
            projectFolderPath: nil,
            referencedSkills: []
        )

        XCTAssertNotNil(output)
        XCTAssertTrue(output?.contains("Fallback body content.") ?? false)
        XCTAssertTrue(output?.contains("Working With Jira") ?? false)
    }

}
