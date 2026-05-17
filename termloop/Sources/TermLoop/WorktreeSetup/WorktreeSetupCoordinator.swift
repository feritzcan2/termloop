// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

@MainActor
public final class WorktreeSetupCoordinator: ObservableObject {
    public static let shared = WorktreeSetupCoordinator()

    public typealias LogSink = (_ stream: DevServerLogStream, _ text: String) -> Void
    public typealias Completion = (Result<Void, Error>) -> Void

    @Published public private(set) var version = 0

    private var runtime: [WorktreeSetupRunKey: WorktreeSetupStatusSnapshot] = [:]
    private var logsByKey: [WorktreeSetupRunKey: [WorktreeSetupLogLine]] = [:]
    private var processes: [WorktreeSetupRunKey: DevServerManagedProcess] = [:]
    private var stateStores: [UUID: WorktreeSetupStateStore] = [:]
    private var nextLogSequenceByKey: [WorktreeSetupRunKey: Int] = [:]
    private var pendingCompletionsByKey: [WorktreeSetupRunKey: [Completion]] = [:]

    public func visibleStatus(projectId: UUID, worktreePath: String) -> WorktreeSetupStatusSnapshot? {
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else { return nil }
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        if let loadError = store.loadError {
            return WorktreeSetupStatusSnapshot(
                projectId: projectId,
                worktreePath: key.worktreePath,
                phase: .loadFailed,
                errorMessage: loadError.localizedDescription,
                startedAt: nil,
                updatedAt: Date(),
                logCursor: nextLogSequenceByKey[key] ?? 0
            )
        }
        guard store.configExists else { return nil }
        if let active = runtime[key], active.phase == .running || active.phase == .failed {
            return active
        }
        let phase = stateStore(projectId: projectId, projectRoot: store.projectRoot)
            .setupState(for: store.file, worktreePath: key.worktreePath)
        guard phase == .needed else { return nil }
        return WorktreeSetupStatusSnapshot(
            projectId: projectId,
            worktreePath: key.worktreePath,
            phase: .needed,
            errorMessage: nil,
            startedAt: nil,
            updatedAt: Date(),
            logCursor: nextLogSequenceByKey[key] ?? 0
        )
    }

    public func logs(projectId: UUID, worktreePath: String, limit: Int = 300) -> [WorktreeSetupLogLine] {
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        let logs = logsByKey[key] ?? []
        guard logs.count > limit else { return logs }
        return Array(logs.suffix(limit))
    }

    public func openOrCreateConfig(projectId: UUID) throws -> URL {
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else {
            throw WorktreeSetupError.configMissing
        }
        return try store.ensureConfigFile()
    }

    @discardableResult
    public func start(
        projectId: UUID,
        taskId: UUID?,
        worktreePath: String,
        force: Bool = false,
        reason: String = "manual",
        extraEnvironment: [String: String] = [:],
        onLog: LogSink? = nil,
        completion: Completion? = nil
    ) throws -> WorktreeSetupStatusSnapshot {
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else {
            throw WorktreeSetupError.configMissing
        }
        return try start(
            projectId: projectId,
            taskId: taskId,
            projectRoot: store.projectRoot,
            worktreePath: worktreePath,
            force: force,
            reason: reason,
            extraEnvironment: extraEnvironment,
            onLog: onLog,
            completion: completion
        )
    }

    @discardableResult
    public func start(
        projectId: UUID,
        taskId: UUID?,
        projectRoot: URL,
        worktreePath: String,
        force: Bool = false,
        reason: String = "manual",
        extraEnvironment: [String: String] = [:],
        onLog: LogSink? = nil,
        completion: Completion? = nil
    ) throws -> WorktreeSetupStatusSnapshot {
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        if let running = runtime[key], running.phase == .running {
            if let completion {
                pendingCompletionsByKey[key, default: []].append(completion)
            }
            return running
        }
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else {
            throw WorktreeSetupError.configMissing
        }
        store.load()
        if let loadError = store.loadError { throw loadError }
        guard store.configExists else { throw WorktreeSetupError.configMissing }
        let setupFile = store.file
        guard setupFile.hasRunnableSetup else {
            completion?(.success(()))
            return markReady(key: key)
        }
        let state = stateStore(projectId: projectId, projectRoot: projectRoot)
        if !force, !state.needsSetup(setupFile, worktreePath: key.worktreePath) {
            completion?(.success(()))
            return markReady(key: key)
        }

        clearLogs(key: key)
        let snapshot = markRunning(key: key)
        appendLog(key: key, stream: .system, text: localSetupStartMessage(reason: reason), externalSink: onLog)

        _Concurrency.Task { [weak self] in
            guard let self else { return }
            do {
                try await self.execute(
                    steps: setupFile.steps,
                    projectId: projectId,
                    taskId: taskId,
                    projectRoot: projectRoot,
                    worktreePath: key.worktreePath,
                    key: key,
                    environment: extraEnvironment,
                    externalSink: onLog
                )
                try state.markComplete(setupFile: setupFile, worktreePath: key.worktreePath)
                self.appendLog(
                    key: key,
                    stream: .system,
                    text: String(localized: "worktreeSetup.complete", defaultValue: "Local setup complete.", table: "TermLoop"),
                    externalSink: onLog
                )
                self.runtime[key] = nil
                self.bumpVersion()
                completion?(.success(()))
                self.finishPendingCompletions(key: key, result: .success(()))
            } catch {
                self.processes.removeValue(forKey: key)
                let message = error.localizedDescription
                self.appendLog(key: key, stream: .system, text: message, externalSink: onLog)
                self.markFailed(key: key, message: message)
                completion?(.failure(error))
                self.finishPendingCompletions(key: key, result: .failure(error))
            }
        }
        return snapshot
    }

    public func runCleanup(
        projectId: UUID,
        taskId: UUID?,
        projectRoot: URL,
        worktreePath: String,
        reason: String
    ) {
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else { return }
        store.load()
        guard store.loadError == nil, store.configExists, store.file.hasCleanup else { return }
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        let setupFile = store.file
        clearLogs(key: key)
        _ = markRunning(key: key)
        appendLog(
            key: key,
            stream: .system,
            text: String(localized: "worktreeSetup.cleanup.running", defaultValue: "Running local setup cleanup (\(reason))…", table: "TermLoop"),
            externalSink: nil
        )
        _Concurrency.Task { [weak self] in
            guard let self else { return }
            do {
                try await self.execute(
                    steps: setupFile.cleanupSteps,
                    projectId: projectId,
                    taskId: taskId,
                    projectRoot: projectRoot,
                    worktreePath: key.worktreePath,
                    key: key,
                    environment: [:],
                    externalSink: nil
                )
                try self.stateStore(projectId: projectId, projectRoot: projectRoot).clear(worktreePath: key.worktreePath)
                self.runtime[key] = nil
                self.bumpVersion()
            } catch {
                self.appendLog(key: key, stream: .system, text: error.localizedDescription, externalSink: nil)
                self.markFailed(key: key, message: error.localizedDescription)
            }
        }
    }

    public func skip(projectId: UUID, worktreePath: String) throws {
        guard let store = WorktreeSetupStoreProvider.shared.store(for: projectId) else {
            throw WorktreeSetupError.configMissing
        }
        store.load()
        if let loadError = store.loadError { throw loadError }
        guard store.configExists else { throw WorktreeSetupError.configMissing }
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        try stateStore(projectId: projectId, projectRoot: store.projectRoot)
            .markSkipped(setupFile: store.file, worktreePath: key.worktreePath)
        runtime[key] = nil
        bumpVersion()
    }

    public func cancel(projectId: UUID, worktreePath: String) {
        let key = WorktreeSetupRunKey(projectId: projectId, worktreePath: normalizedPath(worktreePath))
        processes[key]?.stop()
        processes.removeValue(forKey: key)
        let error = WorktreeSetupError.cancelled
        markFailed(key: key, message: error.localizedDescription)
        finishPendingCompletions(key: key, result: .failure(error))
    }

    public func remove(projectId: UUID) {
        for (key, process) in processes where key.projectId == projectId {
            process.stopImmediately()
        }
        processes = processes.filter { $0.key.projectId != projectId }
        runtime = runtime.filter { $0.key.projectId != projectId }
        logsByKey = logsByKey.filter { $0.key.projectId != projectId }
        nextLogSequenceByKey = nextLogSequenceByKey.filter { $0.key.projectId != projectId }
        pendingCompletionsByKey = pendingCompletionsByKey.filter { $0.key.projectId != projectId }
        stateStores.removeValue(forKey: projectId)
        WorktreeSetupStoreProvider.shared.remove(projectId: projectId)
        bumpVersion()
    }

    private func execute(
        steps: [WorktreeSetupStep],
        projectId: UUID,
        taskId: UUID?,
        projectRoot: URL,
        worktreePath: String,
        key: WorktreeSetupRunKey,
        environment: [String: String],
        externalSink: LogSink?
    ) async throws {
        let worktreeRoot = URL(fileURLWithPath: worktreePath, isDirectory: true).resolvingSymlinksInPath()
        for (index, step) in steps.enumerated() {
            try ensureActive(key: key)
            let label = step.id ?? "#\(index + 1)"
            appendLog(
                key: key,
                stream: .system,
                text: String(localized: "worktreeSetup.step.running", defaultValue: "Running local setup step \(label) (\(step.type.rawValue))…", table: "TermLoop"),
                externalSink: externalSink
            )
            switch step.type {
            case .copy:
                try runCopyStep(step, projectRoot: projectRoot, worktreeRoot: worktreeRoot, key: key, externalSink: externalSink)
            case .mkdir:
                try runMkdirStep(step, worktreeRoot: worktreeRoot, key: key, externalSink: externalSink)
            case .template:
                try runTemplateStep(step, worktreeRoot: worktreeRoot, key: key, externalSink: externalSink)
            case .command:
                try await runCommandStep(
                    step,
                    projectId: projectId,
                    taskId: taskId,
                    projectRoot: projectRoot,
                    worktreeRoot: worktreeRoot,
                    key: key,
                    baseEnvironment: environment,
                    externalSink: externalSink
                )
            }
        }
    }

    private func runCopyStep(
        _ step: WorktreeSetupStep,
        projectRoot: URL,
        worktreeRoot: URL,
        key: WorktreeSetupRunKey,
        externalSink: LogSink?
    ) throws {
        guard let from = step.from, let to = step.to else {
            throw WorktreeSetupError.stepInvalid("copy requires from and to")
        }
        let sourceRoot = from.scope == .projectRoot ? projectRoot : worktreeRoot
        let source = try resolvePath(from.path, root: sourceRoot)
        let destination = try resolvePath(to, root: worktreeRoot)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: source.path, isDirectory: &isDirectory) else {
            if step.required { throw WorktreeSetupError.sourceMissing(source.path) }
            appendLog(key: key, stream: .system, text: "Skipped missing optional source: \(source.path)", externalSink: externalSink)
            return
        }
        if FileManager.default.fileExists(atPath: destination.path) {
            if step.ifMissingOnly {
                appendLog(key: key, stream: .system, text: "Destination exists; skipped copy: \(destination.path)", externalSink: externalSink)
                return
            }
            guard step.overwrite else { throw WorktreeSetupError.destinationExists(destination.path) }
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: destination)
        appendLog(key: key, stream: .system, text: "Copied \(source.path) → \(destination.path)", externalSink: externalSink)
    }

    private func runMkdirStep(
        _ step: WorktreeSetupStep,
        worktreeRoot: URL,
        key: WorktreeSetupRunKey,
        externalSink: LogSink?
    ) throws {
        guard let to = step.to else { throw WorktreeSetupError.stepInvalid("mkdir requires to") }
        let directory = try resolvePath(to, root: worktreeRoot)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        appendLog(key: key, stream: .system, text: "Created directory: \(directory.path)", externalSink: externalSink)
    }

    private func runTemplateStep(
        _ step: WorktreeSetupStep,
        worktreeRoot: URL,
        key: WorktreeSetupRunKey,
        externalSink: LogSink?
    ) throws {
        guard let to = step.to else { throw WorktreeSetupError.stepInvalid("template requires to") }
        let destination = try resolvePath(to, root: worktreeRoot)
        if FileManager.default.fileExists(atPath: destination.path) {
            if step.ifMissingOnly {
                appendLog(key: key, stream: .system, text: "Destination exists; skipped template: \(destination.path)", externalSink: externalSink)
                return
            }
            guard step.overwrite else { throw WorktreeSetupError.destinationExists(destination.path) }
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try (step.content ?? "").write(to: destination, atomically: true, encoding: .utf8)
        appendLog(key: key, stream: .system, text: "Wrote template: \(destination.path)", externalSink: externalSink)
    }

    private func runCommandStep(
        _ step: WorktreeSetupStep,
        projectId: UUID,
        taskId: UUID?,
        projectRoot: URL,
        worktreeRoot: URL,
        key: WorktreeSetupRunKey,
        baseEnvironment: [String: String],
        externalSink: LogSink?
    ) async throws {
        guard let command = step.command else { throw WorktreeSetupError.stepInvalid("command requires command") }
        let cwd = try resolvePath(step.workingDirectory ?? ".", root: worktreeRoot)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw WorktreeSetupError.stepInvalid("command cwd does not exist: \(cwd.path)")
        }
        var env = baseEnvironment.merging(step.env) { _, new in new }
        env["TERMLOOP_PROJECT_ID"] = projectId.uuidString
        env["TERMLOOP_TASK_ID"] = taskId?.uuidString
        env["TERMLOOP_WORKTREE_PATH"] = worktreeRoot.path
        env["TERMLOOP_LOCAL_SETUP"] = "1"
        env["TERMLOOP_PROJECT_ROOT"] = projectRoot.path

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let lock = NSLock()
            var resumed = false
            func resume(_ result: Result<Void, Error>) {
                lock.lock()
                guard !resumed else { lock.unlock(); return }
                resumed = true
                lock.unlock()
                switch result {
                case .success:
                    continuation.resume()
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }

            do {
                let managed = try DevServerProcessRunner.launch(
                    runId: UUID(),
                    command: command,
                    cwd: cwd,
                    environment: env,
                    onLine: { [weak self] stream, line in
                        _Concurrency.Task { @MainActor in
                            self?.appendLog(key: key, stream: stream, text: line, externalSink: externalSink)
                        }
                    },
                    onExit: { [weak self] exitCode in
                        _Concurrency.Task { @MainActor in
                            self?.processes.removeValue(forKey: key)
                            if exitCode == 0 {
                                resume(.success(()))
                            } else {
                                resume(.failure(WorktreeSetupError.commandFailed(command, exitCode)))
                            }
                        }
                    }
                )
                processes[key] = managed
                if let timeout = step.timeoutSeconds, timeout > 0 {
                    _Concurrency.Task { [weak self] in
                        try? await _Concurrency.Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000_000)
                        await MainActor.run {
                            guard let self, self.processes[key]?.pid == managed.pid else { return }
                            managed.stopImmediately()
                            self.processes.removeValue(forKey: key)
                            resume(.failure(WorktreeSetupError.commandFailed(command, SIGKILL)))
                        }
                    }
                }
            } catch {
                resume(.failure(error))
            }
        }
    }

    private func ensureActive(key: WorktreeSetupRunKey) throws {
        guard runtime[key]?.phase == .running else { throw WorktreeSetupError.cancelled }
    }

    private func resolvePath(_ raw: String, root: URL) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw WorktreeSetupError.stepInvalid("empty path") }
        let candidate: URL
        if (trimmed as NSString).isAbsolutePath {
            candidate = URL(fileURLWithPath: trimmed).resolvingSymlinksInPath()
        } else {
            candidate = root.appendingPathComponent(trimmed).resolvingSymlinksInPath()
        }
        let rootPath = root.resolvingSymlinksInPath().path
        guard candidate.path == rootPath || candidate.path.hasPrefix(rootPath + "/") else {
            throw WorktreeSetupError.pathEscapesRoot(candidate.path)
        }
        return candidate
    }

    private func markRunning(key: WorktreeSetupRunKey) -> WorktreeSetupStatusSnapshot {
        let now = Date()
        let snapshot = WorktreeSetupStatusSnapshot(
            projectId: key.projectId,
            worktreePath: key.worktreePath,
            phase: .running,
            errorMessage: nil,
            startedAt: now,
            updatedAt: now,
            logCursor: nextLogSequenceByKey[key] ?? 0
        )
        runtime[key] = snapshot
        bumpVersion()
        return snapshot
    }

    private func markReady(key: WorktreeSetupRunKey) -> WorktreeSetupStatusSnapshot {
        let snapshot = WorktreeSetupStatusSnapshot(
            projectId: key.projectId,
            worktreePath: key.worktreePath,
            phase: .ready,
            errorMessage: nil,
            startedAt: nil,
            updatedAt: Date(),
            logCursor: nextLogSequenceByKey[key] ?? 0
        )
        runtime.removeValue(forKey: key)
        bumpVersion()
        return snapshot
    }

    private func markFailed(key: WorktreeSetupRunKey, message: String?) {
        let now = Date()
        runtime[key] = WorktreeSetupStatusSnapshot(
            projectId: key.projectId,
            worktreePath: key.worktreePath,
            phase: .failed,
            errorMessage: message,
            startedAt: runtime[key]?.startedAt,
            updatedAt: now,
            logCursor: nextLogSequenceByKey[key] ?? 0
        )
        bumpVersion()
    }

    private func clearLogs(key: WorktreeSetupRunKey) {
        logsByKey[key] = []
        nextLogSequenceByKey[key] = 0
        bumpVersion()
    }

    private func appendLog(
        key: WorktreeSetupRunKey,
        stream: DevServerLogStream,
        text: String,
        externalSink: LogSink?
    ) {
        let sequence = nextLogSequenceByKey[key] ?? 0
        nextLogSequenceByKey[key] = sequence + 1
        var logs = logsByKey[key] ?? []
        logs.append(WorktreeSetupLogLine(sequence: sequence, stream: stream, text: text, timestamp: Date()))
        if logs.count > 500 { logs.removeFirst(logs.count - 500) }
        logsByKey[key] = logs
        if var snapshot = runtime[key] {
            snapshot.logCursor = sequence + 1
            snapshot.updatedAt = Date()
            runtime[key] = snapshot
        }
        externalSink?(stream, text)
        bumpVersion()
    }

    private func localSetupStartMessage(reason: String) -> String {
        String(localized: "worktreeSetup.running", defaultValue: "Running local setup (\(reason))…", table: "TermLoop")
    }

    private func stateStore(projectId: UUID, projectRoot: URL) -> WorktreeSetupStateStore {
        if let store = stateStores[projectId] { return store }
        let store = WorktreeSetupStateStore(projectRoot: projectRoot)
        stateStores[projectId] = store
        return store
    }

    private func normalizedPath(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    private func bumpVersion() {
        version &+= 1
    }

    private func finishPendingCompletions(key: WorktreeSetupRunKey, result: Result<Void, Error>) {
        let completions = pendingCompletionsByKey.removeValue(forKey: key) ?? []
        for completion in completions {
            completion(result)
        }
    }
}

private struct WorktreeSetupRunKey: Hashable {
    let projectId: UUID
    let worktreePath: String
}
