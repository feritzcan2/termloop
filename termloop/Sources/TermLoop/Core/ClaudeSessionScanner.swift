// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

enum SafeFileHandleRead {
    static func readData(ofLength length: Int, from handle: FileHandle) -> Data {
        guard length > 0 else { return Data() }

        var buffer = [UInt8](repeating: 0, count: length)
        while true {
            let count = Darwin.read(handle.fileDescriptor, &buffer, length)
            if count > 0 {
                return Data(buffer.prefix(count))
            }
            if count == 0 {
                return Data()
            }
            if errno == EINTR {
                continue
            }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return Data()
            }
            return Data()
        }
    }
}

final class ClaudeSessionScanner {
    static let shared = ClaudeSessionScanner()

    struct AssistantMessageSnapshot: Equatable {
        let file: URL
        let mtime: Date
        let text: String
    }

    private let projectsDir: URL

    private struct CacheEntry {
        let mtime: Date
        let metadata: JSONLMetadata
    }

    /// Cache for `lastAssistantMessage(cwd:)` — avoids a full re-read when
    /// the file mtime has not changed since the previous extraction.
    private struct AssistantTextEntry {
        let mtime: Date
        let text: String
    }

    private let cacheLock = NSLock()
    private var cache: [URL: CacheEntry] = [:]
    private var assistantTextCache: [URL: AssistantTextEntry] = [:]
    private var sessionFileURLCache: [String: URL] = [:]

    init(projectsDir: URL = ClaudeSessionScanner.defaultProjectsDir()) {
        self.projectsDir = projectsDir
    }

    static func defaultProjectsDir() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects", isDirectory: true)
    }

    /// Converts a POSIX cwd to Claude Code's project slug. Claude Code
    /// replaces both `/` and `.` with `-`, so `/Users/x/repo/.termloop-worktrees/b`
    /// becomes `-Users-x-repo--termloop-worktrees-b` (double dash at the hidden
    /// segment). Missing the dot replacement makes worktree cwds miss their
    /// on-disk session directory.
    static func slug(forCwd cwd: String) -> String {
        var s = cwd
        if s.hasPrefix("/") { s = "-" + s.dropFirst() }
        s = s.replacingOccurrences(of: "/", with: "-")
        return s.replacingOccurrences(of: ".", with: "-")
    }

    /// Lists `.jsonl` files in the cwd's slug directory, sorted by mtime
    /// descending. Cheap: does not parse file contents.
    func listFiles(cwd: String) -> [URL] {
        listFilesWithMtime(cwd: cwd).map(\.url)
    }

    /// Pairs each candidate jsonl with its mtime (for sort order) and creation
    /// date (for the `newerThan` identity check — see scanner header doc).
    struct TimestampedFile {
        let url: URL
        let mtime: Date
        let creation: Date
    }

    func listFilesWithMtime(cwd: String) -> [TimestampedFile] {
        let slugDir = projectsDir.appendingPathComponent(
            Self.slug(forCwd: cwd), isDirectory: true)
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: slugDir,
            includingPropertiesForKeys: [
                .contentModificationDateKey,
                .creationDateKey,
            ],
            options: [.skipsHiddenFiles]) else { return [] }
        return files
            .filter { $0.pathExtension == "jsonl" }
            .map { url in
                let values = try? url.resourceValues(forKeys: [
                    .contentModificationDateKey,
                    .creationDateKey,
                ])
                let mtime = values?.contentModificationDate ?? .distantPast
                let creation = values?.creationDate ?? mtime
                return TimestampedFile(url: url, mtime: mtime, creation: creation)
            }
            .sorted { (a, b) in
                return a.mtime > b.mtime
            }
    }

    /// Returns the full text of the last `type == "assistant"` event in
    /// the given Claude session file. Concatenates multiple `text`
    /// content chunks with blank-line separators. Returns nil when no
    /// session exists or when the last assistant event has no parseable
    /// text content. Caches the result keyed by (URL, mtime) so repeated
    /// calls within the same debounce/retry window skip the full re-read.
    func lastAssistantMessage(sessionId: String, cwd: String?) -> String? {
        guard let file = fileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return lastAssistantMessage(file: file)
    }

    func assistantMessageSnapshot(sessionId: String, cwd: String?) -> AssistantMessageSnapshot? {
        guard let file = fileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return assistantMessageSnapshot(file: file)
    }

    /// Legacy fallback for callers that only know the cwd. This is
    /// ambiguous when multiple Claude sessions share the same project dir,
    /// so bridge forwarding should prefer `lastAssistantMessage(sessionId:)`.
    func lastAssistantMessage(cwd: String) -> String? {
        guard let file = listFiles(cwd: cwd).first else { return nil }
        return lastAssistantMessage(file: file)
    }

    /// `newerThan` filters by file creation time, not mtime: a pre-existing
    /// session in the shared cwd can receive writes (recent mtime) while its
    /// creation still predates the bridge. See scanner-header comment.
    func assistantMessageSnapshot(cwd: String, newerThan: Date? = nil) -> AssistantMessageSnapshot? {
        let candidates = listFilesWithMtime(cwd: cwd)
        let file: URL?
        if let newerThan {
            file = candidates.first(where: { $0.creation >= newerThan })?.url
        } else {
            file = candidates.first?.url
        }
        guard let file else { return nil }
        return assistantMessageSnapshot(file: file)
    }

    /// Resolves the exact JSONL file for a session id. Unlike `listFiles`,
    /// this never falls back to "latest file in the cwd"; it only returns a
    /// path when the filename stem matches the requested session id.
    func sessionFileURL(sessionId: String, cwd: String?) -> URL? {
        fileURL(sessionId: sessionId, cwd: cwd)
    }

    private func lastAssistantMessage(file: URL) -> String? {
        assistantMessageSnapshot(file: file)?.text.nilIfEmpty()
    }

    private func assistantMessageSnapshot(file: URL) -> AssistantMessageSnapshot? {
        // `URL` caches resource values internally on the URL instance. Since
        // we re-use the same URL from `sessionFileURLCache` across every poll
        // tick, a cached `contentModificationDate` would keep masking fresh
        // writes — exactly why ask-to forwarding kept seeing the pre-bridge
        // message forever. Read mtime via `FileManager.attributesOfItem`,
        // which hits the filesystem each call.
        let fileAttrs = try? FileManager.default.attributesOfItem(atPath: file.path)
        let mtime = (fileAttrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)

        // Cache hit: return without re-reading the file.
        cacheLock.lock()
        if let entry = assistantTextCache[file], entry.mtime == mtime {
            let cached = entry.text
            cacheLock.unlock()
            return cached.isEmpty ? nil : AssistantMessageSnapshot(file: file, mtime: mtime, text: cached)
        }
        cacheLock.unlock()

        guard let data = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        var lastAssistantChunks: [String]? = nil
        for line in data.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let jsonData = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = obj["type"] as? String,
                  type == "assistant"
            else { continue }
            let message = obj["message"] as? [String: Any]
            let content = message?["content"]
            let chunks = Self.extractTextChunks(from: content)
            if !chunks.isEmpty { lastAssistantChunks = chunks }
        }
        let result = lastAssistantChunks.map { $0.joined(separator: "\n\n") } ?? ""

        cacheLock.lock()
        assistantTextCache[file] = AssistantTextEntry(mtime: mtime, text: result)
        cacheLock.unlock()

        return result.isEmpty ? nil : AssistantMessageSnapshot(file: file, mtime: mtime, text: result)
    }

    private func fileURL(sessionId: String, cwd: String?) -> URL? {
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        cacheLock.lock()
        if let cached = sessionFileURLCache[trimmed] {
            cacheLock.unlock()
            if FileManager.default.fileExists(atPath: cached.path) {
                return cached
            }
            cacheLock.lock()
            sessionFileURLCache.removeValue(forKey: trimmed)
            cacheLock.unlock()
        } else {
            cacheLock.unlock()
        }

        if let cwd, !cwd.isEmpty {
            let candidate = projectsDir
                .appendingPathComponent(Self.slug(forCwd: cwd), isDirectory: true)
                .appendingPathComponent("\(trimmed).jsonl")
            if FileManager.default.fileExists(atPath: candidate.path) {
                cacheLock.lock()
                sessionFileURLCache[trimmed] = candidate
                cacheLock.unlock()
                return candidate
            }
        }

        guard let enumerator = FileManager.default.enumerator(
            at: projectsDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return nil }
        let target = "\(trimmed).jsonl"
        for case let fileURL as URL in enumerator {
            if fileURL.lastPathComponent == target {
                cacheLock.lock()
                sessionFileURLCache[trimmed] = fileURL
                cacheLock.unlock()
                return fileURL
            }
        }
        return nil
    }

    private static func extractTextChunks(from raw: Any?) -> [String] {
        // Claude Code JSONL: content is usually an array of { type, text },
        // occasionally a bare string.
        if let s = raw as? String { return [s] }
        guard let array = raw as? [[String: Any]] else { return [] }
        return array.compactMap { item -> String? in
            guard (item["type"] as? String) == "text" else { return nil }
            return item["text"] as? String
        }
    }

    func metadata(sessionId: String, cwd: String?) -> JSONLMetadata? {
        guard let file = fileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return parseMetadata(file: file)
    }

    /// Parse a single JSONL file's metadata. Expensive: reads file contents.
    /// Cached by file mtime — files whose mtime hasn't changed since the last
    /// parse return the cached result without re-reading.
    func parseMetadata(file: URL) -> JSONLMetadata? {
        let fileAttrs = try? FileManager.default.attributesOfItem(atPath: file.path)
        let mtime = (fileAttrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)

        cacheLock.lock()
        if let entry = cache[file], entry.mtime == mtime {
            cacheLock.unlock()
            return entry.metadata
        }
        cacheLock.unlock()

        guard let parsed = parse(file: file) else { return nil }

        cacheLock.lock()
        cache[file] = CacheEntry(mtime: mtime, metadata: parsed)
        cacheLock.unlock()
        return parsed
    }

    /// Scans session metadata. When `newerThan` is provided, files are filtered
    /// by creation date (not mtime) so user's pre-existing sessions in a shared
    /// cwd — which may still receive writes after the bridge started — are
    /// excluded. `listFilesWithMtime` sorts mtime-desc so we can't early-break
    /// on creation; we skip stale entries instead.
    func scan(cwd: String, newerThan: Date? = nil) -> [JSONLMetadata] {
        let files = listFilesWithMtime(cwd: cwd)
        guard let newerThan else {
            return files.compactMap { parseMetadata(file: $0.url) }
        }

        var results: [JSONLMetadata] = []
        for entry in files {
            if entry.creation < newerThan {
                continue
            }
            if let metadata = parseMetadata(file: entry.url) {
                results.append(metadata)
            }
        }
        return results
    }

    /// Merges session metadata across multiple cwd roots, deduping by
    /// session id so copied worktree/root entries appear only once.
    /// When duplicates exist, the newest file wins.
    func scan(cwds: [String]) -> [JSONLMetadata] {
        var seenCwds = Set<String>()
        var mergedBySessionId: [String: JSONLMetadata] = [:]

        for raw in cwds {
            let cwd = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cwd.isEmpty, seenCwds.insert(cwd).inserted else { continue }
            for metadata in scan(cwd: cwd) {
                guard let existing = mergedBySessionId[metadata.sessionId] else {
                    mergedBySessionId[metadata.sessionId] = metadata
                    continue
                }
                if metadata.mtime > existing.mtime {
                    mergedBySessionId[metadata.sessionId] = metadata
                }
            }
        }

        return mergedBySessionId.values.sorted { lhs, rhs in
            if lhs.mtime == rhs.mtime {
                return lhs.sessionId < rhs.sessionId
            }
            return lhs.mtime > rhs.mtime
        }
    }

    /// Permanently deletes the JSONL session file and purges its cache entry.
    func deleteSession(path: URL) throws {
        try FileManager.default.removeItem(at: path)
        let sessionId = path.deletingPathExtension().lastPathComponent
        cacheLock.lock()
        cache.removeValue(forKey: path)
        sessionFileURLCache.removeValue(forKey: sessionId)
        cacheLock.unlock()
    }

    private func parse(file: URL) -> JSONLMetadata? {
        let sid = file.deletingPathExtension().lastPathComponent
        let fileAttrs = try? FileManager.default.attributesOfItem(atPath: file.path)
        let mtime = (fileAttrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)

        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }

        var cwd: String?
        var title: String?
        var messageCount = 0
        var tail: [(line: TranscriptLine, isAssistant: Bool, text: String)] = []
        let tailCap = 30

        for raw in LineIterator(handle: handle) {
            guard let data = raw.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            if cwd == nil, let c = obj["cwd"] as? String { cwd = c }

            guard let kind = obj["type"] as? String else { continue }

            switch kind {
            case "user":
                if let t = extractUserText(obj) {
                    if title == nil { title = truncate(t, to: 80) }
                    messageCount += 1
                    appendTail(&tail, line: .user(t), isAssistant: false, text: t, cap: tailCap)
                }
            case "assistant":
                if let (text, toolCall) = extractAssistant(obj) {
                    if let text = text {
                        messageCount += 1
                        appendTail(&tail, line: .assistant(text), isAssistant: true, text: text, cap: tailCap)
                    }
                    if let (name, arg) = toolCall {
                        appendTail(&tail, line: .toolCall(name: name, arg: arg), isAssistant: false, text: "", cap: tailCap)
                    }
                }
            default: continue
            }
        }

        guard let finalCwd = cwd, let finalTitle = title else { return nil }
        let lastAssistant = tail.last(where: { $0.isAssistant })?.text ?? ""
        let lastUser = tail.last(where: { if case .user = $0.line { return true }; return false })?.text ?? ""
        return JSONLMetadata(
            sessionId: sid,
            path: file,
            cwd: finalCwd,
            mtime: mtime,
            title: finalTitle,
            messageCount: messageCount,
            lastAssistantSnippet: truncate(lastAssistant, to: 100),
            lastUserSnippet: truncate(lastUser, to: 100),
            previewLines: tail.map { $0.line })
    }

    private func extractUserText(_ obj: [String: Any]) -> String? {
        guard let msg = obj["message"] as? [String: Any] else { return nil }
        if let s = msg["content"] as? String { return s.isEmpty ? nil : s }
        if let arr = msg["content"] as? [[String: Any]] {
            let texts = arr.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            return texts.isEmpty ? nil : texts.joined(separator: " ")
        }
        return nil
    }

    private func extractAssistant(_ obj: [String: Any]) -> (text: String?, toolCall: (String, String)?)? {
        guard let msg = obj["message"] as? [String: Any],
              let arr = msg["content"] as? [[String: Any]] else { return nil }
        var text: String?
        var toolCall: (String, String)?
        for item in arr {
            let t = item["type"] as? String
            if t == "text", let s = item["text"] as? String, !s.isEmpty {
                text = (text.map { $0 + " " } ?? "") + s
            } else if t == "tool_use",
                      let name = item["name"] as? String {
                let input = item["input"] as? [String: Any] ?? [:]
                let arg = firstStringArg(input)
                toolCall = (name, arg)
            }
        }
        if text == nil && toolCall == nil { return nil }
        return (text, toolCall)
    }

    private func firstStringArg(_ input: [String: Any]) -> String {
        if let s = input["file_path"] as? String { return s }
        if let s = input["path"] as? String { return s }
        if let s = input["command"] as? String { return s }
        if let (_, v) = input.first(where: { $0.value is String }),
           let s = v as? String { return s }
        return ""
    }

    private func appendTail(
        _ tail: inout [(line: TranscriptLine, isAssistant: Bool, text: String)],
        line: TranscriptLine, isAssistant: Bool, text: String, cap: Int
    ) {
        tail.append((line, isAssistant, text))
        if tail.count > cap { tail.removeFirst(tail.count - cap) }
    }

    private func truncate(_ s: String, to n: Int) -> String {
        if s.count <= n { return s }
        return String(s.prefix(n)) + "…"
    }
}

private extension String {
    func nilIfEmpty() -> String? {
        isEmpty ? nil : self
    }
}

/// Minimal line iterator over a FileHandle. Reads 64 KB chunks and splits on `\n`.
private struct LineIterator: Sequence, IteratorProtocol {
    private let handle: FileHandle
    private var buffer = Data()
    private var eof = false
    private let chunk = 65_536

    init(handle: FileHandle) { self.handle = handle }

    mutating func next() -> String? {
        while !eof {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[..<nl]
                buffer.removeSubrange(...nl)
                return String(data: lineData, encoding: .utf8) ?? ""
            }
            let data = SafeFileHandleRead.readData(ofLength: chunk, from: handle)
            if data.isEmpty { eof = true; break }
            buffer.append(data)
        }
        if !buffer.isEmpty {
            let rest = String(data: buffer, encoding: .utf8) ?? ""
            buffer.removeAll()
            return rest.isEmpty ? nil : rest
        }
        return nil
    }
}
