// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Bonsplit
import Foundation
import SwiftUI
import os

/// Runs `git submodule update --init --recursive --progress` for a worktree
/// and surfaces progress through `SubmoduleInitStore` so the UI can render a
/// chip + sheet while it runs.
///
/// Entry point: `startInBackground(worktreePath:)` — fire-and-forget.
/// Registers a task in the store; the store observes progress. Used by
/// `WorktreeCoordinator.attach()` so the user's attach completes right away
/// and submodule population happens visibly.
enum SubmoduleInitService {
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "submodule-init"
    )

    /// UserDefaults key for the "Initialize submodules on new worktrees"
    /// toggle in TermLoop Settings. Default is `true` — opt-out. When
    /// `false`, neither entry point runs the init command.
    static let autoInitDefaultsKey = "termloop.autoInitSubmodules"

    /// Reads the setting, defaulting to `true` when the key is unset.
    static func isAutoInitEnabled() -> Bool {
        if let value = UserDefaults.standard.object(forKey: autoInitDefaultsKey) as? Bool {
            return value
        }
        return true
    }

    /// True iff `<worktreePath>/.gitmodules` exists. Callers skip the init
    /// entirely when there are no submodules.
    static func hasSubmodules(worktreePath: String) -> Bool {
        let gm = (worktreePath as NSString).appendingPathComponent(".gitmodules")
        return FileManager.default.fileExists(atPath: gm)
    }

    /// True when the worktree has submodules but at least one direct
    /// submodule directory is empty or missing. Used by
    /// `WorktreeCoordinator.attach()` to trigger init for existing
    /// worktrees whose submodules were never populated.
    static func hasUninitializedSubmodules(worktreePath: String) -> Bool {
        guard hasSubmodules(worktreePath: worktreePath) else { return false }
        let paths = directSubmodulePaths(in: worktreePath)
        guard !paths.isEmpty else { return false }
        let fm = FileManager.default
        for sub in paths {
            let full = (worktreePath as NSString).appendingPathComponent(sub)
            // Directory missing or empty (only . and ..) → not initialized
            if let contents = try? fm.contentsOfDirectory(atPath: full),
               !contents.isEmpty {
                continue
            }
            return true
        }
        return false
    }

    #if DEBUG
    private static func debugLog(_ message: @autoclosure () -> String) {
        dlog("submodule.init \(message())")
    }
    #endif

    /// Kicks off `git submodule update --init --recursive` in a detached
    /// task and registers a `SubmoduleInitStore.Task` so the UI can show
    /// progress + cancel. Returns immediately.
    ///
    /// When `branch` is non-nil, each direct submodule is checked out
    /// onto that branch after init completes — prevents orphan commits
    /// on detached HEAD.
    ///
    /// No-op when the setting is off or no `.gitmodules` exists.
    @MainActor
    static func startInBackground(worktreePath: String, displayLabel: String, branch: String? = nil, workspaceId: UUID? = nil) {
        #if DEBUG
        let autoInit = isAutoInitEnabled()
        let hasSubs = hasSubmodules(worktreePath: worktreePath)
        dlog("submodule.startInBackground autoInit=\(autoInit) hasSubs=\(hasSubs) path=\(worktreePath) wsId=\(workspaceId?.uuidString.prefix(5) ?? "nil")")
        #endif
        guard isAutoInitEnabled(),
              hasSubmodules(worktreePath: worktreePath) else { return }
        let descriptor = SubmoduleInitStore.shared.register(
            worktreePath: worktreePath, label: displayLabel, branch: branch, workspaceId: workspaceId
        )
        #if DEBUG
        dlog("submodule.startInBackground → registered task \(descriptor.id.uuidString.prefix(5)) tasks=\(SubmoduleInitStore.shared.tasks.count)")
        #endif
        DispatchQueue.global(qos: .utility).async {
            runBlocking(descriptor: descriptor)
        }
    }

    // MARK: - Runner (nonisolated — runs on a background queue)

    /// Shared stderr accumulator. `readabilityHandler` drains the pipe as
    /// data arrives, so by the time the process exits `readToEnd()` is
    /// empty. We capture everything here so the failure path has a real
    /// error message to surface.
    private final class StderrBuffer: @unchecked Sendable {
        private let lock = NSLock()
        private var storage = ""
        func append(_ s: String) {
            lock.lock(); storage += s; lock.unlock()
        }
        func snapshot() -> String {
            lock.lock(); defer { lock.unlock() }
            return storage
        }
    }

    fileprivate static func runBlocking(descriptor: SubmoduleInitStore.TaskDescriptor) {
        #if DEBUG
        debugLog(
            "run.begin task=\(descriptor.id.uuidString.prefix(8)) path=\(descriptor.worktreePath) branch=\(descriptor.branch ?? "nil")"
        )
        #endif
        // `git submodule update --init` in a worktree commonly fails with
        // exit 128 because the submodule URL in `.git/config` was never
        // copied into the worktree's per-worktree config. `submodule
        // sync --recursive` rewrites those URL entries from `.gitmodules`
        // so the following `update` has something to fetch/checkout
        // against. Ignore its exit status: if it fails, the main command
        // will surface a useful error anyway.
        _ = runGitSilently(
            args: ["submodule", "sync", "--recursive"],
            cwd: descriptor.worktreePath
        )
        #if DEBUG
        debugLog("sync.done task=\(descriptor.id.uuidString.prefix(8)) path=\(descriptor.worktreePath)")
        #endif

        let taskId = descriptor.id
        let process = Process()
        process.executableURL = URL(fileURLWithPath: GitExecutableResolver.resolvedGitPath() ?? "/usr/bin/git")
        process.arguments = [
            "submodule", "update", "--init", "--recursive", "--progress"
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: descriptor.worktreePath)

        let stderrPipe = Pipe()
        process.standardError = stderrPipe
        process.standardOutput = FileHandle.nullDevice

        let errBuffer = StderrBuffer()
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else {
                return
            }
            errBuffer.append(chunk)
            // Git prints `--progress` chatter to stderr; newline- and CR-
            // delimited. Split on both so each overwritten progress line
            // lands as its own update. Parsed into phase transitions on
            // the main actor (see `SubmoduleInitStore.ingestStderr`).
            let lines = chunk.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            for raw in lines {
                let line = String(raw).trimmingCharacters(in: .whitespaces)
                guard !line.isEmpty else { continue }
                SubmoduleInitStore.shared.ingestStderr(taskId: taskId, line: line)
            }
        }

        SubmoduleInitStore.shared.attachProcess(taskId: taskId, process: process)
        do {
            try process.run()
            stderrPipe.fileHandleForWriting.closeFile()
        } catch {
            logger.error("git submodule launch failed: \(String(describing: error), privacy: .public)")
            #if DEBUG
            debugLog(
                "run.launchFailed task=\(taskId.uuidString.prefix(8)) path=\(descriptor.worktreePath) error=\(String(describing: error))"
            )
            #endif
            SubmoduleInitStore.shared.ingestFinish(taskId: taskId, failed: "\(error)")
            return
        }
        process.waitUntilExit()
        stderrPipe.fileHandleForReading.readabilityHandler = nil

        if process.terminationReason == .uncaughtSignal {
            #if DEBUG
            debugLog("run.cancelled task=\(taskId.uuidString.prefix(8)) path=\(descriptor.worktreePath)")
            #endif
            SubmoduleInitStore.shared.ingestFinish(taskId: taskId, failed: "cancelled")
            return
        }
        if process.terminationStatus == 0 {
            // Checkout matching branch in direct submodules so agents
            // don't commit on detached HEAD (orphan commits).
            if let branch = descriptor.branch {
                checkoutSubmoduleBranches(
                    worktreePath: descriptor.worktreePath, branch: branch)
            }
            #if DEBUG
            debugLog("run.result task=\(taskId.uuidString.prefix(8)) path=\(descriptor.worktreePath) exit=0")
            #endif
            SubmoduleInitStore.shared.ingestFinish(taskId: taskId, failed: nil)
        } else {
            let errText = errBuffer.snapshot()
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let exitCode = process.terminationStatus
            // Keep the last ~4 non-progress lines of stderr so the user
            // sees the actual fatal message, not "Fetching submodule X
            // 45%". Git progress lines start with "remote:", "Receiving",
            // "Resolving", "Submodule path"; fatal lines start with
            // "fatal:" or "error:".
            let meaningfulTail = errText
                .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
                .map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { line in
                    !line.isEmpty
                        && !line.hasPrefix("Receiving objects:")
                        && !line.hasPrefix("Resolving deltas:")
                        && !line.hasPrefix("remote:")
                        && !line.hasPrefix("Cloning into")
                        && !line.hasPrefix("Submodule path ")
                }
                .suffix(4)
                .joined(separator: "\n")
            let message = meaningfulTail.isEmpty
                ? "git exit \(exitCode)"
                : "git exit \(exitCode) — \(meaningfulTail)"
            #if DEBUG
            debugLog("run.result task=\(taskId.uuidString.prefix(8)) path=\(descriptor.worktreePath) exit=\(exitCode) error=\(message)")
            #endif
            SubmoduleInitStore.shared.ingestFinish(taskId: taskId, failed: message)
        }
    }

    /// Checks out `branch` in each direct submodule of `worktreePath`.
    /// Tries existing branch first, falls back to creating a new one.
    /// Only operates on direct submodules (not recursive) — nested
    /// submodules (ghostty, bonsplit) stay at their pinned SHAs.
    ///
    /// Also creates the branch in the main working tree's copy of each
    /// submodule so tools like Sourcetree (which look at the main repo)
    /// can see the feature branch. Worktree submodules use a separate
    /// git directory, so branches created there aren't visible from the
    /// main working tree.
    private static func checkoutSubmoduleBranches(worktreePath: String, branch: String) {
        let normalizedWorktreePath = (worktreePath as NSString).standardizingPath
        let marker = "/\(WorktreeResolver.worktreesDirName)/"
        let projectRoot: String
        if let range = normalizedWorktreePath.range(of: marker, options: .backwards) {
            projectRoot = String(normalizedWorktreePath[..<range.lowerBound])
        } else {
            // Defensive fallback for unexpected layouts.
            projectRoot = (normalizedWorktreePath as NSString).deletingLastPathComponent
        }
        #if DEBUG
        debugLog("checkout.begin path=\(worktreePath) branch=\(branch) projectRoot=\(projectRoot)")
        #endif

        for subPath in directSubmodulePaths(in: worktreePath) {
            let fullPath = (worktreePath as NSString).appendingPathComponent(subPath)
            guard FileManager.default.fileExists(atPath: fullPath) else { continue }

            // Checkout branch in the worktree's submodule copy.
            let exitCode = runGitSilently(args: ["checkout", branch], cwd: fullPath)
            if exitCode != 0 {
                _ = runGitSilently(args: ["checkout", "-b", branch], cwd: fullPath)
            }

            // Mirror the branch in the main working tree's submodule so
            // Sourcetree / other GUI tools see it. Safe no-op if branch
            // already exists there.
            let mainSubPath = (projectRoot as NSString).appendingPathComponent(subPath)
            if FileManager.default.fileExists(atPath: mainSubPath) {
                _ = runGitSilently(args: ["branch", branch], cwd: mainSubPath)
            }

            #if DEBUG
            debugLog("checkout.submodule branch=\(branch) subPath=\(subPath) worktree=\(fullPath) main=\(mainSubPath) state=\(exitCode == 0 ? "existing" : "created")")
            #endif
        }
        #if DEBUG
        debugLog("checkout.result path=\(worktreePath) branch=\(branch)")
        #endif
    }

    /// Returns paths of direct submodules by running `git submodule status`.
    /// Output format: ` <sha> <path> (<desc>)` — we extract the path field.
    private static func directSubmodulePaths(in worktreePath: String) -> [String] {
        guard let output = try? GitCommandRunner.runThrowing(
            ["submodule", "status"],
            in: worktreePath,
            kind: .submodule,
            caller: "SubmoduleInitService.directSubmodulePaths",
            timeout: 30
        ) else { return [] }
        return output.split(separator: "\n").compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // Format: "[+ ]<sha> <path> [(<desc>)]"
            let cleaned = trimmed.hasPrefix("+") || trimmed.hasPrefix("-")
                ? String(trimmed.dropFirst()) : trimmed
            let parts = cleaned.trimmingCharacters(in: .whitespaces)
                .split(separator: " ", maxSplits: 2)
            guard parts.count >= 2 else { return nil }
            return String(parts[1])
        }
    }

    /// Helper for auxiliary git commands whose output we don't need (the
    /// warmup `submodule sync` call). Runs synchronously on the caller's
    /// thread and returns the exit code.
    @discardableResult
    private static func runGitSilently(args: [String], cwd: String) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: GitExecutableResolver.resolvedGitPath() ?? "/usr/bin/git")
        p.arguments = args
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return -1
        }
        p.waitUntilExit()
        return p.terminationStatus
    }
}

/// Observable store of in-flight + recently-finished submodule init tasks.
/// `TermLoopSidebar.Footer` observes this to render a progress chip; the
/// chip opens a sheet that lists each task with per-submodule progress and
/// a Cancel button.
@MainActor
final class SubmoduleInitStore: ObservableObject {
    static let shared = SubmoduleInitStore()

    enum Phase: Equatable {
        case starting
        case running(submodule: String?, percent: Double?)
        case failed(reason: String)
        case completed
    }

    /// Lightweight descriptor the nonisolated runner carries without needing
    /// a main-actor reference to the full `Task` object.
    struct TaskDescriptor: Sendable {
        let id: UUID
        let worktreePath: String
        let workspaceId: UUID?
        /// When set, direct submodules are checked out onto this branch
        /// after init completes (prevents detached HEAD orphan commits).
        let branch: String?
    }

    final class Task: ObservableObject, Identifiable {
        let id: UUID
        let worktreePath: String
        let workspaceId: UUID?
        /// Branch to checkout in submodules after init. Stored so retry
        /// can re-use it when the first attempt fails.
        let branch: String?
        let label: String
        let startedAt = Date()
        @Published var phase: Phase = .starting
        /// Last stderr line, shown as a subtitle so the user can see raw
        /// git output during weird states (resolving deltas, fetching
        /// submodules of submodules, etc.).
        @Published var lastLine: String = ""

        /// Process handle set via `attachProcess` so the cancel button can
        /// `terminate()` from the UI. `Process.terminate()` is thread-safe.
        private let processLock = NSLock()
        private var _process: Process?

        init(id: UUID, worktreePath: String, workspaceId: UUID?, branch: String?, label: String) {
            self.id = id
            self.worktreePath = worktreePath
            self.workspaceId = workspaceId
            self.branch = branch
            self.label = label
        }

        func setProcess(_ p: Process) {
            processLock.lock()
            defer { processLock.unlock() }
            _process = p
        }

        func cancel() {
            processLock.lock()
            let p = _process
            processLock.unlock()
            p?.terminate()
        }
    }

    @Published private(set) var tasks: [Task] = []

    private init() {}

    /// Creates a new task and returns a descriptor the nonisolated runner
    /// can use to report progress.
    func register(worktreePath: String, label: String, branch: String? = nil, workspaceId: UUID? = nil) -> TaskDescriptor {
        let task = Task(id: UUID(), worktreePath: worktreePath, workspaceId: workspaceId, branch: branch, label: label)
        tasks.append(task)
        return TaskDescriptor(id: task.id, worktreePath: worktreePath, workspaceId: workspaceId, branch: branch)
    }

    /// Called from the background runner once `Process.run()` succeeds.
    /// Safe to call off-main — `Task.setProcess` takes its own lock.
    nonisolated func attachProcess(taskId: UUID, process: Process) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let task = self.tasks.first(where: { $0.id == taskId }) else { return }
            task.setProcess(process)
        }
    }

    /// Called from the background stderr reader on every parsed line.
    /// Hops to main to update the `@Published` phase so SwiftUI
    /// re-renders on the correct thread.
    nonisolated func ingestStderr(taskId: UUID, line: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let task = self.tasks.first(where: { $0.id == taskId }) else { return }
            task.lastLine = line
            if let match = Self.cloningInto(line: line) {
                task.phase = .running(submodule: match, percent: nil)
            } else if let pct = Self.receivingObjectsPercent(line: line) {
                let existing = Self.currentSubmodule(of: task.phase)
                task.phase = .running(submodule: existing, percent: pct)
            } else if let pct = Self.resolvingDeltas(line: line) {
                let existing = Self.currentSubmodule(of: task.phase)
                task.phase = .running(submodule: existing, percent: pct)
            } else if let sub = Self.checkedOut(line: line) {
                task.phase = .running(submodule: sub, percent: 1.0)
            }
        }
    }

    /// Called from the background runner on git exit / launch failure.
    nonisolated func ingestFinish(taskId: UUID, failed: String?) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let task = self.tasks.first(where: { $0.id == taskId }) else { return }
            if let reason = failed {
                task.phase = .failed(reason: reason)
            } else {
                task.phase = .completed
            }
            // Auto-remove successful tasks after a short delay so the chip
            // clears on its own. Failed tasks stay so the user can inspect.
            if failed == nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                    self?.dismiss(taskId: taskId)
                }
            }
        }
    }

    /// Removes a task from the visible list. Safe to call on both running
    /// and terminal tasks — running ones are cancelled first.
    func dismiss(taskId: UUID) {
        if let task = tasks.first(where: { $0.id == taskId }) {
            task.cancel()
        }
        tasks.removeAll { $0.id == taskId }
    }

    /// Returns the first non-completed task for the given workspace, if any.
    /// Used by `WorkspaceContentView` to gate terminal rendering — when
    /// non-nil, the content area shows a progress view instead of terminals.
    func activeTask(for workspaceId: UUID) -> Task? {
        tasks.first { task in
            task.workspaceId == workspaceId && {
                switch task.phase {
                case .starting, .running, .failed: return true
                case .completed: return false
                }
            }()
        }
    }

    /// Re-runs submodule init for a failed task. Resets phase to `.starting`
    /// and kicks off the background runner again.
    func retry(taskId: UUID) {
        guard let task = tasks.first(where: { $0.id == taskId }),
              case .failed = task.phase else { return }
        task.phase = .starting
        task.lastLine = ""
        let descriptor = TaskDescriptor(
            id: task.id,
            worktreePath: task.worktreePath,
            workspaceId: task.workspaceId,
            branch: task.branch
        )
        DispatchQueue.global(qos: .utility).async {
            SubmoduleInitService.runBlocking(descriptor: descriptor)
        }
    }

    // MARK: - Stderr parsers

    private static func currentSubmodule(of phase: Phase) -> String? {
        if case let .running(sub, _) = phase { return sub }
        return nil
    }

    /// Matches `Cloning into '<path>'...` → captured path.
    static func cloningInto(line: String) -> String? {
        let prefix = "Cloning into '"
        guard line.hasPrefix(prefix) else { return nil }
        let start = line.index(line.startIndex, offsetBy: prefix.count)
        guard let endQuote = line.range(of: "'", range: start..<line.endIndex) else {
            return nil
        }
        return String(line[start..<endQuote.lowerBound])
    }

    /// Matches `Receiving objects:  45% (...)` → 0.45.
    static func receivingObjectsPercent(line: String) -> Double? {
        guard line.hasPrefix("Receiving objects:") else { return nil }
        return parsePercent(line: line)
    }

    /// Matches `Resolving deltas:  50% (...)` → 0.50.
    static func resolvingDeltas(line: String) -> Double? {
        guard line.hasPrefix("Resolving deltas:") else { return nil }
        return parsePercent(line: line)
    }

    /// Matches `Submodule path '<p>': checked out '<sha>'` → path.
    static func checkedOut(line: String) -> String? {
        let prefix = "Submodule path '"
        guard line.hasPrefix(prefix), line.contains("': checked out") else { return nil }
        let start = line.index(line.startIndex, offsetBy: prefix.count)
        guard let endQuote = line.range(of: "'", range: start..<line.endIndex) else {
            return nil
        }
        return String(line[start..<endQuote.lowerBound])
    }

    private static func parsePercent(line: String) -> Double? {
        guard let percentIdx = line.firstIndex(of: "%") else { return nil }
        // Walk back from `%` over digits (and decimal) to get the leading
        // number. Fail if we never found any digits.
        var idx = percentIdx
        while idx > line.startIndex {
            let prev = line.index(before: idx)
            let ch = line[prev]
            if ch.isWholeNumber || ch == "." {
                idx = prev
                continue
            }
            break
        }
        let slice = line[idx..<percentIdx].trimmingCharacters(in: .whitespaces)
        guard let value = Double(slice) else { return nil }
        return max(0.0, min(1.0, value / 100.0))
    }
}
