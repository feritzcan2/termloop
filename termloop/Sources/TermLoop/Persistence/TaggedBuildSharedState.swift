// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

enum TaggedBuildSharedState {
    static let canonicalTaggedBundleIdentifier = "com.termloop.app.staging.production"
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "tagged-build-shared-state"
    )

    struct SharedDefaultsDomain {
        let defaults: UserDefaults
        let domainName: String
    }

    private struct SessionArtifactRichness {
        let workspaceCount: Int
        let persistedAgentSessionCount: Int
    }

    private static let syncLock = NSLock()
    private static var installedDefaultsBridgeBundleIds: Set<String> = []
    private static var defaultsBridgeObservers: [NSObjectProtocol] = []
    private static var isSyncingUserDefaults = false

    static func prepareCurrentBuildState(
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        standardDefaults: UserDefaults = .standard,
        notificationCenter: NotificationCenter = .default,
        fileManager: FileManager = .default,
        appSupportDirectory: URL? = nil,
        sharedDefaultsFactory: @escaping (String) -> SharedDefaultsDomain? = {
            guard let defaults = UserDefaults(suiteName: $0) else { return nil }
            return SharedDefaultsDomain(defaults: defaults, domainName: $0)
        }
    ) {
        guard let currentBundleIdentifier = normalizedBundleIdentifier(bundleIdentifier),
              let sharedBundleIdentifier = sharedStateBundleIdentifier(for: currentBundleIdentifier),
              sharedBundleIdentifier != currentBundleIdentifier else {
            return
        }

        syncUserDefaultsFromSharedStateIfNeeded(
            currentBundleIdentifier: currentBundleIdentifier,
            sharedBundleIdentifier: sharedBundleIdentifier,
            standardDefaults: standardDefaults,
            sharedDefaultsFactory: sharedDefaultsFactory
        )
        installUserDefaultsBridgeIfNeeded(
            currentBundleIdentifier: currentBundleIdentifier,
            sharedBundleIdentifier: sharedBundleIdentifier,
            standardDefaults: standardDefaults,
            notificationCenter: notificationCenter,
            sharedDefaultsFactory: sharedDefaultsFactory
        )
        syncSessionArtifactsFromSharedStateIfNeeded(
            currentBundleIdentifier: currentBundleIdentifier,
            sharedBundleIdentifier: sharedBundleIdentifier,
            fileManager: fileManager,
            appSupportDirectory: appSupportDirectory
        )
    }

    static func mirrorCurrentSessionArtifactsIfNeeded(
        currentSessionURL: URL,
        bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        fileManager: FileManager = .default,
        appSupportDirectory: URL? = nil
    ) {
        guard let currentBundleIdentifier = normalizedBundleIdentifier(bundleIdentifier),
              let sharedBundleIdentifier = sharedStateBundleIdentifier(for: currentBundleIdentifier),
              sharedBundleIdentifier != currentBundleIdentifier,
              let sharedSessionURL = sessionSnapshotURL(
                  bundleIdentifier: sharedBundleIdentifier,
                  appSupportDirectory: appSupportDirectory,
                  fileManager: fileManager
              ) else {
            return
        }

        if shouldRejectMirrorBecauseCurrentArtifactsLookStale(
            currentSessionURL: currentSessionURL,
            sharedSessionURL: sharedSessionURL,
            fileManager: fileManager
        ) {
            return
        }

        if !fileManager.fileExists(atPath: currentSessionURL.path) {
            try? fileManager.removeItem(at: sharedSessionURL)
            try? fileManager.removeItem(at: TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL))
            return
        }

        syncSessionArtifact(
            currentURL: currentSessionURL,
            sharedURL: sharedSessionURL,
            preferShared: false,
            fileManager: fileManager
        )

        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)
        syncSessionArtifact(
            currentURL: currentSidecarURL,
            sharedURL: sharedSidecarURL,
            preferShared: false,
            fileManager: fileManager
        )
    }

    static func sharedStateBundleIdentifier(for bundleIdentifier: String?) -> String? {
        guard let bundleIdentifier = normalizedBundleIdentifier(bundleIdentifier) else {
            return nil
        }
        if bundleIdentifier == canonicalTaggedBundleIdentifier {
            return canonicalTaggedBundleIdentifier
        }
        // Only tagged builds should mirror into the shared canonical session.
        // Untagged debug/staging apps are often launched for ad-hoc work or
        // tests and may have a tiny fresh session; letting them participate in
        // this namespace can overwrite the canonical tagged snapshot.
        if SocketControlSettings.isTaggedDevBuild(bundleIdentifier: bundleIdentifier)
            || isTaggedStagingBuild(bundleIdentifier) {
            return canonicalTaggedBundleIdentifier
        }
        return bundleIdentifier
    }

    static func sessionSnapshotURL(
        bundleIdentifier: String,
        appSupportDirectory: URL? = nil,
        fileManager: FileManager = .default
    ) -> URL? {
        let resolvedAppSupport: URL
        if let appSupportDirectory {
            resolvedAppSupport = appSupportDirectory
        } else if let discovered = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            resolvedAppSupport = discovered
        } else {
            return nil
        }

        let safeBundleId = bundleIdentifier.replacingOccurrences(
            of: "[^A-Za-z0-9._-]",
            with: "_",
            options: .regularExpression
        )
        return resolvedAppSupport
            .appendingPathComponent("termloop", isDirectory: true)
            .appendingPathComponent("session-\(safeBundleId).json", isDirectory: false)
    }

    private static func installUserDefaultsBridgeIfNeeded(
        currentBundleIdentifier: String,
        sharedBundleIdentifier: String,
        standardDefaults: UserDefaults,
        notificationCenter: NotificationCenter,
        sharedDefaultsFactory: @escaping (String) -> SharedDefaultsDomain?
    ) {
        syncLock.lock()
        let shouldInstall = installedDefaultsBridgeBundleIds.insert(currentBundleIdentifier).inserted
        syncLock.unlock()
        guard shouldInstall else { return }

        let observer = notificationCenter.addObserver(
            forName: UserDefaults.didChangeNotification,
            object: standardDefaults,
            queue: nil
        ) { _ in
            syncUserDefaultsToSharedState(
                currentBundleIdentifier: currentBundleIdentifier,
                sharedBundleIdentifier: sharedBundleIdentifier,
                standardDefaults: standardDefaults,
                sharedDefaultsFactory: sharedDefaultsFactory
            )
        }

        syncLock.lock()
        defaultsBridgeObservers.append(observer)
        syncLock.unlock()
    }

    private static func syncUserDefaultsFromSharedStateIfNeeded(
        currentBundleIdentifier: String,
        sharedBundleIdentifier: String,
        standardDefaults: UserDefaults,
        sharedDefaultsFactory: (String) -> SharedDefaultsDomain?
    ) {
        withUserDefaultsSyncLock {
            guard let sharedDomain = sharedDefaultsFactory(sharedBundleIdentifier) else { return }

            let currentDomain = standardDefaults.persistentDomain(forName: currentBundleIdentifier) ?? [:]
            let persistedSharedDomain = sharedDomain.defaults.persistentDomain(forName: sharedDomain.domainName) ?? [:]

            if persistedSharedDomain.isEmpty {
                guard !currentDomain.isEmpty else { return }
                sharedDomain.defaults.setPersistentDomain(currentDomain, forName: sharedDomain.domainName)
                return
            }

            if !domainsEqual(currentDomain, persistedSharedDomain) {
                standardDefaults.setPersistentDomain(persistedSharedDomain, forName: currentBundleIdentifier)
            }
        }
    }

    private static func syncUserDefaultsToSharedState(
        currentBundleIdentifier: String,
        sharedBundleIdentifier: String,
        standardDefaults: UserDefaults,
        sharedDefaultsFactory: (String) -> SharedDefaultsDomain?
    ) {
        withUserDefaultsSyncLock {
            guard let sharedDomain = sharedDefaultsFactory(sharedBundleIdentifier) else { return }
            let currentDomain = standardDefaults.persistentDomain(forName: currentBundleIdentifier) ?? [:]

            if currentDomain.isEmpty {
                sharedDomain.defaults.removePersistentDomain(forName: sharedDomain.domainName)
                return
            }

            let persistedSharedDomain = sharedDomain.defaults.persistentDomain(forName: sharedDomain.domainName) ?? [:]
            if !domainsEqual(persistedSharedDomain, currentDomain) {
                sharedDomain.defaults.setPersistentDomain(currentDomain, forName: sharedDomain.domainName)
            }
        }
    }

    private static func withUserDefaultsSyncLock(_ block: () -> Void) {
        syncLock.lock()
        if isSyncingUserDefaults {
            syncLock.unlock()
            return
        }
        isSyncingUserDefaults = true
        syncLock.unlock()

        defer {
            syncLock.lock()
            isSyncingUserDefaults = false
            syncLock.unlock()
        }

        block()
    }

    private static func syncSessionArtifactsFromSharedStateIfNeeded(
        currentBundleIdentifier: String,
        sharedBundleIdentifier: String,
        fileManager: FileManager,
        appSupportDirectory: URL?
    ) {
        guard let currentSessionURL = sessionSnapshotURL(
                  bundleIdentifier: currentBundleIdentifier,
                  appSupportDirectory: appSupportDirectory,
                  fileManager: fileManager
              ),
              let sharedSessionURL = sessionSnapshotURL(
                  bundleIdentifier: sharedBundleIdentifier,
                  appSupportDirectory: appSupportDirectory,
                  fileManager: fileManager
              ) else {
            return
        }

        syncSessionArtifact(
            currentURL: currentSessionURL,
            sharedURL: sharedSessionURL,
            preferShared: true,
            fileManager: fileManager
        )

        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)
        syncSessionArtifact(
            currentURL: currentSidecarURL,
            sharedURL: sharedSidecarURL,
            preferShared: true,
            fileManager: fileManager
        )
    }

    private static func syncSessionArtifact(
        currentURL: URL,
        sharedURL: URL,
        preferShared: Bool,
        fileManager: FileManager
    ) {
        let currentExists = fileManager.fileExists(atPath: currentURL.path)
        let sharedExists = fileManager.fileExists(atPath: sharedURL.path)

        if preferShared {
            if sharedExists {
                replaceFileIfNeeded(sourceURL: sharedURL, destinationURL: currentURL, fileManager: fileManager)
            } else if currentExists {
                replaceFileIfNeeded(sourceURL: currentURL, destinationURL: sharedURL, fileManager: fileManager)
            }
            return
        }

        if currentExists {
            replaceFileIfNeeded(sourceURL: currentURL, destinationURL: sharedURL, fileManager: fileManager)
        } else if sharedExists {
            try? fileManager.removeItem(at: sharedURL)
        }
    }

    private static func replaceFileIfNeeded(
        sourceURL: URL,
        destinationURL: URL,
        fileManager: FileManager
    ) {
        guard let sourceData = try? Data(contentsOf: sourceURL) else { return }
        if let destinationData = try? Data(contentsOf: destinationURL),
           destinationData == sourceData {
            return
        }

        let directory = destinationURL.deletingLastPathComponent()
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
        try? sourceData.write(to: destinationURL, options: .atomic)
    }

    private static func shouldRejectMirrorBecauseCurrentArtifactsLookStale(
        currentSessionURL: URL,
        sharedSessionURL: URL,
        fileManager: FileManager
    ) -> Bool {
        let currentSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: currentSessionURL)
        let sharedSidecarURL = TermLoopSessionSnapshot.sidecarURL(for: sharedSessionURL)
        guard let currentRichness = sessionArtifactRichness(
                sessionURL: currentSessionURL,
                sidecarURL: currentSidecarURL,
                fileManager: fileManager
              ),
              let sharedRichness = sessionArtifactRichness(
                sessionURL: sharedSessionURL,
                sidecarURL: sharedSidecarURL,
                fileManager: fileManager
              ) else {
            return false
        }
        guard currentRichness.workspaceCount > 0,
              sharedRichness.workspaceCount > 0 else {
            return false
        }

        let workspaceRegression =
            currentRichness.workspaceCount < sharedRichness.workspaceCount
            && currentRichness.workspaceCount * 2 < sharedRichness.workspaceCount
        let persistedSessionRegression =
            sharedRichness.persistedAgentSessionCount > 0
            && currentRichness.persistedAgentSessionCount
                < sharedRichness.persistedAgentSessionCount
            && currentRichness.persistedAgentSessionCount * 2
                < sharedRichness.persistedAgentSessionCount

        guard workspaceRegression || persistedSessionRegression else {
            return false
        }

        let currentWorkspaceCount = currentRichness.workspaceCount
        let sharedWorkspaceCount = sharedRichness.workspaceCount
        let currentPersistedSessionCount = currentRichness.persistedAgentSessionCount
        let sharedPersistedSessionCount = sharedRichness.persistedAgentSessionCount
        let message =
            "mirror rejected currentWorkspaces=\(currentWorkspaceCount) "
            + "sharedWorkspaces=\(sharedWorkspaceCount) "
            + "currentPersistedSessions=\(currentPersistedSessionCount) "
            + "sharedPersistedSessions=\(sharedPersistedSessionCount)"
        logger.info("\(message, privacy: .public)")
        return true
    }

    private static func sessionArtifactRichness(
        sessionURL: URL,
        sidecarURL: URL,
        fileManager: FileManager
    ) -> SessionArtifactRichness? {
        let sessionWorkspaceCount = loadSessionWorkspaceCount(
            sessionURL: sessionURL,
            fileManager: fileManager
        )
        let sidecarRichness = loadSidecarRichness(
            sidecarURL: sidecarURL,
            fileManager: fileManager
        )

        let workspaceCount = max(sessionWorkspaceCount ?? 0, sidecarRichness?.workspaceCount ?? 0)
        let persistedAgentSessionCount = sidecarRichness?.persistedAgentSessionCount ?? 0
        guard workspaceCount > 0 || persistedAgentSessionCount > 0 else {
            return nil
        }
        return SessionArtifactRichness(
            workspaceCount: workspaceCount,
            persistedAgentSessionCount: persistedAgentSessionCount
        )
    }

    private static func loadSessionWorkspaceCount(
        sessionURL: URL,
        fileManager: FileManager
    ) -> Int? {
        guard fileManager.fileExists(atPath: sessionURL.path),
              let data = try? Data(contentsOf: sessionURL),
              let snapshot = try? JSONDecoder().decode(AppSessionSnapshot.self, from: data) else {
            return nil
        }
        return snapshot.windows.reduce(0) { partial, window in
            partial + window.tabManager.workspaces.count
        }
    }

    private static func loadSidecarRichness(
        sidecarURL: URL,
        fileManager: FileManager
    ) -> SessionArtifactRichness? {
        guard fileManager.fileExists(atPath: sidecarURL.path),
              let data = try? Data(contentsOf: sidecarURL),
              let snapshot = try? JSONDecoder().decode(TermLoopSessionSnapshot.self, from: data) else {
            return nil
        }

        let byPosition = snapshot.workspaceMetadataByPosition ?? []
        let hiddenMetadata = Array(
            snapshot.hiddenWorkspaceMetadataById?.values
                ?? Dictionary<String, WorkspaceMetadataStore.Metadata>().values
        )
        let workspaceCount = byPosition.reduce(0) { partial, window in partial + window.count }
            + hiddenMetadata.count
        let persistedAgentSessionCount = byPosition.reduce(0) { partial, window in
            partial + window.reduce(0) { count, metadata in
                count + (metadata.persistedAgentSession == nil ? 0 : 1)
            }
        } + hiddenMetadata.reduce(0) { count, metadata in
            count + (metadata.persistedAgentSession == nil ? 0 : 1)
        }
        guard workspaceCount > 0 || persistedAgentSessionCount > 0 else {
            return nil
        }
        return SessionArtifactRichness(
            workspaceCount: workspaceCount,
            persistedAgentSessionCount: persistedAgentSessionCount
        )
    }

    private static func normalizedBundleIdentifier(_ bundleIdentifier: String?) -> String? {
        guard let bundleIdentifier = bundleIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines),
              !bundleIdentifier.isEmpty else {
            return nil
        }
        return bundleIdentifier
    }

    private static func isTaggedStagingBuild(_ bundleIdentifier: String) -> Bool {
        bundleIdentifier.hasPrefix("com.termloop.app.staging.")
    }

    private static func domainsEqual(_ lhs: [String: Any], _ rhs: [String: Any]) -> Bool {
        NSDictionary(dictionary: lhs).isEqual(to: rhs)
    }
}
