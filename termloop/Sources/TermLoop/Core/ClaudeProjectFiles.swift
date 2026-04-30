// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Outcome of `ClaudeProjectFiles.seedAllSessions`. Replaces a bare `Int`
/// return that conflated "no work to do" with "createDirectory failed" — both
/// returned `0` and were silently ignored at every call site.
enum SeedAllSessionsOutcome: Equatable {
    enum SkipReason: String, Equatable {
        case sameSourceAndTarget
        case sourceMissing
        case sourceEmpty
    }

    case skipped(SkipReason)
    /// At least one symlink was created. `count` may be 0 only when every
    /// source entry already existed at the destination, which is still a
    /// success path (no work needed, no failure).
    case linked(count: Int)
    /// Hard failure that prevented the seed from running. Currently the
    /// only producer is `createDirectory` failure on the destination.
    case failed(reason: String)
}

/// Helpers for locating Claude Code's on-disk session files at
/// `~/.claude/projects/<encoded-cwd>/<sessionId>.*`. Claude's layout is not a
/// stable public contract, so everything here is best-effort and must fail
/// soft. Shared by `WorktreeCoordinator` (session migration when attaching a
/// worktree) and `ClaudeRestoreCoordinator` (post-launch `--resume`).
enum ClaudeProjectFiles {
    static var projectsRootOverride: URL?

    private static let logger = Logger(subsystem: "ai.termloop", category: "claude-files")

    private struct SessionEntry: Equatable {
        let name: String
        let modificationDate: Date
    }

    /// Claude encodes the absolute cwd by replacing both `/` and `.` with `-`,
    /// so `/Users/me/repo/.termloop-worktrees/b` becomes
    /// `-Users-me-repo--cmux-worktrees-b`. This must stay aligned with
    /// `ClaudeSessionScanner.slug(forCwd:)` or worktree restores will fail to
    /// find session files that the scanner successfully discovered.
    static func encodeCwd(_ path: String) -> String {
        ClaudeSessionScanner.slug(forCwd: path)
    }

    static func projectsRoot() -> URL {
        projectsRootOverride ?? FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects")
    }

    static func projectDirectory(forCwd cwd: String) -> URL {
        projectsRoot().appendingPathComponent(encodeCwd(cwd))
    }

    /// Claude's cwd encoding has changed over time for worktree leaves in this
    /// repo. Keep a tiny compatibility set so restore can find sessions written
    /// by older builds as well as the current one.
    private static func projectDirectories(forCwd cwd: String) -> [URL] {
        let trimmed = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        var seen = Set<String>()
        var directories: [URL] = []
        for candidate in [
            trimmed,
            trimmed.replacingOccurrences(of: "__", with: "--"),
            trimmed.replacingOccurrences(of: "--", with: "__")
        ] {
            let normalized = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty, seen.insert(normalized).inserted else { continue }
            directories.append(projectDirectory(forCwd: normalized))
        }
        return directories
    }

    private static func sessionEntries(sessionId: String, cwd: String) -> [SessionEntry] {
        let fm = FileManager.default
        var entries: [SessionEntry] = []
        var seen = Set<String>()

        for dir in projectDirectories(forCwd: cwd) {
            guard let dirEntries = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else {
                continue
            }
            for url in dirEntries where url.lastPathComponent.hasPrefix(sessionId) {
                let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
                let name = url.lastPathComponent
                if seen.insert(name).inserted {
                    entries.append(
                        SessionEntry(
                            name: name,
                            modificationDate: values?.contentModificationDate ?? .distantPast
                        )
                    )
                }
            }
        }
        return entries.sorted { $0.name < $1.name }
    }

    private static func latestModificationDate(_ entries: [SessionEntry]) -> Date? {
        entries.map(\.modificationDate).max()
    }

    private static func shouldRefreshTarget(
        targetEntries: [SessionEntry],
        sourceEntries: [SessionEntry]
    ) -> Bool {
        guard !sourceEntries.isEmpty else { return false }
        guard !targetEntries.isEmpty else { return true }

        let targetNames = Set(targetEntries.map(\.name))
        let sourceNames = Set(sourceEntries.map(\.name))
        if targetNames != sourceNames {
            return true
        }

        guard let sourceLatest = latestModificationDate(sourceEntries),
              let targetLatest = latestModificationDate(targetEntries) else {
            return false
        }
        return sourceLatest > targetLatest
    }

    /// Returns true if at least one file in the encoded project directory
    /// begins with the given session id (the id is the filename stem, with
    /// `.jsonl` and optional sidecar suffixes).
    static func sessionExists(sessionId: String, cwd: String) -> Bool {
        !sessionEntries(sessionId: sessionId, cwd: cwd).isEmpty
    }

    /// Copies every file matching `<sessionId>*` from the encoded `fromCwd`
    /// directory to the encoded `toCwd` directory. Used when switching a
    /// workspace to a new worktree path so `claude --resume <sid>` at the
    /// new path still finds the session. Returns true iff at least one file
    /// was copied.
    @discardableResult
    static func copySession(
        sessionId: String,
        fromCwd: String,
        toCwd: String
    ) -> Bool {
        copySessionFiles(
            sessionId: sessionId,
            fromCwd: fromCwd,
            toCwd: toCwd,
            transformJsonl: nil
        )
    }

    /// Shared worker for `copySession` and the migration path. When
    /// `transformJsonl` is non-nil, every `.jsonl` file is loaded, passed
    /// through the transform, and written to the target. nil → byte-copy.
    /// Sidecar (non-`.jsonl`) files always byte-copy.
    @discardableResult
    private static func copySessionFiles(
        sessionId: String,
        fromCwd: String,
        toCwd: String,
        transformJsonl: ((String) -> String)?
    ) -> Bool {
        let fm = FileManager.default
        let srcDirs = projectDirectories(forCwd: fromCwd)
        let dstDir = projectDirectory(forCwd: toCwd)
        if let firstSrcDir = srcDirs.first,
           firstSrcDir.standardizedFileURL == dstDir.standardizedFileURL {
            return sessionExists(sessionId: sessionId, cwd: toCwd)
        }
        let matchesBySourceDir: [(URL, [String])] = srcDirs.compactMap { srcDir in
            guard fm.fileExists(atPath: srcDir.path) else { return nil }
            let entries = (try? fm.contentsOfDirectory(atPath: srcDir.path)) ?? []
            let matches = entries.filter { $0.hasPrefix(sessionId) }
            return matches.isEmpty ? nil : (srcDir, matches)
        }
        guard let (srcDir, matches) = matchesBySourceDir.first else { return false }

        do {
            try fm.createDirectory(at: dstDir, withIntermediateDirectories: true)
        } catch {
            return false
        }

        let existingTargetEntries = (try? fm.contentsOfDirectory(atPath: dstDir.path)) ?? []
        for name in existingTargetEntries where name.hasPrefix(sessionId) {
            try? fm.removeItem(at: dstDir.appendingPathComponent(name))
        }

        var copiedAny = false
        for name in matches {
            let src = srcDir.appendingPathComponent(name)
            let dst = dstDir.appendingPathComponent(name)
            if let transform = transformJsonl,
               name.hasSuffix(".jsonl"),
               let raw = try? Data(contentsOf: src),
               let text = String(data: raw, encoding: .utf8) {
                let rewritten = transform(text)
                if (try? rewritten.write(to: dst, atomically: true, encoding: .utf8)) != nil {
                    copiedAny = true
                }
            } else if (try? fm.copyItem(at: src, to: dst)) != nil {
                copiedAny = true
            }
        }
        return copiedAny
    }

    /// Symlinks every non-hidden session entry from `fromCwd` into `toCwd`,
    /// skipping names that already exist at the target. This lets
    /// `claude --resume <sid>` inside the worktree find historical sessions
    /// from the project root even when TermLoop never tracked them.
    ///
    /// Returns a structured outcome so callers (and reviewers) can tell
    /// "no source to seed from" apart from "tried but failed". The previous
    /// `Int` return collapsed both into `0`, hiding `createDirectory` failures
    /// that left the agent without resumable history.
    @discardableResult
    static func seedAllSessions(
        fromCwd: String,
        toCwd: String
    ) -> SeedAllSessionsOutcome {
        let fm = FileManager.default
        let srcDir = projectDirectory(forCwd: fromCwd)
        let dstDir = projectDirectory(forCwd: toCwd)
        if srcDir.standardizedFileURL == dstDir.standardizedFileURL {
            return .skipped(.sameSourceAndTarget)
        }
        guard fm.fileExists(atPath: srcDir.path) else {
            return .skipped(.sourceMissing)
        }

        let sourceEntries = (try? fm.contentsOfDirectory(
            at: srcDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let sourceFiles = sourceEntries.filter { url in
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            return values?.isDirectory != true
        }
        guard !sourceFiles.isEmpty else {
            return .skipped(.sourceEmpty)
        }

        do {
            try fm.createDirectory(at: dstDir, withIntermediateDirectories: true)
        } catch {
            let reason = "createDirectory failed: \(error.localizedDescription)"
            logger.error(
                "seedAllSessions failed: dst=\(dstDir.path, privacy: .public) reason=\(reason, privacy: .public)"
            )
            return .failed(reason: reason)
        }

        let existingTargetEntries = Set((try? fm.contentsOfDirectory(atPath: dstDir.path)) ?? [])
        var linkedCount = 0
        for src in sourceFiles.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = src.lastPathComponent
            guard !existingTargetEntries.contains(name) else { continue }
            let dst = dstDir.appendingPathComponent(name)
            do {
                try fm.createSymbolicLink(at: dst, withDestinationURL: src.standardizedFileURL)
                linkedCount += 1
            } catch {
                continue
            }
        }
        return .linked(count: linkedCount)
    }

    /// Migrates a Claude session from one of `sourceCwds` to `targetCwd`.
    ///
    /// This is the explicit "we are moving this conversation to a new cwd"
    /// entry point, used when a workspace's cwd changes while an existing
    /// agent is being resumed (e.g. moving a running agent into a worktree).
    /// On top of what `ensureSessionAvailable` does, the migration step
    /// rewrites every absolute path inside the JSONL transcript that is a
    /// descendant of the source cwd to the same descendant under
    /// `targetCwd`. Other absolute paths (`~/...`, `/etc/...`, paths in
    /// other projects) are left untouched.
    ///
    /// Without this rewrite, the resumed conversation keeps referencing
    /// the source cwd's absolute file paths in tool-call history, which
    /// causes Claude's next `Edit`/`Read` to silently target the source
    /// branch instead of the worktree.
    ///
    /// Returns true iff the target ends up containing at least one
    /// `<sessionId>*` entry.
    @discardableResult
    static func migrateSession(
        sessionId: String,
        targetCwd: String,
        sourceCwds: [String]
    ) -> Bool {
        selectSourceAndCopy(
            sessionId: sessionId,
            targetCwd: targetCwd,
            sourceCwds: sourceCwds
        ) { fromCwd, toCwd in
            copySessionFiles(
                sessionId: sessionId,
                fromCwd: fromCwd,
                toCwd: toCwd
            ) { jsonlText in
                // The rewrite is purely textual, so paths recorded under
                // a different form of the same cwd (the realpath when the
                // session was reached via a symlink, or vice versa) won't
                // match the literal `fromCwd`. The macOS `/tmp` →
                // `/private/tmp` indirection is the common case. Run a
                // second pass against the resolved form so both forms
                // land at `toCwd`.
                var result = rewriteJsonlText(jsonlText, fromCwd: fromCwd, toCwd: toCwd)
                let resolved = (fromCwd as NSString).resolvingSymlinksInPath
                if resolved != fromCwd, !resolved.isEmpty {
                    result = rewriteJsonlText(result, fromCwd: resolved, toCwd: toCwd)
                }
                return result
            }
        }
    }

    /// Iterates `sourceCwds` (with `__`/`--` slug variants), skipping the
    /// target and any source that wouldn't refresh, and invokes `copy` for
    /// each viable source. Shared by `ensureSessionAvailable` (byte-copy)
    /// and `migrateSession` (copy + rewrite). Returns true iff the target
    /// ends up containing at least one `<sessionId>*` entry.
    private static func selectSourceAndCopy(
        sessionId: String,
        targetCwd: String,
        sourceCwds: [String],
        copy: (_ fromCwd: String, _ toCwd: String) -> Bool
    ) -> Bool {
        var seen = Set<String>()
        var targetEntries = sessionEntries(sessionId: sessionId, cwd: targetCwd)
        for raw in sourceCwds {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            for candidate in [
                trimmed,
                trimmed.replacingOccurrences(of: "__", with: "--"),
                trimmed.replacingOccurrences(of: "--", with: "__")
            ] {
                let expanded = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !expanded.isEmpty, seen.insert(expanded).inserted else { continue }
                guard expanded != targetCwd else { continue }
                let sourceEntries = sessionEntries(sessionId: sessionId, cwd: expanded)
                guard shouldRefreshTarget(
                    targetEntries: targetEntries,
                    sourceEntries: sourceEntries
                ) else { continue }
                if copy(expanded, targetCwd) {
                    targetEntries = sessionEntries(sessionId: sessionId, cwd: targetCwd)
                }
            }
        }
        return !targetEntries.isEmpty
    }

    /// Splits `text` on newlines, parses each line as JSON, recursively
    /// rewrites string values under `fromCwd` to `toCwd`, and re-serializes.
    /// Lines that don't parse pass through verbatim. The trailing newline
    /// presence is preserved so subsequent appenders don't see a malformed
    /// final boundary.
    private static func rewriteJsonlText(
        _ text: String,
        fromCwd: String,
        toCwd: String
    ) -> String {
        guard !fromCwd.isEmpty, fromCwd != toCwd else { return text }
        let hadTrailingNewline = text.hasSuffix("\n")
        // omittingEmptySubsequences: false preserves the trailing empty
        // element produced by a terminating "\n" so we can restore it.
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out: [String] = []
        out.reserveCapacity(lines.count)
        for (idx, line) in lines.enumerated() {
            if line.isEmpty && idx == lines.count - 1 && hadTrailingNewline {
                out.append("")
                continue
            }
            out.append(rewriteJsonLine(line, fromCwd: fromCwd, toCwd: toCwd))
        }
        var joined = out.joined(separator: "\n")
        if hadTrailingNewline && !joined.hasSuffix("\n") {
            joined.append("\n")
        }
        return joined
    }

    private static func rewriteJsonLine(
        _ line: String,
        fromCwd: String,
        toCwd: String
    ) -> String {
        guard let data = line.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(
                with: data,
                options: [.fragmentsAllowed]
              ) else {
            return line
        }
        let rewritten = rewritePathsInJson(parsed, fromCwd: fromCwd, toCwd: toCwd)
        guard let outData = try? JSONSerialization.data(
            withJSONObject: rewritten,
            options: [.fragmentsAllowed, .withoutEscapingSlashes]
        ),
        let outStr = String(data: outData, encoding: .utf8) else {
            return line
        }
        return outStr
    }

    private static func rewritePathsInJson(
        _ value: Any,
        fromCwd: String,
        toCwd: String
    ) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            out.reserveCapacity(dict.count)
            for (k, v) in dict {
                out[k] = rewritePathsInJson(v, fromCwd: fromCwd, toCwd: toCwd)
            }
            return out
        }
        if let arr = value as? [Any] {
            return arr.map { rewritePathsInJson($0, fromCwd: fromCwd, toCwd: toCwd) }
        }
        if let str = value as? String {
            return rewritePathPrefixes(in: str, fromCwd: fromCwd, toCwd: toCwd)
        }
        return value
    }

    /// Rewrites every path-boundary occurrence of `fromCwd` in `s` to
    /// `toCwd`. A "path-boundary occurrence" is a substring that
    /// (a) begins at a position preceded by a non-path-component character
    ///     (or string start), and
    /// (b) ends followed by `/`, end-of-string, or a non-path-component
    ///     character.
    /// This avoids matching across siblings (e.g. `/tmp/repo` must not
    /// match inside `/tmp/repofoo`). When `toCwd` extends `fromCwd` (the
    /// common worktree case where the new path is a descendant of the old
    /// one), an already-migrated occurrence of `toCwd` is skipped verbatim
    /// so re-running migration doesn't double-prefix.
    private static func rewritePathPrefixes(
        in s: String,
        fromCwd: String,
        toCwd: String
    ) -> String {
        guard !fromCwd.isEmpty, fromCwd != toCwd, !s.isEmpty else { return s }
        let toExtendsFrom = toCwd.hasPrefix(fromCwd)
        let chars = Array(s)
        let from = Array(fromCwd)
        let to = Array(toCwd)
        var output: [Character] = []
        output.reserveCapacity(chars.count)
        var i = 0
        while i < chars.count {
            if toExtendsFrom,
               i + to.count <= chars.count,
               matches(chars: chars, at: i, pattern: to),
               isPathBoundaryStart(chars: chars, at: i),
               isPathBoundaryEnd(chars: chars, at: i + to.count) {
                output.append(contentsOf: to)
                i += to.count
                continue
            }
            if i + from.count <= chars.count,
               matches(chars: chars, at: i, pattern: from),
               isPathBoundaryStart(chars: chars, at: i),
               isPathBoundaryEnd(chars: chars, at: i + from.count) {
                output.append(contentsOf: to)
                i += from.count
                continue
            }
            output.append(chars[i])
            i += 1
        }
        return String(output)
    }

    private static func matches(chars: [Character], at start: Int, pattern: [Character]) -> Bool {
        for k in 0..<pattern.count where chars[start + k] != pattern[k] {
            return false
        }
        return true
    }

    private static func isPathBoundaryStart(chars: [Character], at i: Int) -> Bool {
        guard i > 0 else { return true }
        return !isPathComponentChar(chars[i - 1])
    }

    private static func isPathBoundaryEnd(chars: [Character], at i: Int) -> Bool {
        guard i < chars.count else { return true }
        let c = chars[i]
        if c == "/" { return true }
        return !isPathComponentChar(c)
    }

    private static func isPathComponentChar(_ c: Character) -> Bool {
        if c.isLetter || c.isNumber { return true }
        return c == "_" || c == "-" || c == "."
    }

    /// Ensures the session exists in `targetCwd`, copying it from the first
    /// viable source cwd when needed. Returns true iff the target ends up
    /// containing at least one `<sessionId>*` entry.
    @discardableResult
    static func ensureSessionAvailable(
        sessionId: String,
        targetCwd: String,
        sourceCwds: [String]
    ) -> Bool {
        selectSourceAndCopy(
            sessionId: sessionId,
            targetCwd: targetCwd,
            sourceCwds: sourceCwds
        ) { fromCwd, toCwd in
            copySession(sessionId: sessionId, fromCwd: fromCwd, toCwd: toCwd)
        }
    }
}
