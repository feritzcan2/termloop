import XCTest
import Foundation

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

/// Verifies that `TabManager.addWorkspace(taskId:)` routes the provided
/// task id into `WorkspaceMetadataStore` via the existing termloop-hook
/// block, and that callers that omit `taskId` leave the metadata entry
/// at its default (`nil`).
@MainActor
final class TabManagerAddWorkspaceTaskIdTests: XCTestCase {

    func test_addWorkspace_withTaskId_persistsToMetadataStore() {
        let manager = TabManager()
        let taskId = UUID()

        let workspace = manager.addWorkspace(taskId: taskId)

        XCTAssertEqual(
            WorkspaceMetadataStore.shared.taskId(for: workspace.id),
            taskId,
            "addWorkspace(taskId:) should stamp the workspace metadata with the provided taskId"
        )
    }

    func test_addWorkspace_withoutTaskId_metadataNil() {
        let manager = TabManager()

        let workspace = manager.addWorkspace()

        XCTAssertNil(
            WorkspaceMetadataStore.shared.taskId(for: workspace.id),
            "addWorkspace() without a taskId argument should leave metadata taskId nil"
        )
    }
}
