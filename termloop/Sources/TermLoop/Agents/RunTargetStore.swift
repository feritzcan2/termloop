// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class RunTargetStore: ObservableObject {
    static let shared = RunTargetStore()

    struct RunTarget: Codable, Equatable, Hashable, Identifiable {
        let id: String
        let label: String
        let status: String?
        let url: String?
        let reportedAt: Date

        var displayLabel: String {
            guard let status, !status.isEmpty else { return label }
            return "\(label) · \(status)"
        }

        var destinationURL: URL? {
            guard let url, !url.isEmpty else { return nil }
            return URL(string: url)
        }

        static func sameMaterial(_ lhs: Self, _ rhs: Self) -> Bool {
            lhs.id == rhs.id
                && lhs.label == rhs.label
                && lhs.status == rhs.status
                && lhs.url == rhs.url
        }
    }

    @Published private(set) var version: Int = 0

    private var targetsByPath: [String: [String: RunTarget]] = [:]
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
        self.fileURL = TermLoopAppSupportFile.url(named: "run-targets")
        load()
    }

    func targets(forPath path: String) -> [RunTarget] {
        let key = WorktreeRemoteItemBindingStore.normalizedPath(path)
        guard let values = targetsByPath[key] else { return [] }
        return values.values.sorted { $0.id < $1.id }
    }

    @discardableResult
    func setTargets(_ targets: [RunTarget], forPath path: String) -> Bool {
        let key = WorktreeRemoteItemBindingStore.normalizedPath(path)
        guard !key.isEmpty else { return false }
        let prior = targetsByPath[key] ?? [:]
        let next = Dictionary(uniqueKeysWithValues: targets.map { ($0.id, $0) })
        if prior.count == next.count {
            let allSame = next.allSatisfy { id, target in
                guard let existing = prior[id] else { return false }
                return RunTarget.sameMaterial(existing, target)
            }
            if allSame { return false }
        }
        if next.isEmpty {
            targetsByPath.removeValue(forKey: key)
        } else {
            targetsByPath[key] = next
        }
        saveAndPublish()
        return true
    }

    @discardableResult
    func removeTarget(id: String, forPath path: String) -> Bool {
        let key = WorktreeRemoteItemBindingStore.normalizedPath(path)
        guard var targets = targetsByPath[key],
              targets.removeValue(forKey: id) != nil else { return false }
        if targets.isEmpty {
            targetsByPath.removeValue(forKey: key)
        } else {
            targetsByPath[key] = targets
        }
        saveAndPublish()
        return true
    }

    @discardableResult
    func copyMissingTargets(fromPath sourcePath: String?, toPath destinationPath: String) -> Bool {
        guard let sourcePath else { return false }
        let sourceKey = WorktreeRemoteItemBindingStore.normalizedPath(sourcePath)
        let destinationKey = WorktreeRemoteItemBindingStore.normalizedPath(destinationPath)
        guard sourceKey != destinationKey,
              let source = targetsByPath[sourceKey],
              !source.isEmpty else { return false }
        var destination = targetsByPath[destinationKey] ?? [:]
        var didChange = false
        for (id, target) in source where destination[id] == nil {
            destination[id] = target
            didChange = true
        }
        guard didChange else { return false }
        targetsByPath[destinationKey] = destination
        saveAndPublish()
        return true
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([String: [String: RunTarget]].self, from: data) else {
            return
        }
        targetsByPath = decoded
    }

    private func saveAndPublish() {
        guard let data = try? encoder.encode(targetsByPath) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: [.atomic])
        version &+= 1
    }

}
