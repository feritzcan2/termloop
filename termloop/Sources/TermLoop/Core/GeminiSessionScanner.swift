// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import CryptoKit
import Foundation

struct GeminiSessionMetadata: Equatable {
    let sessionId: String
    let projectHash: String
    let cwd: String?
    let file: URL
    let mtime: Date
    let creation: Date
    let title: String?
}

/// Reads Gemini CLI session transcripts at
/// `~/.gemini/tmp/<dir>/chats/session-*.jsonl`.
///
/// Schema observed (one JSON object per line):
/// 1. metadata: `{"sessionId":..,"projectHash":..,"startTime":..,"lastUpdated":..,"kind":"main"}`
/// 2. user turn: `{"id":..,"timestamp":..,"type":"user","content":[{"text":..}]}`
/// 3. assistant turn: `{"id":..,"timestamp":..,"type":"gemini","content":"…",
///    "thoughts":[..],"tokens":{..},"model":..}`
/// 4. warning: `{"type":"warning","content":"…"}`
/// 5. patch: `{"$set":{"lastUpdated":".."}}`
///
/// `projectHash` is `sha256(cwd)` (no trailing newline). The scanner indexes
/// by hash so a `scan(cwd:)` call hashes the input and pulls matching files.
final class GeminiSessionScanner {
    static let shared = GeminiSessionScanner()

    struct LifecycleSnapshot: Equatable {
        enum Activity: Equatable {
            case running
            case completed
        }

        let file: URL
        let mtime: Date
        let activity: Activity
        let timestamp: Date?
    }

    struct AssistantMessageSnapshot: Equatable {
        let file: URL
        let mtime: Date
        let text: String
    }

    private struct CacheEntry {
        let mtime: Date
        let metadata: GeminiSessionMetadata?
    }

    private struct AssistantTextEntry {
        let mtime: Date
        let text: String
    }

    private struct LifecycleEntry {
        let mtime: Date
        let snapshot: LifecycleSnapshot?
    }

    private struct IndexState {
        let builtAt: Date
        let sessionFileById: [String: URL]
        let sessionsByProjectHash: [String: [GeminiSessionMetadata]]
    }

    private let tmpDir: URL
    private let cacheLock = NSLock()
    private let indexLock = NSLock()
    private var cache: [URL: CacheEntry] = [:]
    private var assistantTextCache: [URL: AssistantTextEntry] = [:]
    private var lifecycleCache: [URL: LifecycleEntry] = [:]
    private var indexState: IndexState?
    private static let eventTimestampFormatter = ISO8601DateFormatter()
    private static let indexTTL: TimeInterval = 30

    init(geminiHome: URL = GeminiSessionScanner.defaultGeminiHome()) {
        self.tmpDir = geminiHome.appendingPathComponent("tmp", isDirectory: true)
    }

    static func defaultGeminiHome() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".gemini", isDirectory: true)
    }

    func lastAssistantMessage(sessionId: String, cwd: String?) -> String? {
        guard let file = sessionFileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return lastAssistantMessage(file: file)
    }

    func assistantMessageSnapshot(sessionId: String, cwd: String?) -> AssistantMessageSnapshot? {
        guard let file = sessionFileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return assistantMessageSnapshot(file: file)
    }

    func lastAssistantMessage(cwd: String) -> String? {
        guard let file = scan(cwd: cwd).first?.file else { return nil }
        return lastAssistantMessage(file: file)
    }

    func assistantMessageSnapshot(cwd: String, newerThan: Date? = nil) -> AssistantMessageSnapshot? {
        guard let file = scan(cwd: cwd, newerThan: newerThan).first?.file else { return nil }
        return assistantMessageSnapshot(file: file)
    }

    func lifecycleSnapshot(sessionId: String, cwd: String?) -> LifecycleSnapshot? {
        guard let file = sessionFileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        return lifecycleSnapshot(file: file)
    }

    func sessionFileURL(sessionId: String, cwd: String?) -> URL? {
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = indexedSessionFileURL(sessionId: trimmed, cwd: cwd, forceRebuild: false),
           FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        return indexedSessionFileURL(sessionId: trimmed, cwd: cwd, forceRebuild: true)
    }

    /// `newerThan` filters by **file creation time** (birth) when available,
    /// falling back to mtime. Helper workspaces inherit the source cwd; a
    /// user's pre-existing session in that cwd can be actively written to
    /// (recent mtime) but its creation date is older than any freshly-forked
    /// helper, so creation-time gating prevents grabbing the source's own
    /// session.
    func scan(cwd: String, newerThan: Date? = nil) -> [GeminiSessionMetadata] {
        let normalizedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCwd.isEmpty else { return [] }
        let hash = Self.projectHash(forCwd: normalizedCwd)
        let sessions = indexedState().sessionsByProjectHash[hash] ?? []
        guard let newerThan else { return sessions }
        return sessions.filter { $0.creation >= newerThan }
    }

    private func indexedSessionFileURL(sessionId: String, cwd: String?, forceRebuild: Bool) -> URL? {
        let state = indexedState(forceRebuild: forceRebuild)
        if let cwd {
            let normalizedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedCwd.isEmpty {
                let hash = Self.projectHash(forCwd: normalizedCwd)
                if let match = state.sessionsByProjectHash[hash]?.first(where: { $0.sessionId == sessionId }) {
                    return match.file
                }
            }
        }
        return state.sessionFileById[sessionId]
    }

    private func indexedState(forceRebuild: Bool = false, now: Date = Date()) -> IndexState {
        indexLock.lock()
        defer { indexLock.unlock() }

        if !forceRebuild,
           let cached = indexState,
           now.timeIntervalSince(cached.builtAt) < Self.indexTTL {
            return cached
        }

        let rebuilt = buildIndexState(now: now)
        indexState = rebuilt
        return rebuilt
    }

    private func buildIndexState(now: Date) -> IndexState {
        guard let enumerator = FileManager.default.enumerator(
            at: tmpDir,
            includingPropertiesForKeys: [
                .contentModificationDateKey,
                .creationDateKey,
                .isRegularFileKey,
            ],
            options: [.skipsHiddenFiles]
        ) else {
            return IndexState(builtAt: now, sessionFileById: [:], sessionsByProjectHash: [:])
        }

        var sessionFileById: [String: URL] = [:]
        var newestMtimeBySessionId: [String: Date] = [:]
        var sessionsByProjectHash: [String: [GeminiSessionMetadata]] = [:]

        for case let fileURL as URL in enumerator {
            guard fileURL.pathExtension == "jsonl" else { continue }
            // Only files under a `chats/` directory are session transcripts.
            // `~/.gemini/tmp/*/tool-outputs/...` and other siblings can also be
            // .jsonl but aren't sessions.
            guard fileURL.deletingLastPathComponent().lastPathComponent == "chats" else { continue }
            let values = try? fileURL.resourceValues(forKeys: [
                .contentModificationDateKey,
                .creationDateKey,
                .isRegularFileKey,
            ])
            if values?.isRegularFile == false { continue }
            let mtime = values?.contentModificationDate ?? Date(timeIntervalSince1970: 0)
            let creation = values?.creationDate ?? mtime
            guard let metadata = parse(file: fileURL, mtime: mtime, creation: creation) else { continue }

            let currentNewest = newestMtimeBySessionId[metadata.sessionId] ?? .distantPast
            if currentNewest <= metadata.mtime {
                newestMtimeBySessionId[metadata.sessionId] = metadata.mtime
                sessionFileById[metadata.sessionId] = metadata.file
            }
            sessionsByProjectHash[metadata.projectHash, default: []].append(metadata)
        }

        for hash in sessionsByProjectHash.keys {
            sessionsByProjectHash[hash]?.sort {
                if $0.mtime == $1.mtime {
                    return $0.sessionId < $1.sessionId
                }
                return $0.mtime > $1.mtime
            }
        }

        return IndexState(
            builtAt: now,
            sessionFileById: sessionFileById,
            sessionsByProjectHash: sessionsByProjectHash
        )
    }

    private func lastAssistantMessage(file: URL) -> String? {
        assistantMessageSnapshot(file: file)?.text.nilIfEmpty()
    }

    private func assistantMessageSnapshot(file: URL) -> AssistantMessageSnapshot? {
        let mtime = file.modificationDateOrEpoch

        cacheLock.lock()
        if let entry = assistantTextCache[file], entry.mtime == mtime {
            let cached = entry.text
            cacheLock.unlock()
            return cached.isEmpty ? nil : AssistantMessageSnapshot(file: file, mtime: mtime, text: cached)
        }
        cacheLock.unlock()

        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        var lastAssistant = ""
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let jsonData = rawLine.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
            else { continue }

            if let extracted = Self.extractAssistantText(from: object), !extracted.isEmpty {
                lastAssistant = extracted
            }
        }

        cacheLock.lock()
        assistantTextCache[file] = AssistantTextEntry(mtime: mtime, text: lastAssistant)
        cacheLock.unlock()
        return lastAssistant.isEmpty ? nil : AssistantMessageSnapshot(file: file, mtime: mtime, text: lastAssistant)
    }

    private func lifecycleSnapshot(file: URL) -> LifecycleSnapshot? {
        let mtime = file.modificationDateOrEpoch

        cacheLock.lock()
        if let entry = lifecycleCache[file], entry.mtime == mtime {
            let cached = entry.snapshot
            cacheLock.unlock()
            return cached
        }
        cacheLock.unlock()

        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        var latest: LifecycleSnapshot?
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let jsonData = rawLine.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
                continue
            }
            if let snapshot = Self.extractLifecycleSnapshot(from: object, file: file, mtime: mtime) {
                latest = snapshot
            }
        }

        cacheLock.lock()
        lifecycleCache[file] = LifecycleEntry(mtime: mtime, snapshot: latest)
        cacheLock.unlock()
        return latest
    }

    private func parse(file: URL, mtime: Date, creation: Date) -> GeminiSessionMetadata? {
        cacheLock.lock()
        if let entry = cache[file], entry.mtime == mtime {
            cacheLock.unlock()
            return entry.metadata
        }
        cacheLock.unlock()

        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }

        var sessionId: String?
        var projectHash: String?
        var title: String?
        var iterator = GeminiLineIterator(handle: handle)

        while let rawLine = iterator.next() {
            guard let jsonData = rawLine.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
            else { continue }

            // Metadata header line — first line of each session file.
            if sessionId == nil,
               let id = (object["sessionId"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !id.isEmpty {
                sessionId = id
                if let hash = (object["projectHash"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                   !hash.isEmpty {
                    projectHash = hash
                }
            }

            if title == nil,
               let extracted = Self.extractUserText(from: object) {
                title = truncate(extracted, to: 80)
            }

            if sessionId != nil, projectHash != nil, title != nil {
                break
            }
        }

        guard let sessionId, let projectHash else { return nil }
        let metadata = GeminiSessionMetadata(
            sessionId: sessionId,
            projectHash: projectHash,
            cwd: nil,
            file: file,
            mtime: mtime,
            creation: creation,
            title: title
        )

        cacheLock.lock()
        cache[file] = CacheEntry(mtime: mtime, metadata: metadata)
        cacheLock.unlock()
        return metadata
    }

    private static func extractAssistantText(from object: [String: Any]) -> String? {
        guard (object["type"] as? String) == "gemini" else { return nil }
        // `content` is a plain string for gemini turns. Reject empty strings —
        // an empty assistant turn is noise (model produced thoughts only or
        // hook fired before content).
        guard let text = (object["content"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return nil
        }
        return text
    }

    private static func extractUserText(from object: [String: Any]) -> String? {
        guard (object["type"] as? String) == "user" else { return nil }
        // `content` for user turns is `[{"text":"…"}]`.
        guard let content = object["content"] as? [[String: Any]] else { return nil }
        let chunks = content.compactMap { item -> String? in
            let text = (item["text"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return text?.isEmpty == false ? text : nil
        }
        guard !chunks.isEmpty else { return nil }
        return chunks.joined(separator: "\n\n")
    }

    private static func extractLifecycleSnapshot(
        from object: [String: Any],
        file: URL,
        mtime: Date
    ) -> LifecycleSnapshot? {
        guard let type = object["type"] as? String else { return nil }
        let timestamp = (object["timestamp"] as? String).flatMap {
            eventTimestampFormatter.date(from: $0)
        }
        switch type {
        case "user":
            return LifecycleSnapshot(
                file: file,
                mtime: mtime,
                activity: .running,
                timestamp: timestamp
            )
        case "gemini":
            return LifecycleSnapshot(
                file: file,
                mtime: mtime,
                activity: .completed,
                timestamp: timestamp
            )
        default:
            return nil
        }
    }

    static func projectHash(forCwd cwd: String) -> String {
        let data = Data(cwd.utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func truncate(_ s: String, to n: Int) -> String {
        if s.count <= n { return s }
        return String(s.prefix(n)) + "..."
    }
}

private extension String {
    func nilIfEmpty() -> String? {
        isEmpty ? nil : self
    }
}

private struct GeminiLineIterator: Sequence, IteratorProtocol {
    private let handle: FileHandle
    private var buffer = Data()
    private var eof = false
    private let chunk = 65_536

    init(handle: FileHandle) { self.handle = handle }

    mutating func next() -> String? {
        while !eof {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[..<newline]
                buffer.removeSubrange(...newline)
                return String(data: lineData, encoding: .utf8) ?? ""
            }
            let data = SafeFileHandleRead.readData(ofLength: chunk, from: handle)
            if data.isEmpty {
                eof = true
                break
            }
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

private extension URL {
    /// Reads mtime via `FileManager.attributesOfItem` rather than
    /// `resourceValues(forKeys:)` because `URL` caches resource values on the
    /// instance. Session URLs are kept across polls; a cached mtime would
    /// mask fresh writes — same trap CodexSessionScanner avoids.
    var modificationDateOrEpoch: Date {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return (attrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
    }
}
