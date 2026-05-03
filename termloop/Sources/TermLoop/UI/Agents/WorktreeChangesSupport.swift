import Foundation

// MARK: - Data types

struct WorktreeBaseComparisonTarget: Equatable, Hashable {
    let branch: String
    let ref: String
    let mergeBase: String

    var id: String { "base:\(branch)" }

    var shortMergeBase: String {
        String(mergeBase.prefix(7))
    }
}

struct WorktreeRecentCommit: Equatable, Identifiable {
    let sha: String
    let subject: String
    let authoredAt: Date?

    var id: String { sha }
    var shortSHA: String { String(sha.prefix(7)) }
}

enum WorktreeChangesSource: Equatable, Identifiable {
    case local
    case baseComparison(WorktreeBaseComparisonTarget)
    case commit(WorktreeRecentCommit)

    var id: String {
        switch self {
        case .local:
            return "local"
        case .baseComparison(let target):
            return target.id
        case .commit(let commit):
            return "commit:\(commit.sha)"
        }
    }
}

// MARK: - Git providers


enum WorktreeLocalChangesProvider {
    static func fetchChangedFiles(directory: String) -> [SidebarGitChangeItem]? {
        let output = GitCommandRunner.runOptional(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            in: directory,
            kind: .status,
            caller: "WorktreeLocalChangesProvider"
        )
        return parsePorcelainStatusZ(output)
    }

    static func fetchUnifiedDiff(
        directory: String,
        relativePath: String,
        status: GitFileStatus
    ) -> String? {
        let git = ProcessGitStateProvider()
        for arguments in [
            ["diff", "--no-ext-diff", "--find-renames", "--", relativePath],
            ["diff", "--no-ext-diff", "--find-renames", "--cached", "--", relativePath]
        ] {
            if let output = try? git.runRaw(arguments, cwd: directory),
               !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return output
            }
        }

        switch status {
        case .added, .untracked:
            return synthesizeAdditionPatch(directory: directory, relativePath: relativePath)
        case .deleted:
            return "Deleted file: \(relativePath)"
        case .renamed:
            return "Renamed file: \(relativePath)"
        case .modified:
            return nil
        }
    }

    private static func parsePorcelainStatusZ(_ output: String?) -> [SidebarGitChangeItem]? {
        guard let output else { return nil }
        guard !output.isEmpty else { return [] }

        var results: [SidebarGitChangeItem] = []
        let records = output.split(separator: "\0", omittingEmptySubsequences: true)
        var index = 0
        while index < records.count {
            let record = records[index]
            index += 1
            guard record.count >= 4 else { continue }
            let indexStatus = record[record.startIndex]
            let workTreeStatus = record[record.index(after: record.startIndex)]
            guard let status = parseStatus(index: indexStatus, workTree: workTreeStatus) else { continue }

            // `git status --porcelain=v1 -z` emits rename records as:
            //   "R  new-path\0old-path\0"
            // We display/diff the new path and skip the old path record.
            let path = String(record.dropFirst(3))
            if status == .renamed, index < records.count {
                index += 1
            }
            guard !path.isEmpty else { continue }
            results.append(SidebarGitChangeItem(path: path, status: status))
        }

        return results.sorted {
            $0.path.localizedStandardCompare($1.path) == .orderedAscending
        }
    }

    private static func parseStatus(index: Character, workTree: Character) -> GitFileStatus? {
        if index == "?" && workTree == "?" { return .untracked }
        if index == "R" || workTree == "R" { return .renamed }
        if index == "A" || workTree == "A" { return .added }
        if index == "D" || workTree == "D" { return .deleted }
        if index == "M" || workTree == "M" { return .modified }
        return nil
    }

    private static func synthesizeAdditionPatch(directory: String, relativePath: String) -> String? {
        let git = ProcessGitStateProvider()
        let repoRoot = (try? git.runRaw(["rev-parse", "--show-toplevel"], cwd: directory))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let root = (repoRoot?.isEmpty == false) ? repoRoot! : directory
        let fileURL = URL(fileURLWithPath: root).appendingPathComponent(relativePath)
        guard let contents = try? String(contentsOf: fileURL, encoding: .utf8) else { return nil }
        let lines = contents.components(separatedBy: "\n")
        let body = lines
            .map { "+" + $0 }
            .joined(separator: "\n")
        return """
        diff --git a/\(relativePath) b/\(relativePath)
        new file mode 100644
        --- /dev/null
        +++ b/\(relativePath)
        @@ -0,0 +1,\(lines.count) @@
        \(body)
        """
    }
}

enum WorktreeCommitDiffProvider {
    static func fetchRecentCommits(directory: String, baselineHead: String?) -> [WorktreeRecentCommit] {
        let git = ProcessGitStateProvider()
        var args = ["log", "--format=%H%x09%s%x09%ct", "--max-count", "50"]
        if let baselineHead, !baselineHead.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append("\(baselineHead)..HEAD")
        }
        guard let output = try? git.runRaw(args, cwd: directory) else { return [] }
        return output.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count >= 2 else { return nil }
            let authoredAt: Date? = {
                guard parts.count > 2, let ts = TimeInterval(parts[2]) else { return nil }
                return Date(timeIntervalSince1970: ts)
            }()
            return WorktreeRecentCommit(
                sha: String(parts[0]),
                subject: String(parts[1]),
                authoredAt: authoredAt
            )
        }
    }

    /// Returns a SHA→file-count map for the same commit range used by
    /// `fetchRecentCommits`, parsed from a single `git log --numstat` pass
    /// so every row in the source list can show a count without a per-commit fetch.
    static func fetchCommitFileCounts(directory: String, baselineHead: String?) -> [String: Int] {
        let git = ProcessGitStateProvider()
        var args = ["log", "--format=%H", "--numstat", "--max-count", "50"]
        if let baselineHead, !baselineHead.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append("\(baselineHead)..HEAD")
        }
        guard let output = try? git.runRaw(args, cwd: directory) else { return [:] }
        var result: [String: Int] = [:]
        var currentSHA: String?
        var count = 0
        // Output alternates: a 40-char SHA line (from %H) followed by one
        // numstat line per changed file ("<added>\t<deleted>\t<path>", where
        // added/deleted are digits or "-" for binary files).
        for line in output.split(whereSeparator: \.isNewline) {
            let s = String(line)
            if s.count == 40 && s.allSatisfy(\.isHexDigit) {
                if let sha = currentSHA {
                    result[sha] = count
                }
                currentSHA = s
                count = 0
            } else if !s.isEmpty, s.first?.isNumber == true || s.first == "-" {
                count += 1
            }
        }
        if let sha = currentSHA {
            result[sha] = count
        }
        return result
    }

    /// For each commit SHA, returns the display-name list of tracked branches
    /// whose history contains it — used to render "merged → dev" chips.
    /// Implementation: one `rev-list <ref>` per tracked target builds a SHA
    /// set, then each commit is O(1) membership-checked against each set.
    static func fetchMergedBranchesByCommitSHA(
        directory: String,
        targets: [WorktreeBaseComparisonTarget],
        commitSHAs: [String]
    ) -> [String: [String]] {
        guard !targets.isEmpty, !commitSHAs.isEmpty else { return [:] }
        let git = ProcessGitStateProvider()

        var shasByRef: [String: Set<String>] = [:]
        for target in targets {
            guard let output = try? git.runRaw(
                ["rev-list", target.ref, "--max-count", "5000"],
                cwd: directory
            ) else { continue }
            shasByRef[target.ref] = Set(
                output.split(whereSeparator: \.isNewline).map { String($0) }
            )
        }

        var result: [String: [String]] = [:]
        for sha in commitSHAs {
            var branches: [String] = []
            for target in targets {
                if shasByRef[target.ref]?.contains(sha) == true {
                    branches.append(target.branch)
                }
            }
            if !branches.isEmpty {
                result[sha] = branches
            }
        }
        return result
    }

    static func fetchChangedFiles(directory: String, commitSHA: String) -> [SidebarGitChangeItem]? {
        let git = ProcessGitStateProvider()
        let output = try? git.runRaw(
            ["show", "--format=", "--name-status", "--find-renames", commitSHA],
            cwd: directory
        )
        return WorktreeBaseComparisonProvider.parseNameStatus(output)
    }

    static func fetchUnifiedDiff(directory: String, commitSHA: String, relativePath: String) -> String? {
        let git = ProcessGitStateProvider()
        guard let output = try? git.runRaw(
            ["show", "--format=", "--no-ext-diff", "--find-renames", commitSHA, "--", relativePath],
            cwd: directory
        ) else {
            return nil
        }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum WorktreeBaseComparisonProvider {
    static func resolveTargets(
        seededCandidates: [String],
        currentBranch: String?,
        directory: String,
        projectRoot: String
    ) -> [WorktreeBaseComparisonTarget] {
        var candidates = seededCandidates
        let tracked = defaultBranchCandidates(projectRoot: projectRoot)
        for branch in tracked where !branch.isEmpty && !candidates.contains(branch) {
            candidates.append(branch)
        }
        for branch in ["dev", "development", "master", "production"] where !candidates.contains(branch) {
            candidates.append(branch)
        }

        var targets: [WorktreeBaseComparisonTarget] = []
        for candidate in candidates where candidate != currentBranch {
            guard let ref = resolvePreferredRef(branch: candidate, directory: directory),
                  let mergeBase = mergeBase(directory: directory, baseRef: ref) else {
                continue
            }
            targets.append(WorktreeBaseComparisonTarget(branch: candidate, ref: ref, mergeBase: mergeBase))
        }
        return targets
    }

    private static func defaultBranchCandidates(projectRoot: String) -> [String] {
        let git = ProcessGitStateProvider()
        var result: [String] = []
        if let defaultBranch = git.defaultBranch(projectRoot: projectRoot) {
            result.append(defaultBranch)
        }
        if git.hasRemoteBranch("dev", directory: projectRoot),
           !result.contains("dev") {
            result.append("dev")
        }
        return result
    }

    static func resolvePreferredRef(branch: String, directory: String) -> String? {
        let git = ProcessGitStateProvider()
        if git.hasRemoteBranch(branch, directory: directory) {
            return "origin/\(branch)"
        }
        if (try? git.runRaw(["rev-parse", "--verify", "--quiet", "refs/heads/\(branch)"], cwd: directory)) != nil {
            return branch
        }
        return nil
    }

    static func mergeBase(directory: String, baseRef: String) -> String? {
        let git = ProcessGitStateProvider()
        guard let output = try? git.runRaw(["merge-base", baseRef, "HEAD"], cwd: directory) else {
            return nil
        }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func fetchChangedFiles(directory: String, mergeBase: String) -> [SidebarGitChangeItem]? {
        let git = ProcessGitStateProvider()
        let output = try? git.runRaw(["diff", "--name-status", "--find-renames", mergeBase], cwd: directory)
        return parseNameStatus(output)
    }

    static func fetchUnifiedDiff(directory: String, mergeBase: String, relativePath: String) -> String? {
        let git = ProcessGitStateProvider()
        guard let output = try? git.runRaw(
            ["diff", "--no-ext-diff", "--find-renames", mergeBase, "--", relativePath],
            cwd: directory
        ) else {
            return nil
        }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func parseNameStatus(_ output: String?) -> [SidebarGitChangeItem]? {
        guard let output else { return nil }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var results: [SidebarGitChangeItem] = []
        for line in trimmed.split(whereSeparator: \.isNewline) {
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false)
            guard parts.count >= 2 else { continue }
            let statusToken = String(parts[0])
            guard let status = parseStatus(statusToken) else { continue }

            let path: String
            if status == .renamed {
                path = String(parts.last ?? "")
            } else {
                path = String(parts[1])
            }
            guard !path.isEmpty else { continue }
            results.append(SidebarGitChangeItem(path: path, status: status))
        }
        return results
    }

    private static func parseStatus(_ token: String) -> GitFileStatus? {
        guard let marker = token.first else { return nil }
        switch marker {
        case "A", "C":
            return .added
        case "D":
            return .deleted
        case "R":
            return .renamed
        case "M", "T", "U":
            return .modified
        default:
            return nil
        }
    }
}
