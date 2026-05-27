import XCTest

#if canImport(TermLoop_DEV)
@testable import TermLoop_DEV
#elseif canImport(TermLoop)
@testable import TermLoop
#endif

@MainActor
final class TaggedBuildSharedStateTests: XCTestCase {
    private func makeAppSessionSnapshot(workspaceCount: Int) -> AppSessionSnapshot {
        let workspaces = (0..<workspaceCount).map { index in
            SessionWorkspaceSnapshot(
                processTitle: "Terminal \(index)",
                customTitle: nil,
                customColor: nil,
                isPinned: false,
                currentDirectory: "/tmp",
                focusedPanelId: nil,
                layout: .pane(SessionPaneLayoutSnapshot(panelIds: [], selectedPanelId: nil)),
                panels: [],
                statusEntries: [],
                logEntries: [],
                progress: nil,
                gitBranch: nil
            )
        }
        return AppSessionSnapshot(
            version: SessionSnapshotSchema.currentVersion,
            createdAt: Date().timeIntervalSince1970,
            windows: [
                SessionWindowSnapshot(
                    frame: nil,
                    display: nil,
                    tabManager: SessionTabManagerSnapshot(
                        selectedWorkspaceIndex: workspaceCount > 0 ? 0 : nil,
                        workspaces: workspaces
                    ),
                    sidebar: SessionSidebarSnapshot(isVisible: true, selection: .tabs, width: 240)
                )
            ]
        )
    }

    private func makeSidecarSnapshot(workspaceCount: Int, persistedSessionCount: Int) -> TermLoopSessionSnapshot {
        let metadata = (0..<workspaceCount).map { index in
            var metadata = WorkspaceMetadataStore.Metadata()
            metadata.terminalAgentId = index < persistedSessionCount ? "codex" : "claude"
            metadata.persistedAgentSession = index < persistedSessionCount
                ? PersistedAgentSession(
                    agentId: "codex",
                    sessionId: "sess-\(index)",
                    cwd: "/tmp/\(index)",
                    updatedAt: nil
                )
                : nil
            return metadata
        }
        return TermLoopSessionSnapshot(
            version: 5,
            projects: [],
            activeProjectId: nil,
            openProjectIds: [],
            workspaceMetadataByPosition: [metadata]
        )
    }

    func testTaggedBuildsUseProductionStagingSharedNamespace() {
        XCTAssertEqual(
            TaggedBuildSharedState.sharedStateBundleIdentifier(for: "com.termloop.app.debug.feature-x"),
            TaggedBuildSharedState.canonicalTaggedBundleIdentifier
        )
        XCTAssertEqual(
            TaggedBuildSharedState.sharedStateBundleIdentifier(for: "com.termloop.app.staging.qa"),
            TaggedBuildSharedState.canonicalTaggedBundleIdentifier
        )
        XCTAssertEqual(
            TaggedBuildSharedState.sharedStateBundleIdentifier(for: "com.termloop.app"),
            "com.termloop.app"
        )
    }

    func testUntaggedDebugAndStagingBuildsDoNotUseSharedNamespace() {
        XCTAssertEqual(
            TaggedBuildSharedState.sharedStateBundleIdentifier(for: "com.termloop.app.debug"),
            "com.termloop.app.debug"
        )
        XCTAssertEqual(
            TaggedBuildSharedState.sharedStateBundleIdentifier(for: "com.termloop.app.staging"),
            "com.termloop.app.staging"
        )
    }

    func testPrepareCurrentBuildStateHydratesDefaultsFromSharedDomainAndMirrorsChangesBack() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let currentSuiteName = "TaggedBuildCurrent.\(UUID().uuidString)"
        let sharedSuiteName = "TaggedBuildShared.\(UUID().uuidString)"
        let sharedDomainName = "TaggedBuildSharedDomain.\(UUID().uuidString)"
        let notificationCenter = NotificationCenter()

        let currentDefaults = try XCTUnwrap(UserDefaults(suiteName: currentSuiteName))
        let sharedDefaults = try XCTUnwrap(UserDefaults(suiteName: sharedSuiteName))
        currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
        sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        defer {
            currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
            sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        }

        sharedDefaults.setPersistentDomain(
            [
                "workspaceTitlebarVisible": false,
                "termLoop.sidebarTab": "work",
            ],
            forName: sharedDomainName
        )

        TaggedBuildSharedState.prepareCurrentBuildState(
            bundleIdentifier: currentBundleIdentifier,
            standardDefaults: currentDefaults,
            notificationCenter: notificationCenter,
            sharedDefaultsFactory: { bundleIdentifier in
                guard bundleIdentifier == TaggedBuildSharedState.canonicalTaggedBundleIdentifier else {
                    return nil
                }
                return TaggedBuildSharedState.SharedDefaultsDomain(
                    defaults: sharedDefaults,
                    domainName: sharedDomainName
                )
            }
        )

        let hydratedDomain = currentDefaults.persistentDomain(forName: currentBundleIdentifier) ?? [:]
        XCTAssertEqual(hydratedDomain["workspaceTitlebarVisible"] as? Bool, false)
        XCTAssertEqual(hydratedDomain["termLoop.sidebarTab"] as? String, "work")

        currentDefaults.setPersistentDomain(
            [
                "workspaceTitlebarVisible": true,
                "termLoop.sidebarTab": "docs",
            ],
            forName: currentBundleIdentifier
        )
        notificationCenter.post(name: UserDefaults.didChangeNotification, object: currentDefaults)

        let mirroredDomain = sharedDefaults.persistentDomain(forName: sharedDomainName) ?? [:]
        XCTAssertEqual(mirroredDomain["workspaceTitlebarVisible"] as? Bool, true)
        XCTAssertEqual(mirroredDomain["termLoop.sidebarTab"] as? String, "docs")
    }

    func testPrepareCurrentBuildStateMirrorsChangesWhenDefaultsNotificationHasNoObject() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let currentSuiteName = "TaggedBuildCurrent.\(UUID().uuidString)"
        let sharedSuiteName = "TaggedBuildShared.\(UUID().uuidString)"
        let sharedDomainName = "TaggedBuildSharedDomain.\(UUID().uuidString)"
        let notificationCenter = NotificationCenter()

        let currentDefaults = try XCTUnwrap(UserDefaults(suiteName: currentSuiteName))
        let sharedDefaults = try XCTUnwrap(UserDefaults(suiteName: sharedSuiteName))
        currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
        sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        defer {
            currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
            sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        }

        sharedDefaults.setPersistentDomain(
            [AppearanceSettings.appearanceModeKey: AppearanceMode.system.rawValue],
            forName: sharedDomainName
        )

        TaggedBuildSharedState.prepareCurrentBuildState(
            bundleIdentifier: currentBundleIdentifier,
            standardDefaults: currentDefaults,
            notificationCenter: notificationCenter,
            sharedDefaultsFactory: { bundleIdentifier in
                guard bundleIdentifier == TaggedBuildSharedState.canonicalTaggedBundleIdentifier else {
                    return nil
                }
                return TaggedBuildSharedState.SharedDefaultsDomain(
                    defaults: sharedDefaults,
                    domainName: sharedDomainName
                )
            }
        )

        currentDefaults.setPersistentDomain(
            [AppearanceSettings.appearanceModeKey: AppearanceMode.dark.rawValue],
            forName: currentBundleIdentifier
        )
        notificationCenter.post(name: UserDefaults.didChangeNotification, object: nil)

        let mirroredDomain = sharedDefaults.persistentDomain(forName: sharedDomainName) ?? [:]
        XCTAssertEqual(mirroredDomain[AppearanceSettings.appearanceModeKey] as? String, AppearanceMode.dark.rawValue)
    }

    func testMirrorCurrentUserDefaultsCopiesCurrentDomainToSharedDomain() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let currentSuiteName = "TaggedBuildCurrent.\(UUID().uuidString)"
        let sharedSuiteName = "TaggedBuildShared.\(UUID().uuidString)"
        let sharedDomainName = "TaggedBuildSharedDomain.\(UUID().uuidString)"

        let currentDefaults = try XCTUnwrap(UserDefaults(suiteName: currentSuiteName))
        let sharedDefaults = try XCTUnwrap(UserDefaults(suiteName: sharedSuiteName))
        currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
        sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        defer {
            currentDefaults.removePersistentDomain(forName: currentBundleIdentifier)
            sharedDefaults.removePersistentDomain(forName: sharedDomainName)
        }

        sharedDefaults.setPersistentDomain(
            [AppearanceSettings.appearanceModeKey: AppearanceMode.system.rawValue],
            forName: sharedDomainName
        )
        currentDefaults.setPersistentDomain(
            [AppearanceSettings.appearanceModeKey: AppearanceMode.dark.rawValue],
            forName: currentBundleIdentifier
        )

        TaggedBuildSharedState.mirrorCurrentUserDefaultsIfNeeded(
            bundleIdentifier: currentBundleIdentifier,
            standardDefaults: currentDefaults,
            sharedDefaultsFactory: { bundleIdentifier in
                guard bundleIdentifier == TaggedBuildSharedState.canonicalTaggedBundleIdentifier else {
                    return nil
                }
                return TaggedBuildSharedState.SharedDefaultsDomain(
                    defaults: sharedDefaults,
                    domainName: sharedDomainName
                )
            }
        )

        let mirroredDomain = sharedDefaults.persistentDomain(forName: sharedDomainName) ?? [:]
        XCTAssertEqual(mirroredDomain[AppearanceSettings.appearanceModeKey] as? String, AppearanceMode.dark.rawValue)
    }

    func testPrepareCurrentBuildStateCopiesSharedSessionArtifactsIntoCurrentTag() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tagged-shared-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let sharedSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: TaggedBuildSharedState.canonicalTaggedBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)
        try FileManager.default.createDirectory(
            at: sharedSessionURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("shared-session".utf8).write(to: sharedSessionURL, options: .atomic)
        try Data("shared-sidecar".utf8).write(to: sharedSidecarURL, options: .atomic)

        TaggedBuildSharedState.prepareCurrentBuildState(
            bundleIdentifier: currentBundleIdentifier,
            notificationCenter: NotificationCenter(),
            fileManager: .default,
            appSupportDirectory: tempDir,
            sharedDefaultsFactory: { _ in nil }
        )

        let currentSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: currentBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)

        XCTAssertEqual(try Data(contentsOf: currentSessionURL), Data("shared-session".utf8))
        XCTAssertEqual(try Data(contentsOf: currentSidecarURL), Data("shared-sidecar".utf8))
    }

    func testMirrorCurrentSessionArtifactsRemovesSharedArtifactsWhenCurrentSnapshotIsGone() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tagged-shared-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let currentSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: currentBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)
        let sharedSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: TaggedBuildSharedState.canonicalTaggedBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)

        try FileManager.default.createDirectory(
            at: currentSidecarURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("stale-current-sidecar".utf8).write(to: currentSidecarURL, options: .atomic)
        try Data("shared-session".utf8).write(to: sharedSessionURL, options: .atomic)
        try Data("shared-sidecar".utf8).write(to: sharedSidecarURL, options: .atomic)

        TaggedBuildSharedState.mirrorCurrentSessionArtifactsIfNeeded(
            currentSessionURL: currentSessionURL,
            bundleIdentifier: currentBundleIdentifier,
            appSupportDirectory: tempDir
        )

        XCTAssertFalse(FileManager.default.fileExists(atPath: sharedSessionURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: sharedSidecarURL.path))
    }

    func testMirrorCurrentSessionArtifactsRejectsMuchSmallerCurrentSnapshot() throws {
        let currentBundleIdentifier = "com.termloop.app.debug.tests-\(UUID().uuidString)"
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tagged-shared-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let currentSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: currentBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)
        let sharedSessionURL = try XCTUnwrap(
            TaggedBuildSharedState.sessionSnapshotURL(
                bundleIdentifier: TaggedBuildSharedState.canonicalTaggedBundleIdentifier,
                appSupportDirectory: tempDir
            )
        )
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)

        try FileManager.default.createDirectory(
            at: currentSessionURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        let currentSession = makeAppSessionSnapshot(workspaceCount: 1)
        let sharedSession = makeAppSessionSnapshot(workspaceCount: 6)
        try JSONEncoder().encode(currentSession).write(to: currentSessionURL, options: .atomic)
        try JSONEncoder().encode(sharedSession).write(to: sharedSessionURL, options: .atomic)

        let currentSidecar = makeSidecarSnapshot(workspaceCount: 1, persistedSessionCount: 0)
        let sharedSidecar = makeSidecarSnapshot(workspaceCount: 6, persistedSessionCount: 4)
        let sharedSessionData = try Data(contentsOf: sharedSessionURL)
        let sharedSidecarData = try JSONEncoder().encode(sharedSidecar)
        try JSONEncoder().encode(currentSidecar).write(to: currentSidecarURL, options: .atomic)
        try sharedSidecarData.write(to: sharedSidecarURL, options: .atomic)

        TaggedBuildSharedState.mirrorCurrentSessionArtifactsIfNeeded(
            currentSessionURL: currentSessionURL,
            bundleIdentifier: currentBundleIdentifier,
            appSupportDirectory: tempDir
        )

        XCTAssertEqual(try Data(contentsOf: sharedSessionURL), sharedSessionData)
        XCTAssertEqual(try Data(contentsOf: sharedSidecarURL), sharedSidecarData)
    }
}
