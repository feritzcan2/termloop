// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

@MainActor
public final class DevServerRunStore: ObservableObject {
    public static let shared = DevServerRunStore()

    @Published public private(set) var version: Int = 0

    private struct RunState {
        var snapshot: DevServerRunSnapshot
        var logs: [DevServerLogLine]
        var seenURLs: Set<String>
        var logLimit: Int
    }

    private var runsById: [UUID: RunState] = [:]
    private var runIdByKey: [DevServerRunKey: UUID] = [:]

    private init() {}

    @discardableResult
    public func start(
        key: DevServerRunKey,
        profileName: String,
        workspaceId: UUID?,
        worktreePath: String,
        cwd: String,
        command: String,
        logLimit: Int
    ) -> DevServerRunSnapshot {
        if let existingRunId = runIdByKey[key],
           let existing = runsById[existingRunId]?.snapshot,
           existing.isActive {
            return existing
        }
        let runId = UUID()
        let now = Date()
        let snapshot = DevServerRunSnapshot(
            runId: runId,
            key: key,
            profileName: profileName,
            workspaceId: workspaceId,
            worktreePath: worktreePath,
            cwd: cwd,
            command: command,
            phase: .starting,
            pid: nil,
            urls: [],
            latestURL: nil,
            recentErrorLines: [],
            logCursor: 0,
            startedAt: now,
            updatedAt: now,
            exitedAt: nil,
            exitCode: nil,
            errorMessage: nil
        )
        runsById[runId] = RunState(
            snapshot: snapshot,
            logs: [],
            seenURLs: [],
            logLimit: DevServerDefaults.normalizedLogLineLimit(logLimit)
        )
        runIdByKey[key] = runId
        publish(snapshot: snapshot, eventType: "devserver.status")
        bumpVersion()
        return snapshot
    }

    public func markRunning(runId: UUID, pid: Int32) -> DevServerRunSnapshot? {
        update(runId: runId) { snapshot in
            snapshot = snapshot.with(phase: .running, pid: pid)
        }
    }

    public func markSettingUp(runId: UUID, pid: Int32?) -> DevServerRunSnapshot? {
        update(runId: runId) { snapshot in
            snapshot = snapshot.with(phase: .settingUp, pid: pid)
        }
    }

    public func markStopping(runId: UUID) -> DevServerRunSnapshot? {
        update(runId: runId) { snapshot in
            snapshot = snapshot.with(phase: .stopping)
        }
    }

    public func markExited(runId: UUID, exitCode: Int32) -> DevServerRunSnapshot? {
        update(runId: runId) { snapshot in
            let wasIntentionalStop = snapshot.phase == .stopping
            let nextPhase: DevServerRunPhase = exitCode == 0 || wasIntentionalStop ? .exited : .failed
            snapshot = snapshot.with(
                phase: nextPhase,
                clearPID: true,
                exitedAt: Date(),
                exitCode: exitCode,
                errorMessage: nextPhase == .exited
                    ? nil
                    : String(
                        localized: "devservers.run.exitedWithCode",
                        defaultValue: "Exited with code \(Int(exitCode))",
                        table: "TermLoop"
                    ),
                replaceErrorMessage: true
            )
        }
    }

    public func markFailed(runId: UUID, message: String) -> DevServerRunSnapshot? {
        update(runId: runId) { snapshot in
            snapshot = snapshot.with(
                phase: .failed,
                clearPID: true,
                exitedAt: Date(),
                errorMessage: message,
                replaceErrorMessage: true
            )
        }
    }

    @discardableResult
    public func appendLog(runId: UUID, stream: DevServerLogStream, text: String) -> DevServerLogLine? {
        guard var state = runsById[runId] else { return nil }
        let line = DevServerLogLine(
            runId: runId,
            sequence: state.snapshot.logCursor + 1,
            stream: stream,
            text: text
        )
        state.logs.append(line)
        if state.logs.count > state.logLimit {
            state.logs.removeFirst(state.logs.count - state.logLimit)
        }
        var recentErrors = state.snapshot.recentErrorLines
        if stream == .stderr {
            recentErrors.append(text)
            recentErrors = Array(recentErrors.suffix(5))
        }
        state.snapshot = state.snapshot.with(
            recentErrorLines: recentErrors,
            logCursor: line.sequence,
            updatedAt: line.timestamp
        )
        runsById[runId] = state
        publishLog(line: line, snapshot: state.snapshot)
        bumpVersion()
        return line
    }

    @discardableResult
    public func addURL(runId: UUID, urlString: String) -> DevServerRunSnapshot? {
        guard var state = runsById[runId], state.seenURLs.insert(urlString).inserted else {
            return nil
        }
        var urls = state.snapshot.urls
        urls.append(urlString)
        state.snapshot = state.snapshot.with(
            urls: urls,
            latestURL: urlString,
            replaceLatestURL: true,
            updatedAt: Date()
        )
        runsById[runId] = state
        publish(snapshot: state.snapshot, eventType: "devserver.url", extra: ["url": urlString])
        bumpVersion()
        return state.snapshot
    }

    public func snapshot(runId: UUID) -> DevServerRunSnapshot? {
        runsById[runId]?.snapshot
    }

    public func activeSnapshot(for key: DevServerRunKey) -> DevServerRunSnapshot? {
        guard let runId = runIdByKey[key], let snapshot = runsById[runId]?.snapshot, snapshot.isActive else {
            return nil
        }
        return snapshot
    }

    public func snapshots(projectId: UUID? = nil, taskId: UUID? = nil) -> [DevServerRunSnapshot] {
        runsById.values
            .map(\.snapshot)
            .filter { snapshot in
                if let projectId, snapshot.key.projectId != projectId { return false }
                if let taskId, snapshot.key.taskId != taskId { return false }
                return true
            }
            .sorted { lhs, rhs in lhs.updatedAt > rhs.updatedAt }
    }

    public func logs(runId: UUID, afterSequence: Int = 0, limit: Int = 200) -> [DevServerLogLine] {
        let boundedLimit = max(1, min(limit, 2_000))
        return Array((runsById[runId]?.logs ?? [])
            .filter { $0.sequence > afterSequence }
            .suffix(boundedLimit))
    }

    public func remove(projectId: UUID) {
        let ids = runsById.values
            .map(\.snapshot)
            .filter { $0.key.projectId == projectId }
            .map(\.runId)
        for id in ids {
            if let key = runsById[id]?.snapshot.key { runIdByKey.removeValue(forKey: key) }
            runsById.removeValue(forKey: id)
        }
        if !ids.isEmpty { bumpVersion() }
    }

    private func update(
        runId: UUID,
        _ block: (inout DevServerRunSnapshot) -> Void
    ) -> DevServerRunSnapshot? {
        guard var state = runsById[runId] else { return nil }
        var snapshot = state.snapshot
        block(&snapshot)
        guard snapshot != state.snapshot else { return snapshot }
        state.snapshot = snapshot
        runsById[runId] = state
        publish(snapshot: snapshot, eventType: "devserver.status")
        bumpVersion()
        return snapshot
    }

    private func bumpVersion() {
        version &+= 1
    }

    private func publish(
        snapshot: DevServerRunSnapshot,
        eventType: String,
        extra: [String: Any] = [:]
    ) {
        guard let workspaceId = snapshot.workspaceId else { return }
        var payload = Self.payload(snapshot: snapshot)
        for (key, value) in extra { payload[key] = value }
        EventBus.shared.publish(
            EventBus.Event(type: eventType, workspaceId: workspaceId, payload: payload)
        )
    }

    private func publishLog(line: DevServerLogLine, snapshot: DevServerRunSnapshot) {
        guard let workspaceId = snapshot.workspaceId else { return }
        var payload = Self.payload(snapshot: snapshot)
        payload["sequence"] = line.sequence
        payload["stream"] = line.stream.rawValue
        payload["text"] = line.text
        payload["timestamp"] = line.timestamp.timeIntervalSince1970
        EventBus.shared.publish(
            EventBus.Event(type: "devserver.log", workspaceId: workspaceId, payload: payload)
        )
    }

    public static func payload(snapshot: DevServerRunSnapshot) -> [String: Any] {
        [
            "run_id": snapshot.runId.uuidString,
            "project_id": snapshot.key.projectId.uuidString,
            "task_id": snapshot.key.taskId.uuidString,
            "profile_id": snapshot.key.profileId,
            "profile_name": snapshot.profileName,
            "workspace_id": snapshot.workspaceId?.uuidString as Any? ?? NSNull(),
            "phase": snapshot.phase.rawValue,
            "pid": snapshot.pid.map { Int($0) } as Any? ?? NSNull(),
            "cwd": snapshot.cwd,
            "worktree_path": snapshot.worktreePath,
            "urls": snapshot.urls,
            "latest_url": snapshot.latestURL as Any? ?? NSNull(),
            "recent_error_lines": snapshot.recentErrorLines,
            "log_cursor": snapshot.logCursor,
            "started_at": snapshot.startedAt.timeIntervalSince1970,
            "updated_at": snapshot.updatedAt.timeIntervalSince1970,
            "exited_at": snapshot.exitedAt?.timeIntervalSince1970 as Any? ?? NSNull(),
            "exit_code": snapshot.exitCode.map { Int($0) } as Any? ?? NSNull(),
            "error_message": snapshot.errorMessage as Any? ?? NSNull()
        ]
    }
}

private extension DevServerRunSnapshot {
    func with(
        phase: DevServerRunPhase? = nil,
        pid: Int32? = nil,
        clearPID: Bool = false,
        urls: [String]? = nil,
        latestURL: String? = nil,
        replaceLatestURL: Bool = false,
        recentErrorLines: [String]? = nil,
        logCursor: Int? = nil,
        updatedAt: Date = Date(),
        exitedAt: Date? = nil,
        exitCode: Int32? = nil,
        errorMessage: String? = nil,
        replaceErrorMessage: Bool = false
    ) -> DevServerRunSnapshot {
        DevServerRunSnapshot(
            runId: runId,
            key: key,
            profileName: profileName,
            workspaceId: workspaceId,
            worktreePath: worktreePath,
            cwd: cwd,
            command: command,
            phase: phase ?? self.phase,
            pid: clearPID ? nil : (pid ?? self.pid),
            urls: urls ?? self.urls,
            latestURL: replaceLatestURL ? latestURL : self.latestURL,
            recentErrorLines: recentErrorLines ?? self.recentErrorLines,
            logCursor: logCursor ?? self.logCursor,
            startedAt: startedAt,
            updatedAt: updatedAt,
            exitedAt: exitedAt ?? self.exitedAt,
            exitCode: exitCode ?? self.exitCode,
            errorMessage: replaceErrorMessage ? errorMessage : self.errorMessage
        )
    }
}
