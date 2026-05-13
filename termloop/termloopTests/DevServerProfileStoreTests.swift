// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class DevServerProfileStoreTests: XCTestCase {
    private var tempRoot: URL!

    override func setUp() async throws {
        tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("termloop-devservers-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempRoot)
    }

    func testEmptyLoadCreatesEmptyProfileFileInMemory() {
        let store = DevServerProfileStore(projectRoot: tempRoot, projectId: UUID())
        store.loadOrCreate()

        XCTAssertNil(store.loadError)
        XCTAssertEqual(store.file.schemaVersion, DevServerProfileFile.currentSchemaVersion)
        XCTAssertEqual(store.profiles, [])
    }

    func testRoundTripProfiles() throws {
        let projectId = UUID()
        let store = DevServerProfileStore(projectRoot: tempRoot, projectId: projectId)
        store.loadOrCreate()
        let profile = try DevServerProfile(
            id: "web",
            name: "Web",
            command: "npm run dev",
            env: ["BROWSER": "none"],
            setupCommand: "npm install",
            cleanupCommand: "npm run clean",
            setupPolicy: .oncePerWorktreeProfileConfig
        )
        try store.upsert(profile)

        let reloaded = DevServerProfileStore(projectRoot: tempRoot, projectId: projectId)
        reloaded.loadOrCreate()
        XCTAssertNil(reloaded.loadError)
        XCTAssertEqual(reloaded.profile(id: "web"), profile)
    }

    func testCorruptJSONSurfacesLoadErrorWithoutThrowing() throws {
        let dir = tempRoot.appendingPathComponent(".termloop")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "{".write(to: dir.appendingPathComponent("devservers.json"), atomically: true, encoding: .utf8)

        let store = DevServerProfileStore(projectRoot: tempRoot, projectId: UUID())
        store.loadOrCreate()

        XCTAssertNotNil(store.loadError)
        XCTAssertEqual(store.profiles, [])
    }
}
