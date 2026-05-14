// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class DevServerSetupStateStoreTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("termloop-devserver-setup-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testSetupCompletionIsKeyedByProfileWorktreeAndConfigHash() throws {
        let profile = try DevServerProfile(
            id: "web",
            name: "Web",
            command: "npm run dev",
            setupCommand: "npm install"
        )
        let store = DevServerSetupStateStore(projectRoot: tempRoot)

        XCTAssertTrue(store.needsSetup(profile: profile, worktreePath: "/tmp/worktree-a"))
        try store.markComplete(profile: profile, worktreePath: "/tmp/worktree-a")
        XCTAssertFalse(store.needsSetup(profile: profile, worktreePath: "/tmp/worktree-a"))
        XCTAssertTrue(store.needsSetup(profile: profile, worktreePath: "/tmp/worktree-b"))

        let changed = try DevServerProfile(
            id: "web",
            name: "Web",
            command: "npm run dev",
            setupCommand: "pnpm install"
        )
        XCTAssertTrue(store.needsSetup(profile: changed, worktreePath: "/tmp/worktree-a"))
    }
}
