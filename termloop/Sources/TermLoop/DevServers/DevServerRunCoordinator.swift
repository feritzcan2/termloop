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
    private var setupStateStores: [UUID: DevServerSetupStateStore] = [:]

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
            if stopImmediately(key: key) {
                Thread.sleep(forTimeInterval: 0.15)
            }
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

        if setupStateStore(for: resolved).needsSetup(
            profile: resolved.profile,
            worktreePath: resolved.worktreeRoot.path
        ) {
            return try launchSetup(run: run, resolved: resolved, environment: env)
        }
        return try launchDevServer(runId: run.runId, resolved: resolved, environment: env)
    }

    private func launchSetup(
        run: DevServerRunSnapshot,
        resolved: ResolvedStartContext,
        environment: [String: String]
    ) throws -> DevServerRunSnapshot {
        guard let setupCommand = resolved.profile.setupCommand else { return run }
        _ = runStore.appendLog(
            runId: run.runId,
            stream: .system,
            text: String(
                localized: "devservers.setup.running",
                defaultValue: "Running setup command…",
                table: "TermLoop"
            )
        )
        do {
            let managed = try DevServerProcessRunner.launch(
                runId: run.runId,
                command: setupCommand,
                cwd: resolved.cwd,
                environment: environment,
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
                        self?.handleSetupExit(
                            runId: run.runId,
                            exitCode: exitCode,
                            resolved: resolved,
                            environment: environment
                        )
                    }
                }
            )
            processes[run.runId] = managed
            warnIfProcessGroupUnavailable(managed: managed, runId: run.runId)
            return runStore.markSettingUp(
                runId: run.runId,
                pid: managed.pid,
                processGroupId: managed.processGroupId
            ) ?? run
        } catch {
            let message = error.localizedDescription
            _ = runStore.appendLog(runId: run.runId, stream: .system, text: message)
            _ = runStore.markFailed(runId: run.runId, message: message)
            throw DevServerRunError.setupFailed(message)
        }
    }

    @discardableResult
    private func launchDevServer(
        runId: UUID,
        resolved: ResolvedStartContext,
        environment: [String: String]
    ) throws -> DevServerRunSnapshot {
        do {
            let managed = try DevServerProcessRunner.launch(
                runId: runId,
                command: resolved.profile.command,
                cwd: resolved.cwd,
                environment: environment,
                onLine: { [weak self] stream, line in
                    _Concurrency.Task { @MainActor in
                        self?.handleLine(
                            runId: runId,
                            profile: resolved.profile,
                            stream: stream,
                            line: line
                        )
                    }
                },
                onExit: { [weak self] exitCode in
                    _Concurrency.Task { @MainActor in
                        self?.handleExit(runId: runId, exitCode: exitCode)
                    }
                }
            )
            processes[runId] = managed
            warnIfProcessGroupUnavailable(managed: managed, runId: runId)
            let snapshot = runStore.markRunning(
                runId: runId,
                pid: managed.pid,
                processGroupId: managed.processGroupId
            )
                ?? runStore.snapshot(runId: runId)
            materializeFallbackURLs(runId: runId, profile: resolved.profile)
            guard let snapshot else { throw DevServerRunError.runNotFound(runId) }
            return runStore.snapshot(runId: runId) ?? snapshot
        } catch {
            let message = error.localizedDescription
            _ = runStore.appendLog(runId: runId, stream: .system, text: message)
            _ = runStore.markFailed(runId: runId, message: message)
            throw DevServerRunError.launchFailed(message)
        }
    }

    public func stop(runId: UUID) throws -> DevServerRunSnapshot {
        guard let snapshot = runStore.snapshot(runId: runId) else {
            throw DevServerRunError.runNotFound(runId)
        }
        guard snapshot.isActive else { return snapshot }
        _ = runStore.markStopping(runId: runId)
        schedulePortReleaseCheck(snapshot: snapshot, skipIfReplaced: false)
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

    @discardableResult
    private func stopImmediately(key: DevServerRunKey) -> Bool {
        guard let snapshot = runStore.activeSnapshot(for: key) else { return false }
        _ = runStore.markStopping(runId: snapshot.runId)
        schedulePortReleaseCheck(snapshot: snapshot, skipIfReplaced: true)
        processes[snapshot.runId]?.stopImmediately()
        processes.removeValue(forKey: snapshot.runId)
        openOnURLRunIds.remove(snapshot.runId)
        _ = runStore.markExited(runId: snapshot.runId, exitCode: SIGKILL)
        return true
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
        setupStateStores.removeValue(forKey: projectId)
    }

    public func stopRuns(workspaceId: UUID) {
        for snapshot in runStore.snapshots() where snapshot.workspaceId == workspaceId && snapshot.isActive {
            _ = try? stop(runId: snapshot.runId)
        }
    }

    public func stopTaskRuns(projectId: UUID, taskId: UUID) {
        for snapshot in runStore.snapshots(projectId: projectId, taskId: taskId) where snapshot.isActive {
            _ = try? stop(runId: snapshot.runId)
        }
    }

    public func stopTaskRunsAndCleanup(
        projectId: UUID,
        task: TaskRecord,
        projectRoot: URL,
        reason: String
    ) {
        stopTaskRuns(projectId: projectId, taskId: task.id)
        guard let worktreePath = task.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !worktreePath.isEmpty,
              let profileStore = DevServerProfileStoreProvider.shared.store(for: projectId),
              profileStore.loadError == nil else {
            return
        }
        for profile in profileStore.profiles where profile.cleanupCommand != nil {
            runCleanup(
                projectId: projectId,
                task: task,
                worktreePath: worktreePath,
                profile: profile,
                reason: reason
            )
            try? setupStateStore(projectId: projectId, projectRoot: projectRoot)
                .clear(worktreePath: worktreePath, profileId: profile.id)
        }
    }

    public func stopProjectRunsAndCleanup(projectId: UUID, reason: String) {
        guard let taskStore = TaskBoardStoreProvider.shared.store(for: projectId) else {
            remove(projectId: projectId)
            return
        }
        for task in taskStore.fileSnapshot().tasks {
            stopTaskRunsAndCleanup(
                projectId: projectId,
                task: task,
                projectRoot: taskStore.projectRoot,
                reason: reason
            )
        }
        setupStateStores.removeValue(forKey: projectId)
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

    private func handleSetupExit(
        runId: UUID,
        exitCode: Int32,
        resolved: ResolvedStartContext,
        environment: [String: String]
    ) {
        processes.removeValue(forKey: runId)
        guard let snapshot = runStore.snapshot(runId: runId), snapshot.isActive else { return }
        if snapshot.phase == .stopping {
            _ = runStore.markExited(runId: runId, exitCode: exitCode)
            return
        }
        guard exitCode == 0 else {
            let message = String(
                localized: "devservers.setup.exitedWithCode",
                defaultValue: "Setup exited with code \(Int(exitCode))",
                table: "TermLoop"
            )
            _ = runStore.appendLog(runId: runId, stream: .system, text: message)
            _ = runStore.markFailed(runId: runId, message: message)
            return
        }
        do {
            try setupStateStore(for: resolved).markComplete(
                profile: resolved.profile,
                worktreePath: resolved.worktreeRoot.path
            )
            _ = runStore.appendLog(
                runId: runId,
                stream: .system,
                text: String(localized: "devservers.setup.complete", defaultValue: "Setup complete.", table: "TermLoop")
            )
            try launchDevServer(runId: runId, resolved: resolved, environment: environment)
        } catch {
            let message = error.localizedDescription
            _ = runStore.appendLog(runId: runId, stream: .system, text: message)
            _ = runStore.markFailed(runId: runId, message: message)
        }
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
            projectRoot: taskStore.projectRoot,
            task: task,
            profileFile: profileStore.file,
            profile: profile,
            worktreeRoot: worktreeRoot,
            cwd: cwd
        )
    }

    private func materializeFallbackURLs(runId: UUID, profile: DevServerProfile) {
        for fallback in profile.urlDetection.fallbackUrls {
            guard let normalized = DevServerURLDetector.normalize(fallback) else { continue }
            guard let snapshot = runStore.addURL(runId: runId, urlString: normalized),
                  snapshot.latestURL == normalized,
                  openOnURLRunIds.remove(runId) != nil,
                  let url = URL(string: normalized) else {
                continue
            }
            _ = onFirstURL?(snapshot, url)
        }
    }

    private func setupStateStore(for resolved: ResolvedStartContext) -> DevServerSetupStateStore {
        setupStateStore(projectId: resolved.projectId, projectRoot: resolved.projectRoot)
    }

    private func setupStateStore(projectId: UUID, projectRoot: URL) -> DevServerSetupStateStore {
        if let store = setupStateStores[projectId] { return store }
        let store = DevServerSetupStateStore(projectRoot: projectRoot)
        setupStateStores[projectId] = store
        return store
    }

    private func runCleanup(
        projectId: UUID,
        task: TaskRecord,
        worktreePath: String,
        profile: DevServerProfile,
        reason: String
    ) {
        guard let cleanupCommand = profile.cleanupCommand else { return }
        let worktreeRoot = URL(fileURLWithPath: worktreePath).resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: worktreeRoot.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            return
        }
        let cwd = (try? resolveWorkingDirectory(profile.workingDirectory, worktreeRoot: worktreeRoot)) ?? worktreeRoot
        let key = DevServerRunKey(projectId: projectId, taskId: task.id, profileId: "\(profile.id).cleanup")
        guard runStore.activeSnapshot(for: key) == nil else { return }
        let run = runStore.start(
            key: key,
            profileName: profile.name,
            workspaceId: task.workspaceId,
            worktreePath: worktreeRoot.path,
            cwd: cwd.path,
            command: cleanupCommand,
            logLimit: 500
        )
        _ = runStore.appendLog(
            runId: run.runId,
            stream: .system,
            text: String(
                localized: "devservers.cleanup.running",
                defaultValue: "Running cleanup command (\(reason))…",
                table: "TermLoop"
            )
        )
        let env = launchEnvironment(
            projectId: projectId,
            task: task,
            profileId: profile.id,
            runId: run.runId,
            worktreePath: worktreeRoot.path,
            profileEnv: profile.env
        )
        do {
            let managed = try DevServerProcessRunner.launch(
                runId: run.runId,
                command: cleanupCommand,
                cwd: cwd,
                environment: env,
                onLine: { [weak self] stream, line in
                    _Concurrency.Task { @MainActor in
                        self?.runStore.appendLog(runId: run.runId, stream: stream, text: line)
                    }
                },
                onExit: { [weak self] exitCode in
                    _Concurrency.Task { @MainActor in
                        self?.processes.removeValue(forKey: run.runId)
                        _ = self?.runStore.markExited(runId: run.runId, exitCode: exitCode)
                    }
                }
            )
            processes[run.runId] = managed
            warnIfProcessGroupUnavailable(managed: managed, runId: run.runId)
            _ = runStore.markSettingUp(
                runId: run.runId,
                pid: managed.pid,
                processGroupId: managed.processGroupId
            )
        } catch {
            _ = runStore.markFailed(runId: run.runId, message: error.localizedDescription)
        }
    }

    private func warnIfProcessGroupUnavailable(managed: DevServerManagedProcess, runId: UUID) {
        guard managed.processGroupId == nil else { return }
        _ = runStore.appendLog(
            runId: runId,
            stream: .system,
            text: String(
                localized: "devservers.process.processGroupUnavailable",
                defaultValue: "Process group unavailable; stop will target the shell process only.",
                table: "TermLoop"
            )
        )
    }

    private func schedulePortReleaseCheck(snapshot: DevServerRunSnapshot, skipIfReplaced: Bool) {
        let ports = DevServerURLDetector.localPorts(from: snapshot.urls)
        guard !ports.isEmpty else { return }
        let runId = snapshot.runId
        let key = snapshot.key
        _Concurrency.Task { [weak self] in
            try? await _Concurrency.Task.sleep(nanoseconds: 3_000_000_000)
            await MainActor.run {
                self?.verifyPortsReleased(runId: runId, key: key, ports: ports, skipIfReplaced: skipIfReplaced)
            }
        }
    }

    private func verifyPortsReleased(
        runId: UUID,
        key: DevServerRunKey,
        ports: [Int],
        skipIfReplaced: Bool
    ) {
        guard runStore.snapshot(runId: runId) != nil else { return }
        if skipIfReplaced,
           let active = runStore.activeSnapshot(for: key),
           active.runId != runId {
            return
        }
        let occupied = ports.filter { DevServerLocalPortProbe.isOccupied(port: $0) }
        guard !occupied.isEmpty else { return }
        let portList = occupied.map(String.init).joined(separator: ", ")
        _ = runStore.appendLog(
            runId: runId,
            stream: .stderr,
            text: String(
                localized: "devservers.process.portStillOccupied",
                defaultValue: "Warning: local port still appears occupied after stop: \(portList)",
                table: "TermLoop"
            )
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
        let projectRoot: URL
        let task: TaskRecord
        let profileFile: DevServerProfileFile
        let profile: DevServerProfile
        let worktreeRoot: URL
        let cwd: URL
    }
}
