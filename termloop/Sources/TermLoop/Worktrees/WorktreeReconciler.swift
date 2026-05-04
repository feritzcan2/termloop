// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Pure, side-effect-free worktree status reducer. It never shells out and it
/// never mutates metadata; callers provide the `git worktree list --porcelain`
/// result from a background registry and a cheap path-existence probe.
enum WorktreeReconciler {
    struct Binding: Equatable {
        let expectedBranch: String?
        let worktreePath: String?

        init(expectedBranch: String?, worktreePath: String?) {
            self.expectedBranch = Self.trimmedNonEmpty(expectedBranch)
            self.worktreePath = WorktreeResolver.normalizePath(worktreePath)
        }

        private static func trimmedNonEmpty(_ value: String?) -> String? {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    typealias FileExists = (String) -> Bool

    static func status(
        for binding: Binding,
        entries rawEntries: [GitWorktreeService.ListEntry],
        fileExists: FileExists = defaultFileExists
    ) -> WorktreeStatus {
        let expectedBranch = binding.expectedBranch
        let storedPath = binding.worktreePath
        let entries = rawEntries.map(NormalizedEntry.init(entry:))

        if expectedBranch == nil, storedPath == nil {
            return .unattached
        }

        if let storedPath {
            if let entry = entries.first(where: { $0.path == storedPath }) {
                return status(
                    for: entry,
                    expectedBranch: expectedBranch,
                    pathSource: .metadata,
                    message: nil
                )
            }

            let storedPathExists = fileExists(storedPath)
            if !storedPathExists,
               let expectedBranch,
               let entry = entries.first(where: { $0.branch == expectedBranch }) {
                return status(
                    for: entry,
                    expectedBranch: expectedBranch,
                    pathSource: .gitBranchBackfill,
                    message: "stored worktreePath missing; Git supplied path for expected branch"
                )
            }

            let kind: WorktreeStatus.Kind = storedPathExists
                ? .missingRegistration
                : .missingPath
            return WorktreeStatus(
                kind: kind,
                expectedBranch: expectedBranch,
                path: storedPath,
                pathSource: .metadata,
                observedRef: nil,
                isMain: false,
                isLocked: false,
                isPrunable: false,
                message: nil
            )
        }

        if let expectedBranch,
           let entry = entries.first(where: { $0.branch == expectedBranch }) {
            return status(
                for: entry,
                expectedBranch: expectedBranch,
                pathSource: .gitBranchBackfill,
                message: "metadata missing worktreePath; Git supplied path for expected branch"
            )
        }

        return WorktreeStatus(
            kind: .missingRegistration,
            expectedBranch: expectedBranch,
            path: nil,
            pathSource: .none,
            observedRef: nil,
            isMain: false,
            isLocked: false,
            isPrunable: false,
            message: nil
        )
    }

    static func status(
        for binding: Binding,
        failure: Error
    ) -> WorktreeStatus {
        WorktreeStatus(
            kind: .unknown,
            expectedBranch: binding.expectedBranch,
            path: binding.worktreePath,
            pathSource: binding.worktreePath == nil ? .none : .metadata,
            observedRef: nil,
            isMain: false,
            isLocked: false,
            isPrunable: false,
            message: String(describing: failure)
        )
    }

    private static func status(
        for entry: NormalizedEntry,
        expectedBranch: String?,
        pathSource: WorktreeStatus.PathSource,
        message: String?
    ) -> WorktreeStatus {
        let observed = observedRef(for: entry)
        let kind: WorktreeStatus.Kind
        if entry.isPrunable {
            kind = .prunable
        } else if let expectedBranch,
                  !observedRef(observed, matchesExpectedBranch: expectedBranch) {
            kind = .branchDrift
        } else if entry.isLocked {
            kind = .locked
        } else {
            kind = .healthy
        }

        return WorktreeStatus(
            kind: kind,
            expectedBranch: expectedBranch,
            path: entry.path,
            pathSource: pathSource,
            observedRef: observed,
            isMain: entry.isMain,
            isLocked: entry.isLocked,
            isPrunable: entry.isPrunable,
            message: message
        )
    }

    private static func observedRef(for entry: NormalizedEntry) -> WorktreeObservedRef {
        if let branch = entry.branch {
            return .branch(branch)
        }
        return .detached(entry.head)
    }

    private static func observedRef(
        _ observed: WorktreeObservedRef,
        matchesExpectedBranch expectedBranch: String
    ) -> Bool {
        guard case .branch(let observedBranch) = observed else { return false }
        return observedBranch == expectedBranch
    }

    private static func defaultFileExists(path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
            && isDirectory.boolValue
    }

    private struct NormalizedEntry: Equatable {
        let path: String
        let branch: String?
        let head: String
        let isMain: Bool
        let isLocked: Bool
        let isPrunable: Bool

        init(entry: GitWorktreeService.ListEntry) {
            path = WorktreeResolver.normalizePath(entry.path) ?? entry.path
            let trimmedBranch = entry.branch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            branch = trimmedBranch.isEmpty ? nil : trimmedBranch
            head = entry.head.trimmingCharacters(in: .whitespacesAndNewlines)
            isMain = entry.isMain
            isLocked = entry.isLocked
            isPrunable = entry.isPrunable
        }
    }
}
