import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TerminalAgentRunnerForkTests: XCTestCase {
    private func runGit(_ args: [String], cwd: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = args
        process.currentDirectoryURL = cwd
        let stderr = Pipe()
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            let text = String(
                data: stderr.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? "git failed"
            XCTFail("git \(args.joined(separator: " ")) failed: \(text)")
        }
    }

    func testForkWorkspaceInheritsSourceBranchBinding() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)

        let featureBranch = "feature/fork-binding"
        let service = GitWorktreeService()
        guard let worktreePath = WorktreeResolver.path(
            projectFolder: repo.path,
            branch: featureBranch
        ) else {
            return XCTFail("expected worktree path")
        }
        try service.addCreatingBranch(
            folder: repo.path,
            path: worktreePath,
            branch: featureBranch,
            baseRef: "HEAD"
        )

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        let metadataStore = WorkspaceMetadataStore.shared
        let metadataSnapshot = metadataStore.snapshot()
        defer {
            metadataStore.restore(metadataSnapshot)
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
            try? FileManager.default.removeItem(at: tmp)
        }

        let project = try projectStore.create(
            name: "fork-workspace-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        let tabManager = TabManager()
        let source = tabManager.addWorkspace(
            title: "Source",
            workingDirectory: worktreePath,
            select: true,
            projectId: project.id,
            terminalAgentId: "claude"
        )
        metadataStore.setBranch(featureBranch, for: source)
        metadataStore.setWorktreeBaselineHead("deadbeef", forWorkspaceId: source.id)

        guard let agent = TerminalAgentRegistry.shared.agent(id: "codex") else {
            return XCTFail("expected codex agent")
        }

        _ = try TerminalAgentLifecycle.forkWorkspace(
            tabManager: tabManager,
            from: source,
            with: agent,
            initialPrompt: "Continue from here."
        )

        guard let forked = tabManager.tabs.last else {
            return XCTFail("expected forked workspace")
        }

        XCTAssertNotEqual(forked.id, source.id)
        XCTAssertEqual(metadataStore.branch(for: forked), featureBranch)
        XCTAssertEqual(
            metadataStore.worktreeBaselineHead(for: forked),
            "deadbeef"
        )
        XCTAssertEqual(forked.currentDirectory, worktreePath)
    }

    func testSpawnClaudeInheritsWorktreeBindingMetadata() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: tmp)
        try runGit(["config", "user.email", "tests@example.com"], cwd: tmp)
        try runGit(["config", "user.name", "Tests"], cwd: tmp)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: tmp)

        let metadataStore = WorkspaceMetadataStore.shared
        let metadataSnapshot = metadataStore.snapshot()
        defer { metadataStore.restore(metadataSnapshot) }

        let tabManager = TabManager()
        let expectation = TermLoopWorktreeExpectation(
            path: tmp.path,
            branch: "feature/spawn-claude"
        )

        guard let claudeAgent = TerminalAgentRegistry.shared.agent(id: "claude") else {
            return XCTFail("expected claude agent")
        }
        let workspace = try TerminalAgentLifecycle.createFreshWorkspace(
            tabManager: tabManager,
            agent: claudeAgent,
            title: "Claude Worktree",
            cwd: tmp.path,
            worktreeExpectation: expectation,
            initialPrompt: "Read and continue.",
            permission: .bypassPermissions
        )

        XCTAssertEqual(metadataStore.branch(for: workspace), expectation.branch)
        XCTAssertNotNil(metadataStore.worktreeBaselineHead(for: workspace))
    }

    func testSpawnTerminalAgentInheritsWorktreeBindingMetadata() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let featureBranch = "feature/terminal-agent"
        let service = GitWorktreeService()
        guard let worktreePath = WorktreeResolver.path(
            projectFolder: repo.path,
            branch: featureBranch
        ) else {
            return XCTFail("expected worktree path")
        }
        try service.addCreatingBranch(
            folder: repo.path,
            path: worktreePath,
            branch: featureBranch,
            baseRef: "HEAD"
        )

        let metadataStore = WorkspaceMetadataStore.shared
        let metadataSnapshot = metadataStore.snapshot()
        defer { metadataStore.restore(metadataSnapshot) }

        let tabManager = TabManager()
        guard let agent = TerminalAgentRegistry.shared.agent(id: "codex") else {
            return XCTFail("expected codex agent")
        }

        let workspace = try TerminalAgentLifecycle.createFreshWorkspace(
            tabManager: tabManager,
            agent: agent,
            title: "Codex Worktree",
            cwd: worktreePath,
            worktreeExpectation: TermLoopWorktreeExpectation(
                path: worktreePath,
                branch: featureBranch
            ),
            initialPrompt: "Continue"
        )

        XCTAssertEqual(metadataStore.branch(for: workspace), featureBranch)
        XCTAssertNotNil(metadataStore.worktreeBaselineHead(for: workspace))
        XCTAssertEqual(workspace.currentDirectory, worktreePath)
    }

    func testAttachedWorkspaceSpawnFailsClosedWhenWorktreeBranchDrifts() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let expectedBranch = "feature/expected"
        let service = GitWorktreeService()
        let worktreePath = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: expectedBranch)
        )
        try service.addCreatingBranch(
            folder: repo.path,
            path: worktreePath,
            branch: expectedBranch,
            baseRef: "HEAD"
        )
        try runGit(["switch", "-q", "-c", "feature/other"], cwd: URL(fileURLWithPath: worktreePath))

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        let metadataStore = WorkspaceMetadataStore.shared
        let metadataSnapshot = metadataStore.snapshot()
        defer {
            metadataStore.restore(metadataSnapshot)
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        let project = try projectStore.create(
            name: "drift-workspace-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        let workspace = TabManager().addWorkspace(
            title: "Drifted",
            workingDirectory: worktreePath,
            select: true,
            projectId: project.id
        )
        metadataStore.setBranch(expectedBranch, worktreePath: worktreePath, for: workspace)

        XCTAssertThrowsError(try workspace.termLoopSpawnCwd()) { error in
            guard case WorktreeError.worktreeMissingOnDisk = error else {
                return XCTFail("expected fail-closed worktree error, got \(error)")
            }
        }
        XCTAssertNil(workspace.termLoopPresentationCwd())
    }

    func testAttachedWorkspaceSpawnFailsClosedWhenWorktreeDetached() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let expectedBranch = "feature/detached"
        let service = GitWorktreeService()
        let worktreePath = try XCTUnwrap(
            WorktreeResolver.path(projectFolder: repo.path, branch: expectedBranch)
        )
        try service.addCreatingBranch(
            folder: repo.path,
            path: worktreePath,
            branch: expectedBranch,
            baseRef: "HEAD"
        )
        try runGit(["checkout", "-q", "--detach", "HEAD"], cwd: URL(fileURLWithPath: worktreePath))

        let projectStore = ProjectStore.shared
        let projectSnapshot = projectStore.sessionSnapshot
        let activeProjectId = projectStore.activeProjectId
        let openProjectIds = projectStore.openProjectIds
        let metadataStore = WorkspaceMetadataStore.shared
        let metadataSnapshot = metadataStore.snapshot()
        defer {
            metadataStore.restore(metadataSnapshot)
            projectStore.restoreFromSidecar(
                projects: projectSnapshot,
                activeProjectId: activeProjectId,
                openProjectIds: openProjectIds
            )
        }

        let project = try projectStore.create(
            name: "detached-workspace-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        let workspace = TabManager().addWorkspace(
            title: "Detached",
            workingDirectory: worktreePath,
            select: true,
            projectId: project.id
        )
        metadataStore.setBranch(expectedBranch, worktreePath: worktreePath, for: workspace)

        XCTAssertThrowsError(try workspace.termLoopSpawnCwd()) { error in
            guard case WorktreeError.worktreeMissingOnDisk = error else {
                return XCTFail("expected fail-closed worktree error, got \(error)")
            }
        }
        XCTAssertNil(workspace.termLoopPresentationCwd())
    }
}
