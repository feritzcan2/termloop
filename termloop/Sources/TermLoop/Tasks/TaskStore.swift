// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import Combine

@MainActor
final class TaskStore: ObservableObject {
    enum StoreError: Error, Equatable {
        case duplicateBranch(String)
        case notFound(UUID)
        case ioError(String)
    }

    private struct FileFormat: Codable {
        let version: Int
        var tasks: [TermLoopTask]
    }

    @Published private(set) var tasksByProject: [UUID: [TermLoopTask]] = [:]

    private let projectRootProvider: (UUID) -> URL
    private let fileManager = FileManager.default

    init(projectRootProvider: @escaping (UUID) -> URL) {
        self.projectRootProvider = projectRootProvider
    }

    static let shared = TaskStore { projectId in
        ProjectStore.shared.project(id: projectId).map { URL(fileURLWithPath: $0.folderPath) }
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
    }

    // MARK: - Read

    func tasks(for projectId: UUID) -> [TermLoopTask] {
        tasksByProject[projectId] ?? []
    }

    func task(id: UUID, projectId: UUID) -> TermLoopTask? {
        tasks(for: projectId).first { $0.id == id }
    }

    func load(projectId: UUID) {
        let url = fileURL(for: projectId)
        guard fileManager.fileExists(atPath: url.path) else {
            tasksByProject[projectId] = []
            return
        }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            let format = try decoder.decode(FileFormat.self, from: data)
            tasksByProject[projectId] = format.tasks
        } catch {
            NSLog("[TaskStore] load failed for \(projectId): \(error)")
            tasksByProject[projectId] = []
        }
    }

    // MARK: - Write

    func create(_ task: TermLoopTask) throws {
        var list = tasksByProject[task.projectId] ?? []
        if list.contains(where: { $0.branch == task.branch }) {
            throw StoreError.duplicateBranch(task.branch)
        }
        list.append(task)
        tasksByProject[task.projectId] = list
        try persist(projectId: task.projectId)
    }

    func update(_ task: TermLoopTask) throws {
        guard var list = tasksByProject[task.projectId],
              let idx = list.firstIndex(where: { $0.id == task.id }) else {
            throw StoreError.notFound(task.id)
        }
        if list[idx] == task { return } // no-op write
        list[idx] = task
        tasksByProject[task.projectId] = list
        try persist(projectId: task.projectId)
    }

    func delete(taskId: UUID, projectId: UUID) throws {
        guard var list = tasksByProject[projectId] else {
            throw StoreError.notFound(taskId)
        }
        list.removeAll { $0.id == taskId }
        tasksByProject[projectId] = list
        try persist(projectId: projectId)
    }

    // MARK: - Persistence

    private func fileURL(for projectId: UUID) -> URL {
        projectRootProvider(projectId)
            .appendingPathComponent(".cmux")
            .appendingPathComponent("tasks.json")
    }

    private func persist(projectId: UUID) throws {
        let url = fileURL(for: projectId)
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let format = FileFormat(version: 1, tasks: tasksByProject[projectId] ?? [])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(format)
        let tmp = url.appendingPathExtension("tmp")
        try data.write(to: tmp, options: .atomic)
        if fileManager.fileExists(atPath: url.path) {
            _ = try fileManager.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fileManager.moveItem(at: tmp, to: url)
        }
    }
}
