import AppKit
import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class QuickActionViewModelTests: XCTestCase {
    private var tmp: URL!
    private var defaultsSuiteName: String!
    private let defaultTemplateKey = QuickActionSettings.defaultAgentTemplateIdKey
    private var previousDefaultTemplate: Any?
    private var previousProjectSnapshot: [SessionProjectSnapshot] = []
    private var previousActiveProjectId: UUID?
    private var previousOpenProjectIds: [UUID] = []
    private var previousMetadataSnapshot: [String: WorkspaceMetadataStore.Metadata] = [:]

    override func setUp() async throws {
        previousDefaultTemplate = UserDefaults.standard.object(forKey: defaultTemplateKey)
        UserDefaults.standard.removeObject(forKey: defaultTemplateKey)
        previousProjectSnapshot = ProjectStore.shared.sessionSnapshot
        previousActiveProjectId = ProjectStore.shared.activeProjectId
        previousOpenProjectIds = ProjectStore.shared.openProjectIds
        previousMetadataSnapshot = WorkspaceMetadataStore.shared.snapshot()

        tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defaultsSuiteName = "QuickActionViewModelTests.\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        UserDefaults.standard.removeObject(forKey: defaultTemplateKey)
        if let previousDefaultTemplate {
            UserDefaults.standard.set(previousDefaultTemplate, forKey: defaultTemplateKey)
        }
        if let defaultsSuiteName {
            UserDefaults.standard.removePersistentDomain(forName: defaultsSuiteName)
        }
        ProjectStore.shared.restoreFromSidecar(
            projects: previousProjectSnapshot,
            activeProjectId: previousActiveProjectId,
            openProjectIds: previousOpenProjectIds
        )
        WorkspaceMetadataStore.shared.restore(previousMetadataSnapshot)
        try? FileManager.default.removeItem(at: tmp)
    }

    func testFreePromptDefaultsToDedicatedTemplate() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )
        try writeTemplate(
            named: "edge-case-hunter-agent.md",
            id: "edge-case-hunter-agent",
            displayName: "Edge Case Hunter",
            scope: "workspace"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let lru = QuickActionLRUStore(defaults: defaults)
        let viewModel = QuickActionViewModel(templateStore: templateStore, lru: lru, launcher: StubQuickActionLauncher())

        viewModel.onPresent(defaultTargetWorkspaceId: nil)

        guard case .freePrompt(let resolvedTemplateId) = viewModel.composition else {
            return XCTFail("Expected free-prompt composition")
        }
        XCTAssertEqual(resolvedTemplateId, QuickActionSettings.freePromptTemplateId)
        XCTAssertEqual(viewModel.activeTemplate?.name, "Free Prompt Template")
    }

    func testFreePromptDedicatedTemplateWinsOverSettingsDefault() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )
        try writeTemplate(
            named: "edge-case-hunter-agent.md",
            id: "edge-case-hunter-agent",
            displayName: "Edge Case Hunter",
            scope: "workspace"
        )

        UserDefaults.standard.set("edge-case-hunter-agent", forKey: defaultTemplateKey)

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let lru = QuickActionLRUStore(defaults: defaults)
        let viewModel = QuickActionViewModel(templateStore: templateStore, lru: lru, launcher: StubQuickActionLauncher())

        viewModel.onPresent(defaultTargetWorkspaceId: nil)

        guard case .freePrompt(let resolvedTemplateId) = viewModel.composition else {
            return XCTFail("Expected free-prompt composition")
        }
        XCTAssertEqual(resolvedTemplateId, QuickActionSettings.freePromptTemplateId)
        XCTAssertEqual(viewModel.freePromptBackingTemplateName, "Free Prompt Template")
        XCTAssertTrue(viewModel.freePromptUsesDedicatedTemplate)
    }

    func testFreePromptTerminalTitleUsesPromptSnippetInsteadOfBackingTemplateName() throws {
        let template = try AgentTemplate.parse(
            text: """
            ---
            id: edge-case-hunter-agent
            name: Edge Case Hunter
            scope: root
            ---
            body
            """,
            sourceURL: tmp.appendingPathComponent("edge-case-hunter-agent.md"),
            source: .builtin
        )
        let agent = TerminalAgent(
            id: "codex",
            displayName: "Codex CLI",
            icon: "terminal",
            statusKey: "codex",
            executableName: "codex",
            argv: []
        )
        let plan = AgentInvocationPlan(
            agentId: agent.id,
            resolvedModel: .default,
            resolvedReasoning: nil,
            resolvedPermission: .default,
            template: template,
            resolvedPromptBody: "Look for race conditions in the sync loop",
            resolvedUserSystemPrompt: nil,
            resolvedSystemInstructions: nil,
            reportedContextBlock: nil,
            worktreeContextBlock: nil,
            instructions: .empty,
            runCwd: URL(fileURLWithPath: "/tmp/repo"),
            workspaceId: nil,
            projectId: nil,
            branchName: nil,
            repoRootPath: "/tmp/repo",
            source: .quickActionFreePrompt,
            reasonTag: nil,
            previewSummary: AgentInvocationPlan.PreviewSummary(
                title: "Free prompt",
                snippet: nil,
                injectedAbilityNames: [],
                listedAbilityNames: [],
                referencedSkillNames: []
            )
        )
        let viewModel = QuickActionViewModel(
            templateStore: AgentTemplateStore(),
            lru: QuickActionLRUStore(defaults: UserDefaults(suiteName: defaultsSuiteName)!),
            launcher: StubQuickActionLauncher()
        )

        let title = viewModel.terminalWorkspaceTitle(for: plan, agent: agent)

        XCTAssertEqual(title, "✏️ Look for race conditions in the sync loop (Codex CLI)")
    }

    func testSelectingTemplatePreservesTypedPromptInsteadOfReplacingItWithTemplateBody() throws {
        try writeTemplate(
            named: "template.md",
            id: "edge-case-hunter-agent",
            displayName: "Edge Case Hunter",
            scope: "root",
            body: "System prompt body"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: StubQuickActionLauncher()
        )

        viewModel.promptText = "Check only payment edge cases"
        viewModel.selectTemplate(id: "edge-case-hunter-agent")

        XCTAssertEqual(viewModel.promptText, "Check only payment edge cases")
    }

    func testTemplateSubmitUsesTypedPromptAsUserPromptAndTemplateBodyAsSystemPrompt() throws {
        try writeTemplate(
            named: "template.md",
            id: "edge-case-hunter-agent",
            displayName: "Edge Case Hunter",
            scope: "root",
            body: "You are the Edge Case Hunter for {{repo_name}}."
        )

        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.selectTemplate(id: "edge-case-hunter-agent")
        viewModel.promptText = "Focus on checkout retries"

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(launcher.lastCapture?.initialPrompt, "Focus on checkout retries")
        XCTAssertEqual(
            launcher.lastCapture?.systemPrompt,
            "You are the Edge Case Hunter for {{repo_name}}."
        )
    }

    func testWorkspaceForkPrefillAllowsEmptyPrompt() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.applyPrefill(
            QuickActionPresentationRequest(
                initialSurface: .run,
                promptText: "",
                advancedTitle: "Forked Helper",
                advancedTerminalAgentId: TerminalAgent.claudeId,
                launchSource: .workspaceFork,
                reasonTag: "quickAction.freePrompt"
            )
        )

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(launcher.lastCapture?.initialPrompt, "")
        XCTAssertEqual(launcher.lastCapture?.agent.id, TerminalAgent.claudeId)
    }

    func testTargetWorkspaceWithoutProjectMetadataLaunchesInActiveProject() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )

        let tabManager = TabManager()
        let sourceWorkspace = tabManager.addWorkspace(
            workingDirectory: tmp.path,
            select: true,
            projectId: project.id
        )
        WorkspaceMetadataStore.shared.setProjectId(nil, forWorkspaceId: sourceWorkspace.id)

        let appDelegate = AppDelegate.shared ?? AppDelegate()
        let originalTabManager = appDelegate.tabManager
        let originalContexts = appDelegate.mainWindowContexts
        let window = NSWindow()
        appDelegate.tabManager = tabManager
        appDelegate.mainWindowContexts = [
            ObjectIdentifier(window): AppDelegate.MainWindowContext(
                windowId: UUID(),
                tabManager: tabManager,
                sidebarState: SidebarState(),
                sidebarSelectionState: SidebarSelectionState(),
                window: window
            )
        ]
        defer {
            appDelegate.tabManager = originalTabManager
            appDelegate.mainWindowContexts = originalContexts
        }

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: sourceWorkspace.id)
        viewModel.promptText = "Run from selected project"

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(launcher.lastCapture?.projectId, project.id)
        XCTAssertEqual(launcher.lastCapture?.cwd, project.folderPath)
    }

    func testPrefillLaunchCallbackReceivesLaunchedWorkspace() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        launcher.workspaceToReturn = Workspace(title: "Callback")
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )
        var callbackWorkspaceId: UUID?

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.applyPrefill(
            QuickActionPresentationRequest(
                initialSurface: .run,
                promptText: "Continue from here",
                advancedTerminalAgentId: TerminalAgent.claudeId,
                launchSource: .abilityCreator,
                reasonTag: "quickAction.freePrompt",
                onLaunchedWorkspace: { workspace in
                    callbackWorkspaceId = workspace.id
                }
            )
        )

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(callbackWorkspaceId, launcher.workspaceToReturn.id)
    }

    func testNewWorktreeRequestUsesActiveProjectContext() throws {
        let project = Project(name: "Repo", folderPath: tmp.path)
        ProjectStore.shared.restoreFromSidecar(
            projects: [SessionProjectSnapshot(project)],
            activeProjectId: project.id,
            openProjectIds: [project.id]
        )

        let viewModel = QuickActionViewModel(
            templateStore: AgentTemplateStore(),
            lru: QuickActionLRUStore(defaults: UserDefaults(suiteName: defaultsSuiteName)!),
            launcher: StubQuickActionLauncher()
        )

        let request = try viewModel.newWorktreeRequest()
        XCTAssertEqual(request.projectId, project.id)
    }

    func testNewWorktreeRequestWithoutProjectThrows() {
        ProjectStore.shared.restoreFromSidecar(
            projects: [],
            activeProjectId: nil,
            openProjectIds: []
        )

        let viewModel = QuickActionViewModel(
            templateStore: AgentTemplateStore(),
            lru: QuickActionLRUStore(defaults: UserDefaults(suiteName: defaultsSuiteName)!),
            launcher: StubQuickActionLauncher()
        )

        XCTAssertThrowsError(try viewModel.newWorktreeRequest()) { error in
            XCTAssertEqual(
                error as? QuickActionError,
                QuickActionError.noCurrentProject
            )
        }
    }

    func testSubmitPassesSupportedReasoningOverrideToLauncher() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.promptText = "Inspect retry behavior"
        viewModel.advancedTerminalAgentId = "codex"
        viewModel.advancedReasoning = .xhigh

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(launcher.lastCapture?.agent.id, "codex")
        XCTAssertEqual(launcher.lastCapture?.reasoning, .xhigh)
    }

    func testSubmitPassesSupportedCodexModelOverrideToLauncher() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.promptText = "Inspect model selection"
        viewModel.advancedTerminalAgentId = "codex"
        viewModel.advancedModel = .gpt54

        XCTAssertTrue(viewModel.submit())
        XCTAssertEqual(launcher.lastCapture?.agent.id, "codex")
        XCTAssertEqual(launcher.lastCapture?.model, .gpt54)
    }

    func testSwitchingToAgentWithoutReasoningResetsToDefault() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: StubQuickActionLauncher()
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.advancedTerminalAgentId = "codex"
        viewModel.advancedReasoning = .xhigh

        viewModel.advancedTerminalAgentId = "gemini"

        XCTAssertEqual(viewModel.advancedReasoning, .default)
    }

    func testSwitchingAgentsRestoresLastModelAndReasoningPerAgent() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.promptText = "First run"
        viewModel.advancedTerminalAgentId = "codex"
        viewModel.advancedModel = .gpt54
        viewModel.advancedReasoning = .xhigh
        XCTAssertTrue(viewModel.submit())

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.promptText = "Second run"
        viewModel.advancedTerminalAgentId = TerminalAgent.claudeId
        viewModel.advancedModel = .opus
        viewModel.advancedReasoning = .max
        XCTAssertTrue(viewModel.submit())

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.advancedTerminalAgentId = "codex"
        XCTAssertEqual(viewModel.advancedModel, .gpt54)
        XCTAssertEqual(viewModel.advancedReasoning, .xhigh)

        viewModel.advancedTerminalAgentId = TerminalAgent.claudeId
        XCTAssertEqual(viewModel.advancedModel, .opus)
        XCTAssertEqual(viewModel.advancedReasoning, .max)
    }

    func testSubmitIgnoresSecondLaunchWhileFirstIsStillInFlight() throws {
        try writeTemplate(
            named: "free-prompt-template.md",
            id: QuickActionSettings.freePromptTemplateId,
            displayName: "Free Prompt Template",
            scope: "root"
        )

        let templateStore = AgentTemplateStore()
        templateStore.reloadSynchronously(builtinDir: tmp, userDir: nil, projectDir: nil)

        let defaults = UserDefaults(suiteName: defaultsSuiteName)!
        defaults.removePersistentDomain(forName: defaultsSuiteName)
        let launcher = CapturingQuickActionLauncher()
        let viewModel = QuickActionViewModel(
            templateStore: templateStore,
            lru: QuickActionLRUStore(defaults: defaults),
            launcher: launcher
        )

        viewModel.onPresent(defaultTargetWorkspaceId: nil)
        viewModel.promptText = "Inspect retry behavior"

        XCTAssertTrue(viewModel.submit())
        XCTAssertFalse(viewModel.submit())
        XCTAssertEqual(launcher.launchCount, 1)
        XCTAssertTrue(viewModel.isSubmitting)
    }

    private func writeTemplate(
        named fileName: String,
        id: String,
        displayName: String,
        scope: String,
        body: String = "body"
    ) throws {
        let url = tmp.appendingPathComponent(fileName)
        let text = """
        ---
        id: \(id)
        name: \(displayName)
        scope: \(scope)
        ---
        \(body)
        """
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
}

@MainActor
private final class StubQuickActionLauncher: QuickActionLauncher {
    func launchTerminal(
        agent: TerminalAgent,
        title: String?,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        initialPrompt: String,
        projectId: UUID?,
        placementOverride: NewWorkspacePlacement?,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?,
        launchProvidedFullContext: Bool
    ) throws -> Workspace { Workspace() }
}

@MainActor
private final class CapturingQuickActionLauncher: QuickActionLauncher {
    struct Capture {
        let agent: TerminalAgent
        let initialPrompt: String
        let systemPrompt: String?
        let permission: AgentTemplate.PermissionMode?
        let cwd: String?
        let projectId: UUID?
        let model: AgentModelOption?
        let reasoning: AgentReasoningOption?
    }

    private(set) var lastCapture: Capture?
    private(set) var launchCount = 0
    var workspaceToReturn = Workspace(title: "Launched")

    func launchTerminal(
        agent: TerminalAgent,
        title: String?,
        cwd: String?,
        worktreeExpectation: TermLoopWorktreeExpectation?,
        initialPrompt: String,
        projectId: UUID?,
        placementOverride: NewWorkspacePlacement?,
        permission: AgentTemplate.PermissionMode?,
        systemPrompt: String?,
        model: AgentModelOption?,
        reasoning: AgentReasoningOption?,
        launchProvidedFullContext: Bool
    ) throws -> Workspace {
        launchCount += 1
        lastCapture = Capture(
            agent: agent,
            initialPrompt: initialPrompt,
            systemPrompt: systemPrompt,
            permission: permission,
            cwd: cwd,
            projectId: projectId,
            model: model,
            reasoning: reasoning
        )
        return workspaceToReturn
    }
}
