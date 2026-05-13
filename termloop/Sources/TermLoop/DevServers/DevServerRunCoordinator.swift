// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

@MainActor
public final class DevServerRunCoordinator {
    public static let shared = DevServerRunCoordinator()

    public var onFirstURL: ((DevServerRunSnapshot, URL) -> Bool)?
    public var onOpenURL: ((DevServerRunSnapshot, URL, Bool) -> Bool)?

    private let runStore: DevServerRunStore
    private var processes: [UUID: DevServerManagedProcess] = [:]
    private var openOnURLRunIds = Set<UUID>()

    public convenience init() {
        self.init(runStore: DevServerRunStore.shared)
    }

    public init(runStore: DevServerRunStore) {
        self.runStore = runStore
    }

    @discardableResult
    public func start(
        projectId explicitProjectId: UUID?,
        taskId: UUID,
        profileId: String,
        restart: Bool = false,
        openOnURL: Bool = false
    ) throws -> DevServerRunSnapshot {
        let resolved = try resolve(projectId: explicitProjectId, taskId: taskId, profileId: profileId)
        let key = DevServerRunKey(projectId: resolved.projectId, taskId: taskId, profileId: profileId)
        if restart {
            stopImmediately(key: key)
        } else if let active = runStore.activeSnapshot(for: key) {
            if openOnURL { openOnURLRunIds.insert(active.runId) }
            return active
        }

        let run = runStore.start(
            key: key,
            profileName: resolved.profile.name,
            workspaceId: resolved.task.workspaceId,
            worktreePath: resolved.worktreeRoot.path,
            cwd: resolved.cwd.path,
            command: resolved.profile.command,
            logLimit: resolved.profileFile.defaults.logLineLimit
        )
        if openOnURL { openOnURLRunIds.insert(run.runId) }

        let env = launchEnvironment(
            projectId: resolved.projectId,
            task: resolved.task,
            profileId: resolved.profile.id,
            runId: run.runId,
            worktreePath: resolved.worktreeRoot.path,
            profileEnv: resolved.profile.env
        )

        do {
            let managed = try DevServerProcessRunner.launch(
                runId: run.runId,
                command: resolved.profile.command,
                cwd: resolved.cwd,
                environment: env,
                onLine: { [weak self] stream, line in
                    _Concurrency.Task { @MainActor in
                        self?.handleLine(
                            runId: run.runId,
                            profile: resolved.profile,
                            stream: stream,
                            line: line
                        )
                    }
                },
                onExit: { [weak self] exitCode in
                    _Concurrency.Task { @MainActor in
                        self?.handleExit(runId: run.runId, exitCode: exitCode)
                    }
                }
            )
            processes[run.runId] = managed
            return runStore.markRunning(runId: run.runId, pid: managed.pid) ?? run
        } catch {
            let message = error.localizedDescription
            _ = runStore.appendLog(runId: run.runId, stream: .system, text: message)
            _ = runStore.markFailed(runId: run.runId, message: message)
            throw DevServerRunError.launchFailed(message)
        }
    }

    public func stop(runId: UUID) throws -> DevServerRunSnapshot {
        guard let snapshot = runStore.snapshot(runId: runId) else {
            throw DevServerRunError.runNotFound(runId)
        }
        guard snapshot.isActive else { return snapshot }
        _ = runStore.markStopping(runId: runId)
        if let process = processes[runId] {
            process.stop()
        } else {
            _ = runStore.markExited(runId: runId, exitCode: 0)
        }
        return runStore.snapshot(runId: runId) ?? snapshot
    }

    public func stop(key: DevServerRunKey) {
        guard let snapshot = runStore.activeSnapshot(for: key) else { return }
        _ = try? stop(runId: snapshot.runId)
    }

    private func stopImmediately(key: DevServerRunKey) {
        guard let snapshot = runStore.activeSnapshot(for: key) else { return }
        _ = runStore.markStopping(runId: snapshot.runId)
        processes[snapshot.runId]?.stopImmediately()
        processes.removeValue(forKey: snapshot.runId)
        openOnURLRunIds.remove(snapshot.runId)
        _ = runStore.markExited(runId: snapshot.runId, exitCode: SIGKILL)
    }

    public func restart(
        projectId explicitProjectId: UUID?,
        taskId: UUID,
        profileId: String,
        openOnURL: Bool = false
    ) throws -> DevServerRunSnapshot {
        try start(
            projectId: explicitProjectId,
            taskId: taskId,
            profileId: profileId,
            restart: true,
            openOnURL: openOnURL
        )
    }

    public func stopAllBestEffort() {
        for process in processes.values {
            process.stopImmediately()
            process.flushReaders()
        }
        processes.removeAll()
        openOnURLRunIds.removeAll()
    }

    public func remove(projectId: UUID) {
        for snapshot in runStore.snapshots(projectId: projectId) {
            processes[snapshot.runId]?.stopImmediately()
            processes.removeValue(forKey: snapshot.runId)
            openOnURLRunIds.remove(snapshot.runId)
        }
        runStore.remove(projectId: projectId)
    }

    private func handleLine(
        runId: UUID,
        profile: DevServerProfile,
        stream: DevServerLogStream,
        line: String
    ) {
        runStore.appendLog(runId: runId, stream: stream, text: line)
        guard profile.urlDetection.autoDetect else { return }
        for detected in DevServerURLDetector.detect(in: line) {
            guard let snapshot = runStore.addURL(runId: runId, urlString: detected.normalizedString),
                  snapshot.latestURL == detected.normalizedString,
                  openOnURLRunIds.remove(runId) != nil,
                  let url = detected.url else {
                continue
            }
            _ = onFirstURL?(snapshot, url)
        }
    }

    private func handleExit(runId: UUID, exitCode: Int32) {
        processes.removeValue(forKey: runId)
        openOnURLRunIds.remove(runId)
        guard runStore.snapshot(runId: runId)?.isActive == true else { return }
        _ = runStore.markExited(runId: runId, exitCode: exitCode)
    }

    private func resolve(
        projectId explicitProjectId: UUID?,
        taskId: UUID,
        profileId: String
    ) throws -> ResolvedStartContext {
        let projectId: UUID
        if let explicitProjectId {
            projectId = explicitProjectId
        } else if let active = ProjectStore.shared.activeProjectId {
            projectId = active
        } else {
            throw DevServerRunError.noProject
        }
        guard let taskStore = TaskBoardStoreProvider.shared.store(for: projectId),
              let profileStore = DevServerProfileStoreProvider.shared.store(for: projectId) else {
            throw DevServerRunError.storeUnavailable
        }
        if let loadError = profileStore.loadError {
            throw DevServerRunError.profileStoreLoadFailed(loadError.localizedDescription)
        }
        guard let profile = profileStore.profile(id: profileId) else {
            throw DevServerRunError.profileNotFound(profileId)
        }
        guard let task = taskStore.fileSnapshot().tasks.first(where: { $0.id == taskId && $0.archivedAt == nil }) else {
            throw DevServerRunError.taskNotFound(taskId)
        }
        guard let rawWorktreePath = task.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawWorktreePath.isEmpty else {
            throw DevServerRunError.taskNotBound(taskId)
        }
        let worktreeRoot = URL(fileURLWithPath: rawWorktreePath).resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: worktreeRoot.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw DevServerRunError.worktreeMissing(worktreeRoot.path)
        }
        let cwd = try resolveWorkingDirectory(profile.workingDirectory, worktreeRoot: worktreeRoot)
        guard FileManager.default.fileExists(atPath: cwd.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw DevServerRunError.invalidWorkingDirectory(cwd.path)
        }
        return ResolvedStartContext(
            projectId: projectId,
            task: task,
            profileFile: profileStore.file,
            profile: profile,
            worktreeRoot: worktreeRoot,
            cwd: cwd
        )
    }

    private func resolveWorkingDirectory(_ raw: String, worktreeRoot: URL) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw DevServerRunError.invalidWorkingDirectory(raw) }
        let candidate: URL
        if (trimmed as NSString).isAbsolutePath {
            candidate = URL(fileURLWithPath: trimmed).resolvingSymlinksInPath()
        } else {
            candidate = worktreeRoot.appendingPathComponent(trimmed).resolvingSymlinksInPath()
        }
        let rootPath = worktreeRoot.path
        guard candidate.path == rootPath || candidate.path.hasPrefix(rootPath + "/") else {
            throw DevServerRunError.invalidWorkingDirectory(candidate.path)
        }
        return candidate
    }

    private func launchEnvironment(
        projectId: UUID,
        task: TaskRecord,
        profileId: String,
        runId: UUID,
        worktreePath: String,
        profileEnv: [String: String]
    ) -> [String: String] {
        var env = profileEnv
        env["TERMLOOP_PROJECT_ID"] = projectId.uuidString
        env["TERMLOOP_TASK_ID"] = task.id.uuidString
        env["TERMLOOP_WORKSPACE_ID"] = task.workspaceId?.uuidString
        env["TERMLOOP_WORKTREE_PATH"] = worktreePath
        env["TERMLOOP_DEVSERVER_PROFILE_ID"] = profileId
        env["TERMLOOP_DEVSERVER_RUN_ID"] = runId.uuidString
        return env
    }

    private struct ResolvedStartContext {
        let projectId: UUID
        let task: TaskRecord
        let profileFile: DevServerProfileFile
        let profile: DevServerProfile
        let worktreeRoot: URL
        let cwd: URL
    }
}
