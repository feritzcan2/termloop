// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

public enum TaskBoardStoreError: Error, Equatable {
    case unsupportedSchema(found: Int, supported: Int)
    case decodingFailed(String)
    case writeFailed(String)
}

@MainActor
public final class TaskBoardStore: ObservableObject {
    public let projectRoot: URL
    public let projectId: UUID

    /// Normalized board view — exactly five columns in declared order.
    @Published public private(set) var columnSnapshots: [TaskColumnSnapshot] = []

    private var file: TaskBoardFile = TaskBoardFile()
    private var saveDebounce: DispatchWorkItem?
    private let saveQueue = DispatchQueue(label: "com.termloop.tasks.board-store.save", qos: .utility)
    private static let rankRebalanceLengthThreshold = 12

    public init(projectRoot: URL, projectId: UUID) {
        self.projectRoot = projectRoot
        self.projectId = projectId
    }

    public func loadOrCreate() throws {
        let url = boardFileURL()
        if FileManager.default.fileExists(atPath: url.path) {
            let data = try Data(contentsOf: url)
            let schemaVersion: Int
            do {
                schemaVersion = try JSONDecoder.tasks.decode(TaskBoardSchemaHeader.self, from: data).schemaVersion
            } catch {
                throw TaskBoardStoreError.decodingFailed(String(describing: error))
            }
            guard schemaVersion <= TaskBoardFile.currentSchemaVersion else {
                throw TaskBoardStoreError.unsupportedSchema(
                    found: schemaVersion,
                    supported: TaskBoardFile.currentSchemaVersion
                )
            }
            let decoded: TaskBoardFile
            do {
                decoded = try JSONDecoder.tasks.decode(TaskBoardFile.self, from: data)
            } catch {
                throw TaskBoardStoreError.decodingFailed(String(describing: error))
            }
            file = decoded
        } else {
            file = TaskBoardFile()
        }
        rebuildSnapshots()
    }

    public func fileSnapshot() -> TaskBoardFile { file }

    /// Synchronous, lifecycle-critical save. Skips debounce.
    public func saveNow() throws {
        saveDebounce?.cancel()
        saveDebounce = nil
        try writeAtomically()
    }

    /// Used by text-only mutations (brief). Coalesces rapid edits.
    public func scheduleSave(after seconds: TimeInterval = 0.5) {
        saveDebounce?.cancel()
        let snapshot = file
        let url = boardFileURL()
        var work: DispatchWorkItem!
        work = DispatchWorkItem {
            guard !work.isCancelled else { return }
            do {
                try Self.write(snapshot, to: url)
            } catch {
                #if DEBUG
                print("TaskBoardStore.scheduleSave write failed: \(error)")
                #endif
            }
        }
        saveDebounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self, weak work] in
            guard let self, let work, !work.isCancelled else { return }
            self.saveQueue.async(execute: work)
        }
    }

    // MARK: - Internal mutators (TaskLifecycleCoordinator only)

    /// Apply a mutation. Caller is responsible for invoking saveNow()
    /// or scheduleSave() depending on whether the mutation is lifecycle-critical.
    /// The mutation closure returns whether it changed the file. This avoids
    /// copying and comparing the entire board on every small per-task update.
    @discardableResult
    internal func mutate(_ block: (inout TaskBoardFile) throws -> Bool) rethrows -> Bool {
        let changed = try block(&file)
        guard changed else { return false }
        file.updatedAt = Date()
        rebuildSnapshots()
        return true
    }

    @discardableResult
    internal static func rebalanceColumnIfNeeded(
        _ columnId: TaskColumnId,
        in file: inout TaskBoardFile
    ) -> Bool {
        let indexes = file.tasks.indices
            .filter { file.tasks[$0].columnId == columnId && file.tasks[$0].archivedAt == nil }
            .sorted { file.tasks[$0].rank < file.tasks[$1].rank }
        guard indexes.contains(where: { file.tasks[$0].rank.count > rankRebalanceLengthThreshold }) else {
            return false
        }
        let ranks = TaskRanking.rebalanced(count: indexes.count)
        var changed = false
        for (idx, rank) in zip(indexes, ranks) where file.tasks[idx].rank != rank {
            file.tasks[idx].rank = rank
            file.tasks[idx].updatedAt = Date()
            changed = true
        }
        return changed
    }

    // MARK: - Test seam

    /// Test-only helper. Production code uses TaskLifecycleCoordinator.
    internal func appendForTesting(_ task: TaskRecord) throws {
        mutate { $0.tasks.append(task); return true }
    }

    // MARK: - Persistence helpers

    private func writeAtomically() throws {
        try Self.write(file, to: boardFileURL())
    }

    private static func write(_ file: TaskBoardFile, to url: URL) throws {
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let data: Data
        do {
            data = try JSONEncoder.tasks.encode(file)
        } catch {
            throw TaskBoardStoreError.writeFailed("encode: \(error)")
        }
        let tmp = url.appendingPathExtension("tmp-\(UUID().uuidString)")
        do {
            try data.write(to: tmp, options: .atomic)
            _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw TaskBoardStoreError.writeFailed(String(describing: error))
        }
    }

    private func boardFileURL() -> URL {
        projectRoot.appendingPathComponent(".termloop/tasks.json")
    }

    // MARK: - Snapshot rebuilds

    private func rebuildSnapshots() {
        rebuildColumnSnapshots()
    }

    private func rebuildColumnSnapshots() {
        let active = file.tasks.filter { $0.archivedAt == nil }
        let grouped = Dictionary(grouping: active, by: { $0.columnId })
        let snapshots: [TaskColumnSnapshot] = TaskColumnId.allCases.map { columnId in
            let cards = (grouped[columnId] ?? [])
                .sorted { $0.rank < $1.rank }
                .map { task in
                    TaskCardSummary(
                        id: task.id,
                        title: task.title,
                        provisionState: task.provisionState,
                        workspaceId: task.workspaceId,
                        branch: task.branch,
                        hasTicket: false, // v2 — Jira projection
                        worktreePath: task.worktreePath
                    )
                }
            return TaskColumnSnapshot(id: columnId, cards: cards)
        }
        columnSnapshots = snapshots
    }
}

private struct TaskBoardSchemaHeader: Decodable {
    let schemaVersion: Int
}

// MARK: - JSON coders

extension JSONEncoder {
    static let tasks: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .iso8601
        return e
    }()
}

extension JSONDecoder {
    static let tasks: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
