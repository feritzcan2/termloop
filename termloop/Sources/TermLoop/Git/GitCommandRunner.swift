// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Bonsplit
import Foundation
import os

/// Central git process runner for TermLoop-owned git call sites.
///
/// This is intentionally not a cache. Presentation reads may be cached by a
/// higher-level snapshot provider; workflow/mutation calls must always execute.
/// The runner owns process safety concerns that apply to both paths: timeout,
/// caller labels, command-kind defaults, telemetry, and mutation invalidation
/// notifications. In this first phase the invalidation center has no required
/// subscribers; the presentation snapshot provider wires into it later.
enum GitCommandRunner {
    private static let logger = Logger(subsystem: "com.termloop.git", category: "runner")

    enum CommandKind: String {
        case revParse
        case branch
        case status
        case remote
        case diff
        case history
        case fetch
        case worktree
        case submodule
        case mutation
        case genericRead

        var defaultTimeout: TimeInterval {
            switch self {
            case .revParse, .branch:
                return 1
            case .remote:
                return 2
            case .status:
                return 5
            case .diff, .history:
                return 10
            case .fetch, .worktree, .mutation:
                return 30
            case .submodule:
                return 300
            case .genericRead:
                return 5
            }
        }

        static func classify(arguments: [String]) -> CommandKind {
            guard let first = arguments.first else { return .genericRead }
            switch first {
            case "rev-parse", "symbolic-ref":
                return .revParse
            case "branch":
                if arguments.contains("-D") || arguments.contains("-d") || arguments.contains("--delete") {
                    return .mutation
                }
                return .branch
            case "add", "commit", "checkout", "cherry-pick", "merge", "mv", "rebase", "reset", "restore", "rm", "stash", "switch":
                return .mutation
            case "status":
                return .status
            case "remote":
                if let subcommand = arguments.dropFirst().first,
                   ["add", "remove", "rename", "set-url", "prune"].contains(subcommand) {
                    return .mutation
                }
                return .remote
            case "diff", "show":
                return .diff
            case "log", "rev-list", "merge-base":
                return .history
            case "fetch":
                return .fetch
            case "worktree":
                if arguments.contains("add") || arguments.contains("remove") || arguments.contains("prune") {
                    return .worktree
                }
                return .genericRead
            case "submodule":
                return .submodule
            case "apply", "clean", "config", "update-index":
                return .mutation
            default:
                return .genericRead
            }
        }
    }

    enum RunError: Error, LocalizedError {
        case gitNotFound(path: String)
        case launchFailed(command: String, underlying: String)
        case timedOut(command: String, timeout: TimeInterval)
        case failed(command: String, stderr: String, exitCode: Int32)

        var errorDescription: String? {
            switch self {
            case .gitNotFound(let path):
                return "git executable not found at \(path)"
            case .launchFailed(let command, let underlying):
                return "\(command) failed to launch: \(underlying)"
            case .timedOut(let command, let timeout):
                return "\(command) timed out after \(String(format: "%.1f", timeout))s"
            case .failed(let command, let stderr, let exitCode):
                let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return detail.isEmpty ? "\(command) failed with exit code \(exitCode)" : detail
            }
        }

        var stderr: String {
            switch self {
            case .failed(_, let stderr, _):
                return stderr
            case .launchFailed(_, let underlying):
                return underlying
            case .timedOut:
                return "git timed out"
            case .gitNotFound(let path):
                return "git executable not found at \(path)"
            }
        }

        var exitCode: Int32 {
            switch self {
            case .failed(_, _, let exitCode):
                return exitCode
            case .timedOut:
                return 124
            case .gitNotFound, .launchFailed:
                return -1
            }
        }
    }

    @discardableResult
    static func runOptional(
        _ arguments: [String],
        in directory: String,
        kind: CommandKind? = nil,
        caller: String,
        timeout: TimeInterval? = nil,
        stdin: Data? = nil
    ) -> String? {
        try? runThrowing(
            arguments,
            in: directory,
            kind: kind,
            caller: caller,
            timeout: timeout,
            stdin: stdin
        )
    }

    @discardableResult
    static func runThrowing(
        _ arguments: [String],
        in directory: String,
        kind explicitKind: CommandKind? = nil,
        caller: String,
        timeout explicitTimeout: TimeInterval? = nil,
        stdin: Data? = nil
    ) throws -> String {
        let kind = explicitKind ?? CommandKind.classify(arguments: arguments)
        let timeout = explicitTimeout ?? kind.defaultTimeout
        let normalizedDirectory = URL(fileURLWithPath: directory).standardizedFileURL.path
        let command = commandDescription(arguments: arguments)
        let startedAt = Date()
        var exitCode: Int32 = -1
        var timedOut = false
        var stderrText = ""

        defer {
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            logTelemetry(
                caller: caller,
                kind: kind,
                command: command,
                directory: normalizedDirectory,
                durationMs: durationMs,
                exitCode: exitCode,
                timedOut: timedOut
            )
        }

        guard let gitPath = GitExecutableResolver.resolvedGitPath() else {
            throw RunError.gitNotFound(path: "git")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: gitPath)
        process.arguments = launchArguments(arguments, kind: kind)
        process.currentDirectoryURL = URL(fileURLWithPath: normalizedDirectory)
        process.environment = environment(kind: kind)

        logOptionalLockModeIfNeeded(
            caller: caller,
            kind: kind,
            command: command,
            directory: normalizedDirectory
        )

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        var stdinPipe: Pipe?
        if stdin != nil {
            let pipe = Pipe()
            process.standardInput = pipe
            stdinPipe = pipe
        }

        let stdoutDrain = drain(stdout.fileHandleForReading)
        let stderrDrain = drain(stderr.fileHandleForReading)
        let terminationSemaphore = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in terminationSemaphore.signal() }

        do {
            try process.run()
        } catch {
            process.terminationHandler = nil
            stdout.fileHandleForWriting.closeFile()
            stderr.fileHandleForWriting.closeFile()
            throw RunError.launchFailed(command: command, underlying: String(describing: error))
        }
        // Close the parent's write ends. Otherwise pipe reads can
        // wait forever even after the child exits because this process still
        // owns an open writer for the pipe.
        stdout.fileHandleForWriting.closeFile()
        stderr.fileHandleForWriting.closeFile()

        if let stdin, let stdinPipe {
            stdinPipe.fileHandleForWriting.write(stdin)
            stdinPipe.fileHandleForWriting.closeFile()
        }

        timedOut = waitForTermination(
            process,
            timeout: timeout,
            semaphore: terminationSemaphore
        )
        exitCode = process.terminationStatus

        let drainTimeout = max(1, min(5, timeout))
        let outData = stdoutDrain(drainTimeout)
        let errData = stderrDrain(drainTimeout)
        stderrText = String(data: errData, encoding: .utf8) ?? ""

        if timedOut {
            throw RunError.timedOut(command: command, timeout: timeout)
        }

        guard exitCode == 0 else {
            throw RunError.failed(command: command, stderr: stderrText, exitCode: exitCode)
        }

        return String(data: outData, encoding: .utf8) ?? ""
    }

    @discardableResult
    static func runMutation(
        _ arguments: [String],
        in directory: String,
        kind: CommandKind? = nil,
        caller: String,
        invalidates targets: [GitInvalidationTarget],
        timeout: TimeInterval? = nil,
        stdin: Data? = nil
    ) throws -> String {
        let output = try runThrowing(
            arguments,
            in: directory,
            kind: kind ?? CommandKind.classify(arguments: arguments),
            caller: caller,
            timeout: timeout,
            stdin: stdin
        )
        GitPresentationInvalidationCenter.invalidate(
            targets,
            reason: caller,
            source: commandDescription(arguments: arguments)
        )
        return output
    }

    private static func waitForTermination(
        _ process: Process,
        timeout: TimeInterval,
        semaphore: DispatchSemaphore
    ) -> Bool {
        if !process.isRunning {
            process.terminationHandler = nil
            return false
        }

        let didTimeOut = semaphore.wait(timeout: .now() + timeout) == .timedOut
        if didTimeOut, process.isRunning {
            process.terminate()
            if semaphore.wait(timeout: .now() + 1) == .timedOut, process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                _ = semaphore.wait(timeout: .now() + 1)
            }
        }

        process.terminationHandler = nil
        return didTimeOut
    }

    private static func environment(kind: CommandKind) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        if disablesOptionalLocks(kind: kind) {
            // Presentation reads must never contend with user/agent writes.
            // Plain `git status` may refresh and rewrite the index, which
            // creates `.git/.../index.lock` even though the caller only needs
            // display data. This keeps TermLoop from racing `git commit`,
            // `git add`, PR scripts, and other write-side git operations.
            environment["GIT_OPTIONAL_LOCKS"] = "0"
        }
        return environment
    }

    private static func disablesOptionalLocks(kind: CommandKind) -> Bool {
        switch kind {
        case .revParse, .branch, .status, .remote, .diff, .history, .genericRead:
            return true
        case .fetch, .worktree, .submodule, .mutation:
            return false
        }
    }

    private static func launchArguments(_ arguments: [String], kind: CommandKind) -> [String] {
        guard disablesOptionalLocks(kind: kind) else { return arguments }
        guard arguments.first != "--no-optional-locks" else { return arguments }
        return ["--no-optional-locks"] + arguments
    }

    private static func logOptionalLockModeIfNeeded(
        caller: String,
        kind: CommandKind,
        command: String,
        directory: String
    ) {
#if DEBUG
        guard disablesOptionalLocks(kind: kind) else { return }
        let lockPath = indexLockPath(near: directory)
        let lockState: String
        if let lockPath, FileManager.default.fileExists(atPath: lockPath) {
            lockState = "present:\(lockPath)"
        } else {
            lockState = "absent"
        }
        dlog(
            "git.optionalLocks.disabled caller=\(caller) kind=\(kind.rawValue) " +
            "cwd=\(directory) lock=\(lockState) cmd=\(command)"
        )
#endif
    }

    private static func indexLockPath(near directory: String) -> String? {
        let fileManager = FileManager.default
        var url = URL(fileURLWithPath: directory).standardizedFileURL
        var isDirectory = ObjCBool(false)
        if !fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) || !isDirectory.boolValue {
            url.deleteLastPathComponent()
        }

        while true {
            let dotGit = url.appendingPathComponent(".git")
            var dotGitIsDirectory = ObjCBool(false)
            if fileManager.fileExists(atPath: dotGit.path, isDirectory: &dotGitIsDirectory) {
                if dotGitIsDirectory.boolValue {
                    return dotGit.appendingPathComponent("index.lock").path
                }
                if let contents = try? String(contentsOf: dotGit, encoding: .utf8),
                   let gitDir = parseGitDirFile(contents, relativeTo: url) {
                    return gitDir.appendingPathComponent("index.lock").path
                }
            }

            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { return nil }
            url = parent
        }
    }

    private static func parseGitDirFile(_ contents: String, relativeTo worktreeDirectory: URL) -> URL? {
        guard let line = contents
            .components(separatedBy: .newlines)
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            line.lowercased().hasPrefix("gitdir:")
        else {
            return nil
        }
        let rawPath = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        let url = rawPath.hasPrefix("/")
            ? URL(fileURLWithPath: rawPath)
            : worktreeDirectory.appendingPathComponent(rawPath)
        return url.standardizedFileURL
    }

    private static func drain(_ handle: FileHandle) -> (TimeInterval) -> Data {
        let group = DispatchGroup()
        let lock = NSLock()
        var data = Data()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = buffer.withUnsafeMutableBytes { rawBuffer in
                    Darwin.read(handle.fileDescriptor, rawBuffer.baseAddress, rawBuffer.count)
                }
                if count > 0 {
                    lock.lock()
                    buffer.withUnsafeBufferPointer { pointer in
                        if let baseAddress = pointer.baseAddress {
                            data.append(baseAddress, count: count)
                        }
                    }
                    lock.unlock()
                    continue
                }
                if count == 0 || errno == EBADF {
                    break
                }
                if errno == EINTR {
                    continue
                }
                break
            }
            group.leave()
        }
        return { timeout in
            if group.wait(timeout: .now() + timeout) == .timedOut {
                try? handle.close()
                _ = group.wait(timeout: .now() + 0.2)
            }
            lock.lock()
            let drained = data
            lock.unlock()
            return drained
        }
    }

    private static func commandDescription(arguments: [String]) -> String {
        let joined = (["git"] + arguments).joined(separator: " ")
        if joined.count <= 220 { return joined }
        return String(joined.prefix(217)) + "..."
    }

    private static func logTelemetry(
        caller: String,
        kind: CommandKind,
        command: String,
        directory: String,
        durationMs: Int,
        exitCode: Int32,
        timedOut: Bool
    ) {
#if DEBUG
        logger.debug("git.run caller=\(caller, privacy: .public) kind=\(kind.rawValue, privacy: .public) durationMs=\(durationMs) exit=\(exitCode) timeout=\(timedOut ? 1 : 0) cwd=\(directory, privacy: .public) cmd=\(command, privacy: .public)")
#endif
    }
}

enum GitInvalidationTarget: Hashable {
    case worktree(String)
    case project(String)
    case directory(String)
    case all

    var normalized: GitInvalidationTarget {
        switch self {
        case .worktree(let path):
            return .worktree(URL(fileURLWithPath: path).standardizedFileURL.path)
        case .project(let path):
            return .project(URL(fileURLWithPath: path).standardizedFileURL.path)
        case .directory(let path):
            return .directory(URL(fileURLWithPath: path).standardizedFileURL.path)
        case .all:
            return .all
        }
    }
}

struct GitInvalidationEvent: Equatable {
    let targets: [GitInvalidationTarget]
    let reason: String
    let source: String
    let timestamp: Date
}

/// Lightweight invalidation bus. PR 1 records and broadcasts successful write
/// operations; PR 2's presentation store will subscribe and turn these events
/// into active snapshot re-fetches. With no subscribers this is intentionally a
/// no-op beyond retaining a small debug/test history.
enum GitPresentationInvalidationCenter {
    private static let logger = Logger(subsystem: "com.termloop.git", category: "invalidation")
    typealias Handler = (GitInvalidationEvent) -> Void

    final class ObservationToken {
        private let id: UUID
        private var isCancelled = false

        fileprivate init(id: UUID) {
            self.id = id
        }

        deinit {
            cancel()
        }

        func cancel() {
            guard !isCancelled else { return }
            isCancelled = true
            GitPresentationInvalidationCenter.removeObserver(id: id)
        }
    }

    nonisolated(unsafe) private static var observers: [UUID: Handler] = [:]
    nonisolated(unsafe) private static var recentEvents: [GitInvalidationEvent] = []
    private static let lock = NSLock()
    private static let recentLimit = 128

    @discardableResult
    static func observe(_ handler: @escaping Handler) -> ObservationToken {
        let id = UUID()
        lock.lock()
        observers[id] = handler
        lock.unlock()
        return ObservationToken(id: id)
    }

    static func invalidate(
        _ targets: [GitInvalidationTarget],
        reason: String,
        source: String
    ) {
        guard !targets.isEmpty else { return }
        let event = GitInvalidationEvent(
            targets: targets.map(\.normalized),
            reason: reason,
            source: source,
            timestamp: Date()
        )

        let handlers: [Handler]
        lock.lock()
        recentEvents.append(event)
        if recentEvents.count > recentLimit {
            recentEvents.removeFirst(recentEvents.count - recentLimit)
        }
        handlers = Array(observers.values)
        lock.unlock()

#if DEBUG
        logger.debug("git.invalidate reason=\(reason, privacy: .public) source=\(source, privacy: .public) targets=\(event.targets.count)")
#endif

        for handler in handlers {
            handler(event)
        }
    }

    static func recentInvalidations() -> [GitInvalidationEvent] {
        lock.lock()
        defer { lock.unlock() }
        return recentEvents
    }

    private static func removeObserver(id: UUID) {
        lock.lock()
        observers.removeValue(forKey: id)
        lock.unlock()
    }
}

enum GitExecutableResolver {
    static func resolvedGitPath(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fallbackDirectories: [String] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    ) -> String? {
        resolve(
            executable: "git",
            environment: environment,
            fallbackDirectories: fallbackDirectories
        )
    }

    static func resolve(
        executable: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fallbackDirectories: [String] = []
    ) -> String? {
        guard !executable.isEmpty else { return nil }
        let fileManager = FileManager.default
        if executable.contains("/") {
            return fileManager.isExecutableFile(atPath: executable) ? executable : nil
        }

        var searchDirectories: [String] = []
        var seenDirectories: Set<String> = []
        func appendPath(_ raw: String?) {
            guard let raw else { return }
            for component in raw.split(separator: ":").map(String.init) {
                let trimmed = component.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, seenDirectories.insert(trimmed).inserted else { continue }
                searchDirectories.append(trimmed)
            }
        }

        appendPath(environment["PATH"])
        appendPath(getenv("PATH").map { String(cString: $0) })
        fallbackDirectories.forEach { appendPath($0) }

        for directory in searchDirectories {
            let candidate = URL(fileURLWithPath: directory, isDirectory: true)
                .appendingPathComponent(executable)
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}
