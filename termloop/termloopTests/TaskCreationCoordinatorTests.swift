import XCTest
#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaskCreationCoordinatorTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tcc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func test_create_happyPath_persistsTaskAndSeedsScratchpadAndBindsWorkspace() async throws {
        let projectId = UUID()
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })
        let worktreePath = tempRoot!.appendingPathComponent("wt").path
        let spawnedWorkspaceId = UUID()

        var prepareCallCount = 0
        var preparedTitle: String?
        var preparedBranch: String?
        var preparedBaseRef: String?
        var preparedCreateIfMissing: Bool?
        var preparedTerminalAgent: String?
        var rollbackCalls: [UUID] = []
        var taskIdBinding: (workspaceId: UUID, taskId: UUID)?

        let coord = TaskCreationCoordinator(
            store: store,
            projectRootProvider: { [tempRoot] _ in tempRoot! },
            prepareWorkspace: { _, title, branch, baseRef, createIfMissing, terminalAgentId in
                prepareCallCount += 1
                preparedTitle = title
                preparedBranch = branch
                preparedBaseRef = baseRef
                preparedCreateIfMissing = createIfMissing
                preparedTerminalAgent = terminalAgentId
                return TaskCreationCoordinator.PreparedWorkspace(
                    workspaceId: spawnedWorkspaceId,
                    worktreePath: worktreePath,
                    createdWorktree: true
                )
            },
            rollbackWorkspace: { _, prepared in
                rollbackCalls.append(prepared.workspaceId)
            },
            setTaskIdOnWorkspace: { workspaceId, taskId in
                taskIdBinding = (workspaceId, taskId)
            },
            dirtyCheck: { _ in false }
        )

        let task = try await coord.create(input: .init(
            projectId: projectId,
            title: "T",
            branchMode: .new(name: "feat/x", base: "main"),
            externalLinkURL: nil,
            helperAgentId: nil,
            terminalAgentId: "claude"
        ))

        XCTAssertEqual(prepareCallCount, 1)
        XCTAssertEqual(preparedTitle, "T")
        XCTAssertEqual(preparedTerminalAgent, "claude")
        XCTAssertEqual(preparedBranch, "feat/x")
        XCTAssertEqual(preparedBaseRef, "main")
        XCTAssertEqual(preparedCreateIfMissing, true)
        XCTAssertEqual(taskIdBinding?.workspaceId, spawnedWorkspaceId)
        XCTAssertEqual(taskIdBinding?.taskId, task.id)
        XCTAssertTrue(rollbackCalls.isEmpty)
        XCTAssertEqual(store.tasks(for: projectId).map(\.id), [task.id])
        XCTAssertEqual(task.worktreePath, worktreePath)
        let scratchpad = tempRoot!
            .appendingPathComponent(".termloop/tasks/\(task.id.uuidString)/scratchpad.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: scratchpad.path))
    }

    func test_create_dirtyTree_failsBeforePrepare() async {
        let projectId = UUID()
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })

        var prepareCalled = false
        var rollbackCalled = false

        let coord = TaskCreationCoordinator(
            store: store,
            projectRootProvider: { [tempRoot] _ in tempRoot! },
            prepareWorkspace: { _, _, _, _, _, _ in
                prepareCalled = true
                return TaskCreationCoordinator.PreparedWorkspace(
                    workspaceId: UUID(),
                    worktreePath: "/tmp/wt",
                    createdWorktree: true
                )
            },
            rollbackWorkspace: { _, _ in rollbackCalled = true },
            setTaskIdOnWorkspace: { _, _ in },
            dirtyCheck: { _ in true }
        )

        do {
            _ = try await coord.create(input: .init(
                projectId: projectId,
                title: "T",
                branchMode: .new(name: "feat/x", base: "main"),
                externalLinkURL: nil,
                helperAgentId: nil,
                terminalAgentId: nil
            ))
            XCTFail("expected throw")
        } catch let error as TaskCreationCoordinator.CreationError {
            XCTAssertEqual(error, .dirtyWorkingTree)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        XCTAssertFalse(prepareCalled)
        XCTAssertFalse(rollbackCalled)
        XCTAssertTrue(store.tasks(for: projectId).isEmpty)
    }

    func test_create_prepareFailure_noRollback() async {
        let projectId = UUID()
        let store = TaskStore(projectRootProvider: { [tempRoot] _ in tempRoot! })

        var rollbackCalls: [UUID] = []
        var bindingCalled = false

        struct PrepareErr: Error {}

        let coord = TaskCreationCoordinator(
            store: store,
            projectRootProvider: { [tempRoot] _ in tempRoot! },
            prepareWorkspace: { _, _, _, _, _, _ in throw PrepareErr() },
            rollbackWorkspace: { _, prepared in rollbackCalls.append(prepared.workspaceId) },
            setTaskIdOnWorkspace: { _, _ in bindingCalled = true },
            dirtyCheck: { _ in false }
        )

        do {
            _ = try await coord.create(input: .init(
                projectId: projectId,
                title: "T",
                branchMode: .new(name: "feat/x", base: "main"),
                externalLinkURL: nil,
                helperAgentId: nil,
                terminalAgentId: nil
            ))
            XCTFail("expected throw")
        } catch is PrepareErr {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        // prepareWorkspace is contract-bound to clean up its own partial
        // state before throwing — the coordinator does not call rollback
        // for prepare failures (no PreparedWorkspace to pass).
        XCTAssertTrue(rollbackCalls.isEmpty)
        XCTAssertFalse(bindingCalled)
        XCTAssertTrue(store.tasks(for: projectId).isEmpty)
    }
}
