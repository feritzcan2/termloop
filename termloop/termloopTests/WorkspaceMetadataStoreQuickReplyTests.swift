import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class WorkspaceMetadataStoreQuickReplyTests: XCTestCase {
    func testAwaitingInputSinceRoundtrip() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)
        store.setLastMessagePreview("Hello from Claude", forWorkspaceId: wsId)
        store.setLastAttentionKindRaw(TerminalAgentAttentionKind.completion.rawValue, forWorkspaceId: wsId)

        let md = store.metadata(forWorkspaceId: wsId)
        XCTAssertEqual(md.awaitingInputSince, 1712345678)
        XCTAssertEqual(md.lastMessagePreview, "Hello from Claude")
        XCTAssertEqual(md.lastAttentionKindRaw, TerminalAgentAttentionKind.completion.rawValue)
    }

    func testClearingAwaiting() {
        let store = WorkspaceMetadataStore.shared
        let wsId = UUID()
        store.setAwaitingInputSince(1712345678, forWorkspaceId: wsId)
        store.setAwaitingInputSince(nil, forWorkspaceId: wsId)
        XCTAssertNil(store.metadata(forWorkspaceId: wsId).awaitingInputSince)
    }
}
