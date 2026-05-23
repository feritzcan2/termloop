// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum TermLoopAppSupportFile {
    static func url(named name: String) -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        let dir = base.appendingPathComponent("TermLoop", isDirectory: true)
        let bundleId = Bundle.main.bundleIdentifier ?? "com.termloop.app"
        return dir.appendingPathComponent("\(name)-\(bundleId).json", isDirectory: false)
    }
}

@MainActor
final class WorktreeRemoteItemBindingStore: ObservableObject {
    static let shared = WorktreeRemoteItemBindingStore()

    struct Binding: Codable, Equatable, Hashable {
        var reference: RemoteWorkItemReference
        var boundAt: Date
        var updatedAt: Date
    }

    @Published private(set) var version: Int = 0

    private var bindingsByPath: [String: Binding] = [:]
    private let fileURL: URL
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private init() {
        self.fileURL = TermLoopAppSupportFile.url(named: "worktree-remote-item-bindings")
        load()
    }

    func binding(forPath path: String) -> Binding? {
        bindingsByPath[Self.normalizedPath(path)]
    }

    @discardableResult
    func bind(_ reference: RemoteWorkItemReference, forPath path: String, at date: Date = Date()) -> Bool {
        let key = Self.normalizedPath(path)
        guard !key.isEmpty else { return false }
        let prior = bindingsByPath[key]
        let next = Binding(
            reference: reference,
            boundAt: prior?.boundAt ?? date,
            updatedAt: date
        )
        guard prior != next else { return false }
        bindingsByPath[key] = next
        saveAndPublish()
        return true
    }

    @discardableResult
    func bind(snapshot: RemoteWorkItemSnapshot, forPath path: String) -> Bool {
        RemoteWorkItemSnapshotStore.shared.upsert(snapshot)
        return bind(snapshot.reference, forPath: path, at: snapshot.fetchedAt)
    }

    @discardableResult
    func clear(forPath path: String) -> Bool {
        let key = Self.normalizedPath(path)
        guard bindingsByPath.removeValue(forKey: key) != nil else { return false }
        saveAndPublish()
        return true
    }

    @discardableResult
    func copyMissingBinding(fromPath sourcePath: String?, toPath destinationPath: String) -> Bool {
        guard let sourcePath else { return false }
        let sourceKey = Self.normalizedPath(sourcePath)
        let destinationKey = Self.normalizedPath(destinationPath)
        guard sourceKey != destinationKey,
              let source = bindingsByPath[sourceKey],
              bindingsByPath[destinationKey] == nil else { return false }
        bindingsByPath[destinationKey] = source
        saveAndPublish()
        return true
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([String: Binding].self, from: data) else {
            return
        }
        bindingsByPath = decoded
    }

    private func saveAndPublish() {
        guard let data = try? encoder.encode(bindingsByPath) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: [.atomic])
        version &+= 1
    }

    static func normalizedPath(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath)
            .standardizedFileURL
            .path
    }

}

@MainActor
final class RemoteWorkItemSnapshotStore: ObservableObject {
    static let shared = RemoteWorkItemSnapshotStore()

    @Published private(set) var version: Int = 0

    private var snapshotsByKey: [String: RemoteWorkItemSnapshot] = [:]
    private let fileURL: URL
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private init() {
        self.fileURL = TermLoopAppSupportFile.url(named: "remote-work-item-snapshots")
        load()
    }

    func snapshot(for reference: RemoteWorkItemReference) -> RemoteWorkItemSnapshot? {
        snapshotsByKey[reference.storageKey]
    }

    @discardableResult
    func upsert(_ snapshot: RemoteWorkItemSnapshot) -> Bool {
        let key = snapshot.reference.storageKey
        guard snapshotsByKey[key] != snapshot else { return false }
        snapshotsByKey[key] = snapshot
        saveAndPublish()
        return true
    }

    func upsert(_ snapshots: [RemoteWorkItemSnapshot]) {
        var didChange = false
        for snapshot in snapshots {
            let key = snapshot.reference.storageKey
            guard snapshotsByKey[key] != snapshot else { continue }
            snapshotsByKey[key] = snapshot
            didChange = true
        }
        if didChange {
            saveAndPublish()
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([String: RemoteWorkItemSnapshot].self, from: data) else {
            return
        }
        snapshotsByKey = decoded
    }

    private func saveAndPublish() {
        guard let data = try? encoder.encode(snapshotsByKey) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: [.atomic])
        version &+= 1
    }
}
