// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
#if DEBUG
import Bonsplit
#endif

/// Applies an accepted suggestion to disk.
/// All mutations are atomic (write to `.tmp` then rename) and the file's
/// final byte is always a newline so subsequent ADDs line up cleanly.
enum ContextBankApplier {
    enum ApplyError: Error, LocalizedError {
        case targetMissing(String)
        case replaceTextNotFound
        case replaceTextAmbiguous(matches: Int)
        case moveSourceMissing(String)
        case wouldExceedLimit

        var errorDescription: String? {
            switch self {
            case .targetMissing(let path):
                return "Target file not found: \(path)"
            case .replaceTextNotFound:
                return "Could not locate the text to replace"
            case .replaceTextAmbiguous(let matches):
                return "replace_old_text matches \(matches) places in the target file — refusing to swap because the curator's intent is ambiguous. Have the curator include more surrounding context in replace_old_text."
            case .moveSourceMissing(let path):
                return "Move source file not found: \(path)"
            case .wouldExceedLimit:
                return "Applying this suggestion would exceed the file's line limit"
            }
        }
    }

    static func apply(_ suggestion: ContextBankSuggestion, limitFor: (URL) -> Int) throws {
        switch suggestion.action {
        case .add:
            try applyAdd(suggestion, limitFor: limitFor)
        case .replace:
            try applyReplace(suggestion)
        case .move:
            try applyMove(suggestion, limitFor: limitFor)
        }
    }

    private static func applyAdd(_ s: ContextBankSuggestion, limitFor: (URL) -> Int) throws {
        guard let addText = s.addText else { return }

        // Symlink collapse: when AGENTS.md / GEMINI.md are symlinks to
        // CLAUDE.md (the user-managed mirror pattern), `mirror_paths` from
        // the curator points at three paths that share one inode. Writing
        // them sequentially through `replaceItemAt` would either replace
        // the symlink with a regular file (breaking the mirror) or fail
        // mid-loop with "no such file" because the temp .tmp sibling
        // collides on rename. Resolve each path to its real location and
        // dedup — write the underlying file once.
        //
        // New-file proposals: the primary `target_path` may legitimately
        // not exist on disk yet — the curator can propose creating a new
        // nested CLAUDE.md when no scope-matching context file exists.
        // The applier creates it (parent dir + initial content from
        // `addText`). Mirrors must still exist — mirroring presumes
        // sibling files already share content, and silently creating a
        // mirror would just produce a fresh divergent file.
        let primaryURL = s.targetURL
        let primaryRealPath = resolvedRealPath(of: primaryURL)
        var planned: [(url: URL, original: String, contents: String, isNewFile: Bool)] = []
        var seenRealPaths = Set<String>()
        for url in s.allTargetURLs {
            let resolvedPath = resolvedRealPath(of: url)
            if !seenRealPaths.insert(resolvedPath).inserted {
                continue
            }
            let resolvedURL = URL(fileURLWithPath: resolvedPath)
            let existingMaybe = try? String(contentsOf: resolvedURL, encoding: .utf8)
            let isPrimary = (resolvedPath == primaryRealPath)
            let existing: String
            let isNewFile: Bool
            if let raw = existingMaybe {
                existing = raw
                isNewFile = false
            } else if isPrimary {
                existing = ""
                isNewFile = true
            } else {
                throw ApplyError.targetMissing(url.path)
            }
            let merged = mergedAppend(existing: existing, addition: addText)
            if lineCount(of: merged) > limitFor(url) {
                throw ApplyError.wouldExceedLimit
            }
            planned.append((resolvedURL, existing, merged, isNewFile))
        }

        // Cross-file write is not transactional. On a mid-write failure we
        // best-effort restore previously-written files from the snapshot
        // captured during validation. Rollback errors are swallowed — the
        // primary error has to surface unobstructed.
        // For new-file writes: rollback deletes the file rather than
        // restoring an empty original, so a partial accept doesn't leave
        // a stub on disk that confuses the next indexer scan.
        var written: [(url: URL, original: String, wasNewFile: Bool)] = []
        for entry in planned {
            do {
                if entry.isNewFile {
                    let parent = entry.url.deletingLastPathComponent()
                    try FileManager.default.createDirectory(
                        at: parent,
                        withIntermediateDirectories: true
                    )
                }
                try atomicWrite(entry.contents, to: entry.url)
                written.append((entry.url, entry.original, entry.isNewFile))
            } catch {
                for restore in written.reversed() {
                    if restore.wasNewFile {
                        try? FileManager.default.removeItem(at: restore.url)
                    } else {
                        try? atomicWrite(restore.original, to: restore.url)
                    }
                }
                throw error
            }
        }
    }

    /// Returns the canonical filesystem path for `url`, resolving symlinks
    /// so two URLs that point at the same inode dedupe to one entry.
    /// Falls back to the lexical path when realpath(3) fails (e.g., the
    /// file does not yet exist) — caller handles the missing-file case.
    private static func resolvedRealPath(of url: URL) -> String {
        let path = url.path
        return path.withCString { cPath in
            guard let resolved = realpath(cPath, nil) else {
                return path
            }
            defer { free(resolved) }
            return String(cString: resolved)
        }
    }

    private static func applyReplace(_ s: ContextBankSuggestion) throws {
        let target = s.targetURL
        guard let existing = try? String(contentsOf: target, encoding: .utf8) else {
            throw ApplyError.targetMissing(s.targetPath)
        }
        guard let oldText = s.replaceOldText, let newText = s.addText else {
            throw ApplyError.replaceTextNotFound
        }
        // Single-match enforcement: `replacingOccurrences(of:)` would swap
        // every occurrence globally — when `oldText` appears in multiple
        // places (a recurring boilerplate phrase, etc.) that silently
        // mutates unrelated content. Refuse ambiguous edits and surface
        // the count so the curator can include more surrounding context.
        let matches = countOccurrences(of: oldText, in: existing)
        switch matches {
        case 0: throw ApplyError.replaceTextNotFound
        case 1: break
        default: throw ApplyError.replaceTextAmbiguous(matches: matches)
        }
        guard let range = existing.range(of: oldText) else {
            throw ApplyError.replaceTextNotFound
        }
        var updated = existing
        updated.replaceSubrange(range, with: newText)
        if !updated.hasSuffix("\n") { updated.append("\n") }
        try atomicWrite(updated, to: target)
    }

    private static func countOccurrences(of needle: String, in haystack: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        var count = 0
        var searchRange = haystack.startIndex..<haystack.endIndex
        while let range = haystack.range(of: needle, range: searchRange) {
            count += 1
            searchRange = range.upperBound..<haystack.endIndex
        }
        return count
    }

    private static func applyMove(_ s: ContextBankSuggestion, limitFor: (URL) -> Int) throws {
        guard let from = s.fromURL,
              let fromContent = try? String(contentsOf: from, encoding: .utf8) else {
            throw ApplyError.moveSourceMissing(s.fromPath ?? "")
        }
        guard let block = s.replaceOldText else {
            throw ApplyError.replaceTextNotFound
        }
        guard fromContent.contains(block) else {
            throw ApplyError.replaceTextNotFound
        }

        let target = s.targetURL
        guard let targetContent = try? String(contentsOf: target, encoding: .utf8) else {
            throw ApplyError.targetMissing(s.targetPath)
        }

        let movedText = s.addText ?? block
        let mergedTarget = mergedAppend(existing: targetContent, addition: movedText)
        if lineCount(of: mergedTarget) > limitFor(target) {
            throw ApplyError.wouldExceedLimit
        }
        var updatedFrom = fromContent.replacingOccurrences(of: block, with: "")
        while updatedFrom.contains("\n\n\n") {
            updatedFrom = updatedFrom.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        try atomicWrite(mergedTarget, to: target)
        try atomicWrite(updatedFrom, to: from)
    }

    // MARK: - Helpers

    private static func mergedAppend(existing: String, addition: String) -> String {
        var base = existing
        if !base.hasSuffix("\n") { base.append("\n") }
        let trimmedAddition = addition.trimmingCharacters(in: .whitespacesAndNewlines)
        return base + "\n" + trimmedAddition + "\n"
    }

    private static func lineCount(of s: String) -> Int {
        s.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    private static func atomicWrite(_ contents: String, to url: URL) throws {
        let tmp = url.appendingPathExtension("contextbank.tmp")
        try contents.write(to: tmp, atomically: true, encoding: .utf8)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
        #if DEBUG
        dlog("contextbank.applier.wrote bytes=\(contents.utf8.count) path=\(url.path)")
        #endif
    }
}
