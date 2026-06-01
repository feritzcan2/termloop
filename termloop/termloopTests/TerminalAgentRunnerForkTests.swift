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

    func testCachedWorktreeStatusDetectsExternalBranchSwitchWithStaleRegistry() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)
        defer {
            WorktreeRegistry.shared.invalidate(projectFolder: repo.path)
            try? FileManager.default.removeItem(at: tmp)
        }

        let expectedBranch = "feature/expected"
        let observedBranch = "feature/other"
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
        let staleEntries = try service.list(in: repo.path)
        WorktreeRegistry.shared.record(projectFolder: repo.path, entries: staleEntries)
        try runGit(["switch", "-q", "-c", observedBranch], cwd: URL(fileURLWithPath: worktreePath))

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
            name: "stale-registry-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        let workspace = TabManager().addWorkspace(
            title: "Drifted",
            workingDirectory: worktreePath,
            select: true,
            projectId: project.id
        )
        metadataStore.setBranch(expectedBranch, worktreePath: worktreePath, for: workspace)

        let status = try XCTUnwrap(workspace.termLoopCachedWorktreeStatus(maximumAge: 60))
        XCTAssertEqual(status.kind, .branchDrift)
        XCTAssertEqual(status.expectedBranch, expectedBranch)
        XCTAssertEqual(status.observedRef, .branch(observedBranch))
        XCTAssertFalse(status.permitsAgentLaunch)
    }

    func testCachedWorktreeStatusDetectsExternalDetachedHeadWithoutRegistrySnapshot() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let repo = tmp.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try runGit(["init", "-q", "-b", "main"], cwd: repo)
        try runGit(["config", "user.email", "tests@example.com"], cwd: repo)
        try runGit(["config", "user.name", "Tests"], cwd: repo)
        try runGit(["commit", "--allow-empty", "-q", "-m", "init"], cwd: repo)
        defer {
            WorktreeRegistry.shared.invalidate(projectFolder: repo.path)
            try? FileManager.default.removeItem(at: tmp)
        }

        let expectedBranch = "feature/detached-live"
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
        WorktreeRegistry.shared.invalidate(projectFolder: repo.path)
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
            name: "detached-live-\(UUID().uuidString.prefix(6))",
            folderPath: repo.path
        )
        let workspace = TabManager().addWorkspace(
            title: "Detached",
            workingDirectory: worktreePath,
            select: true,
            projectId: project.id
        )
        metadataStore.setBranch(expectedBranch, worktreePath: worktreePath, for: workspace)

        let status = try XCTUnwrap(workspace.termLoopCachedWorktreeStatus(maximumAge: 60))
        XCTAssertEqual(status.kind, .branchDrift)
        guard case .detached? = status.observedRef else {
            return XCTFail("expected detached observed ref, got \(String(describing: status.observedRef))")
        }
        XCTAssertFalse(status.permitsAgentLaunch)
    }
}

final class GitWorktreeServiceRemovalTests: XCTestCase {
    func testExistingUsableWorktreePrunesMissingRegistration() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("git-worktree-stale-\(UUID().uuidString)", isDirectory: true)
        let repo = root.appendingPathComponent("repo", isDirectory: true)
        let missing = repo
            .appendingPathComponent(".termloop-worktrees", isDirectory: true)
            .appendingPathComponent("feature__gone", isDirectory: true)
        let state = root.appendingPathComponent("state")
        defer { try? fileManager.removeItem(at: root) }

        try fileManager.createDirectory(at: repo, withIntermediateDirectories: true)
        try "stale".write(to: state, atomically: true, encoding: .utf8)

        let fakeGit = root.appendingPathComponent("git")
        let script = """
        #!/bin/sh
        state="\(state.path)"
        if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
          printf 'worktree %s\\nHEAD abc123\\nbranch refs/heads/main\\n\\n' "$PWD"
          if [ "$(cat "$state")" = "stale" ]; then
            printf 'worktree %s\\nHEAD def456\\nbranch refs/heads/feature/gone\\nprunable gitdir file points to non-existent location\\n\\n' "\(missing.path)"
          fi
          exit 0
        fi
        if [ "$1" = "worktree" ] && [ "$2" = "prune" ]; then
          printf 'pruned' > "$state"
          exit 0
        fi
        echo "unexpected git $*" >&2
        exit 2
        """
        try script.write(to: fakeGit, atomically: true, encoding: .utf8)
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: fakeGit.path
        )

        let entry = try GitWorktreeService(gitPath: fakeGit.path)
            .existingUsableWorktree(in: repo.path, branch: "feature/gone")

        XCTAssertNil(entry)
        XCTAssertEqual(try String(contentsOf: state, encoding: .utf8), "pruned")
    }

    func testRemoveCleansFilesystemWhenGitAlreadyUnregisteredWorktree() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("git-worktree-remove-\(UUID().uuidString)", isDirectory: true)
        let repo = root.appendingPathComponent("repo", isDirectory: true)
        let worktree = repo
            .appendingPathComponent(".termloop-worktrees", isDirectory: true)
            .appendingPathComponent("feature__leftover", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }

        try fileManager.createDirectory(at: worktree, withIntermediateDirectories: true)
        try "leftover".write(
            to: worktree.appendingPathComponent(".DS_Store"),
            atomically: true,
            encoding: .utf8
        )

        let fakeGit = root.appendingPathComponent("git")
        let script = """
        #!/bin/sh
        if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
          printf 'worktree %s\\nHEAD abc123\\nbranch refs/heads/main\\n\\n' "$PWD"
          exit 0
        fi
        if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
          target="$3"
          if [ "$3" = "--force" ]; then target="$4"; fi
          echo "error: failed to delete '$target': Directory not empty" >&2
          exit 1
        fi
        echo "unexpected git $*" >&2
        exit 2
        """
        try script.write(to: fakeGit, atomically: true, encoding: .utf8)
        try fileManager.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: fakeGit.path
        )

        try GitWorktreeService(gitPath: fakeGit.path).remove(
            folder: repo.path,
            path: worktree.path,
            force: true
        )

        XCTAssertFalse(fileManager.fileExists(atPath: worktree.path))
    }
}
