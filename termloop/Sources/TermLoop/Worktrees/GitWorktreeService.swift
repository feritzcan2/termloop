// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Synchronous wrapper around `git worktree *` and `git branch --list`. All
/// methods throw `WorktreeError` on failure. Call from a background queue if
/// blocking is a concern — the v2 socket path already dispatches via
/// `v2MainSync` which runs on the caller's thread.
struct GitWorktreeService {
    struct ListEntry: Equatable {
        let path: String
        let branch: String?
        let head: String
        let isMain: Bool
        let isLocked: Bool
        let isPrunable: Bool
    }

    struct BranchEntry: Equatable {
        let name: String
        let isCurrent: Bool
        let lastCommitAt: Date?
        let checkedOutPath: String?
    }

    static let defaultTimeout: TimeInterval = 30

    private let gitPath: String

    init(gitPath: String = GitExecutableResolver.resolvedGitPath() ?? "/usr/bin/git") {
        self.gitPath = gitPath
    }

    #if DEBUG
    private static let logger = Logger(
        subsystem: "com.termloop.fork",
        category: "worktree-git"
    )

    private static func debugLog(_ message: String) {
        logger.debug("\(message, privacy: .public)")
    }
    #endif

    // MARK: - Public API

    func list(in folder: String) throws -> [ListEntry] {
        #if DEBUG
        Self.debugLog("list.begin folder=\(folder)")
        #endif
        let output = try run(["worktree", "list", "--porcelain"], in: folder)
        let parsed = Self.parseWorktreeList(output)
        #if DEBUG
        Self.debugLog("list.result folder=\(folder) count=\(parsed.count)")
        #endif
        return parsed
    }

    func add(folder: String, path: String, branch: String) throws {
        #if DEBUG
        Self.debugLog("add.begin folder=\(folder) path=\(path) branch=\(branch)")
        #endif
        try ensureParent(for: path)
        _ = try run(["worktree", "add", path, branch], in: folder)
        #if DEBUG
        Self.debugLog("add.result folder=\(folder) path=\(path) branch=\(branch)")
        #endif
    }

    func move(folder: String, from oldPath: String, to newPath: String) throws {
        #if DEBUG
        Self.debugLog("move.begin folder=\(folder) from=\(oldPath) to=\(newPath)")
        #endif
        try ensureParent(for: newPath)
        _ = try run(["worktree", "move", oldPath, newPath], in: folder)
        #if DEBUG
        Self.debugLog("move.result folder=\(folder) from=\(oldPath) to=\(newPath)")
        #endif
    }

    func addCreatingBranch(folder: String, path: String, branch: String, baseRef: String) throws {
        #if DEBUG
        Self.debugLog("addBranch.begin folder=\(folder) path=\(path) branch=\(branch) baseRef=\(baseRef)")
        #endif
        try ensureParent(for: path)
        _ = try run(["worktree", "add", "-b", branch, path, baseRef], in: folder)
        #if DEBUG
        Self.debugLog("addBranch.result folder=\(folder) path=\(path) branch=\(branch)")
        #endif
    }

    func remove(folder: String, path: String, force: Bool = false) throws {
        #if DEBUG
        Self.debugLog("remove.begin folder=\(folder) path=\(path) force=\(force)")
        #endif
        var args = ["worktree", "remove"]
        if force { args.append("--force") }
        args.append(path)
        _ = try run(args, in: folder)
        #if DEBUG
        Self.debugLog("remove.result folder=\(folder) path=\(path) force=\(force)")
        #endif
    }

    func prune(folder: String) throws {
        #if DEBUG
        Self.debugLog("prune.begin folder=\(folder)")
        #endif
        _ = try run(["worktree", "prune"], in: folder)
        #if DEBUG
        Self.debugLog("prune.result folder=\(folder)")
        #endif
    }

    /// Re-attaches a worktree directory whose `.git` linker is intact but
    /// whose entry under the main repo's `.git/worktrees/<name>/` is stale or
    /// missing. No-op when nothing needs repair. Pass paths to repair just
    /// those, or empty to scan everything git knows about.
    func repair(folder: String, paths: [String] = []) throws {
        #if DEBUG
        Self.debugLog("repair.begin folder=\(folder) paths=\(paths.joined(separator: ","))")
        #endif
        var args = ["worktree", "repair"]
        args.append(contentsOf: paths)
        _ = try run(args, in: folder)
        #if DEBUG
        Self.debugLog("repair.result folder=\(folder)")
        #endif
    }

    func isClean(worktreePath: String) throws -> Bool {
        #if DEBUG
        Self.debugLog("status.begin path=\(worktreePath)")
        #endif
        let out = try run(["status", "--porcelain"], in: worktreePath)
        let clean = out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        #if DEBUG
        Self.debugLog("status.result path=\(worktreePath) clean=\(clean)")
        #endif
        return clean
    }

    func headRevision(worktreePath: String) throws -> String {
        #if DEBUG
        Self.debugLog("head.begin path=\(worktreePath)")
        #endif
        let out = try run(["rev-parse", "HEAD"], in: worktreePath)
        let head = out.trimmingCharacters(in: .whitespacesAndNewlines)
        #if DEBUG
        Self.debugLog("head.result path=\(worktreePath) head=\(head)")
        #endif
        return head
    }

    /// Resolves the tip commit of a local branch (e.g. `refs/heads/<name>`).
    /// Returns nil when the branch does not resolve. Used to safely accept a
    /// detached worktree at a deterministic path only when its HEAD already
    /// matches the requested branch's tip.
    func branchTipRevision(folder: String, branch: String) -> String? {
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let out = try? run(["rev-parse", "--verify", "refs/heads/\(trimmed)"], in: folder)
        let value = out?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }

    func currentBranch(in folder: String) throws -> String {
        #if DEBUG
        Self.debugLog("branch.begin folder=\(folder)")
        #endif
        let out = try run(["rev-parse", "--abbrev-ref", "HEAD"], in: folder)
        let branch = out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !branch.isEmpty, branch != "HEAD" else {
            throw WorktreeError.invalidParams(
                reason: "The project root is not on a local branch."
            )
        }
        #if DEBUG
        Self.debugLog("branch.result folder=\(folder) branch=\(branch)")
        #endif
        return branch
    }

    func isAncestor(revision: String, of descendantRevision: String, in folder: String) throws -> Bool {
        guard FileManager.default.isExecutableFile(atPath: gitPath) else {
            throw WorktreeError.gitNotFound
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: gitPath)
        task.arguments = ["merge-base", "--is-ancestor", revision, descendantRevision]
        task.currentDirectoryURL = URL(fileURLWithPath: folder)

        let stderr = Pipe()
        task.standardError = stderr

        do {
            try task.run()
            stderr.fileHandleForWriting.closeFile()
        } catch {
            throw WorktreeError.gitCommandFailed(
                command: "git merge-base --is-ancestor \(revision) \(descendantRevision)",
                stderr: "\(error)",
                exitCode: -1
            )
        }

        let didTimeOut = waitForTermination(task, timeout: Self.defaultTimeout)

        if task.terminationStatus == 0 {
            return true
        }
        if task.terminationStatus == 1 {
            return false
        }

        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        let errString = String(data: errData, encoding: .utf8) ?? ""
        if didTimeOut && errString.isEmpty {
            throw WorktreeError.timeout(
                command: "git merge-base --is-ancestor \(revision) \(descendantRevision)"
            )
        }
        throw WorktreeError.gitCommandFailed(
            command: "git merge-base --is-ancestor \(revision) \(descendantRevision)",
            stderr: errString,
            exitCode: task.terminationStatus
        )
    }

    func diffAgainstHead(worktreePath: String) throws -> String {
        #if DEBUG
        Self.debugLog("diff.begin path=\(worktreePath)")
        #endif
        let diff = try run(["diff", "--binary", "--full-index", "--no-ext-diff", "HEAD"], in: worktreePath)
        #if DEBUG
        Self.debugLog("diff.result path=\(worktreePath) len=\(diff.count)")
        #endif
        return diff
    }

    func untrackedPaths(worktreePath: String) throws -> [String] {
        #if DEBUG
        Self.debugLog("untracked.begin path=\(worktreePath)")
        #endif
        let out = try run(
            ["ls-files", "--others", "--exclude-standard", "-z"],
            in: worktreePath
        )
        let paths = out
            .split(separator: "\0")
            .map(String.init)
            .filter { !$0.isEmpty }
        #if DEBUG
        Self.debugLog("untracked.result path=\(worktreePath) count=\(paths.count)")
        #endif
        return paths
    }

    func canApplyPatch(_ patch: String, in folder: String) throws -> Bool {
        #if DEBUG
        Self.debugLog("applyCheck.begin folder=\(folder) len=\(patch.count)")
        #endif
        do {
            _ = try run(
                ["apply", "--check", "--binary", "--allow-empty", "-"],
                in: folder,
                stdin: Data(patch.utf8)
            )
            #if DEBUG
            Self.debugLog("applyCheck.result folder=\(folder) canApply=1")
            #endif
            return true
        } catch WorktreeError.gitCommandFailed {
            #if DEBUG
            Self.debugLog("applyCheck.result folder=\(folder) canApply=0")
            #endif
            return false
        }
    }

    func applyPatch(_ patch: String, in folder: String) throws {
        #if DEBUG
        Self.debugLog("apply.begin folder=\(folder) len=\(patch.count)")
        #endif
        _ = try run(
            ["apply", "--binary", "--allow-empty", "-"],
            in: folder,
            stdin: Data(patch.utf8)
        )
        #if DEBUG
        Self.debugLog("apply.result folder=\(folder)")
        #endif
    }

    func branches(in folder: String, query: String? = nil) throws -> [BranchEntry] {
        #if DEBUG
        Self.debugLog("branches.begin folder=\(folder) query=\(query ?? "nil")")
        #endif
        let format = "%(refname:short)|%(committerdate:unix)|%(HEAD)"
        let out = try run(["branch", "--list", "--format=\(format)"], in: folder)
        let worktrees = try list(in: folder)
        var checkoutByBranch: [String: String] = [:]
        for w in worktrees {
            if let b = w.branch { checkoutByBranch[b] = w.path }
        }

        var entries: [BranchEntry] = []
        for line in out.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3 else { continue }
            let name = String(parts[0]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { continue }
            if let q = query, !q.isEmpty,
               name.range(of: q, options: .caseInsensitive) == nil { continue }
            let ts = TimeInterval(parts[1]) ?? 0
            let date = ts > 0 ? Date(timeIntervalSince1970: ts) : nil
            let isCurrent = String(parts[2]).trimmingCharacters(in: .whitespaces) == "*"
            entries.append(BranchEntry(
                name: name,
                isCurrent: isCurrent,
                lastCommitAt: date,
                checkedOutPath: checkoutByBranch[name]
            ))
        }
        #if DEBUG
        Self.debugLog("branches.result folder=\(folder) count=\(entries.count)")
        #endif
        return entries
    }

    // MARK: - Parser

    static func parseWorktreeList(_ porcelain: String) -> [ListEntry] {
        var entries: [ListEntry] = []
        var path: String?
        var head: String?
        var branch: String?
        var locked = false
        var prunable = false

        func flush() {
            guard let p = path, let h = head else {
                path = nil; head = nil; branch = nil; locked = false; prunable = false
                return
            }
            let isMain = entries.isEmpty
            entries.append(ListEntry(
                path: p, branch: branch, head: h,
                isMain: isMain, isLocked: locked, isPrunable: prunable
            ))
            path = nil; head = nil; branch = nil; locked = false; prunable = false
        }

        for raw in porcelain.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.isEmpty { flush(); continue }
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
            let key = String(parts[0])
            let value = parts.count > 1 ? String(parts[1]) : ""
            switch key {
            case "worktree": path = value
            case "HEAD":     head = value
            case "branch":
                branch = value.replacingOccurrences(of: "refs/heads/", with: "")
            case "locked":   locked = true
            case "prunable": prunable = true
            case "detached": branch = nil
            default: break
            }
        }
        flush()
        return entries
    }

    // MARK: - Process plumbing

    private func ensureParent(for path: String) throws {
        let parent = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: parent, withIntermediateDirectories: true
        )
    }

    private func run(
        _ args: [String],
        in workingDir: String,
        stdin: Data? = nil
    ) throws -> String {
        guard FileManager.default.isExecutableFile(atPath: gitPath) else {
            throw WorktreeError.gitNotFound
        }

        let command = "git " + args.joined(separator: " ")
        let kind = Self.commandKind(for: args)
        let caller = "GitWorktreeService.\(args.first ?? "git")"
        let invalidationTargets = Self.invalidationTargets(for: args, workingDir: workingDir)
        let invalidationLabel = invalidationTargets
            .map { Self.describe(invalidationTarget: $0) }
            .joined(separator: ",")
        #if DEBUG
        Self.debugLog(
            "run.begin caller=\(caller) kind=\(kind.rawValue) cwd=\(workingDir) args=\(args.joined(separator: " ")) invalidates=\(invalidationLabel)"
        )
        #endif

        do {
            let output: String
            if invalidationTargets.isEmpty {
                output = try GitCommandRunner.runThrowing(
                    args,
                    in: workingDir,
                    kind: kind,
                    caller: caller,
                    stdin: stdin
                )
            } else {
                output = try GitCommandRunner.runMutation(
                    args,
                    in: workingDir,
                    kind: kind,
                    caller: caller,
                    invalidates: invalidationTargets,
                    stdin: stdin
                )
            }
            #if DEBUG
            Self.debugLog("run.result caller=\(caller) cwd=\(workingDir) len=\(output.count)")
            #endif
            return output
        } catch let error as GitCommandRunner.RunError {
            let errString = error.stderr
            #if DEBUG
            Self.debugLog("run.failure caller=\(caller) cwd=\(workingDir) exit=\(error.exitCode) stderrLen=\(errString.count)")
            #endif
            if case .gitNotFound = error {
                throw WorktreeError.gitNotFound
            }
            if case .timedOut = error {
                throw WorktreeError.timeout(command: command)
            }

            let lower = errString.lowercased()
            if lower.contains("not a git repository") {
                throw WorktreeError.notAGitRepo(path: workingDir)
            }
            if lower.contains("is already checked out") {
                throw WorktreeError.branchLocked(
                    branch: args.last ?? "",
                    holder: errString
                )
            }
            throw WorktreeError.gitCommandFailed(
                command: command,
                stderr: errString,
                exitCode: error.exitCode
            )
        } catch {
            throw WorktreeError.gitCommandFailed(
                command: command,
                stderr: "\(error)",
                exitCode: -1
            )
        }
    }

    private static func commandKind(for args: [String]) -> GitCommandRunner.CommandKind {
        GitCommandRunner.CommandKind.classify(arguments: args)
    }

    private static func invalidationTargets(
        for args: [String],
        workingDir: String
    ) -> [GitInvalidationTarget] {
        guard let first = args.first else { return [] }
        switch first {
        case "worktree":
            if args.contains("add") {
                let payload = Array(args.dropFirst(2))
                let path = payload.count >= 2 ? payload[payload.count - 2] : payload.first
                var targets: [GitInvalidationTarget] = [.project(workingDir)]
                if let path { targets.append(.worktree(path)) }
                return targets
            }
            if args.contains("remove") {
                return [.project(workingDir)] + args.suffix(1).map { .worktree($0) }
            }
            if args.contains("prune") {
                return [.project(workingDir)]
            }
            if args.contains("repair") {
                let payload = Array(args.dropFirst(2))
                var targets: [GitInvalidationTarget] = [.project(workingDir)]
                for path in payload { targets.append(.worktree(path)) }
                return targets
            }
            return []
        case "branch":
            if args.contains("-D") || args.contains("-d") || args.contains("--delete") {
                return [.project(workingDir)]
            }
            return []
        case "apply":
            return [.worktree(workingDir)]
        default:
            return []
        }
    }

    private static func describe(invalidationTarget: GitInvalidationTarget) -> String {
        switch invalidationTarget {
        case .worktree(let path):
            return "worktree:\(path)"
        case .project(let path):
            return "project:\(path)"
        case .directory(let path):
            return "directory:\(path)"
        case .all:
            return "all"
        }
    }

    private func waitForTermination(_ task: Process, timeout: TimeInterval) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in semaphore.signal() }
        if !task.isRunning {
            task.terminationHandler = nil
            return false
        }

        let didTimeOut = semaphore.wait(timeout: .now() + timeout) == .timedOut
        if didTimeOut, task.isRunning {
            task.terminate()
            _ = semaphore.wait(timeout: .now() + 1)
        }

        task.terminationHandler = nil
        return didTimeOut
    }
}
