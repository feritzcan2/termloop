// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CodexSessionMetadata: Equatable {
    let sessionId: String
    let cwd: String
    let file: URL
    let mtime: Date
    let creation: Date
    let title: String?
}

final class CodexSessionScanner {
    static let shared = CodexSessionScanner()

    struct LifecycleSnapshot: Equatable {
        enum Activity: Equatable {
            case running
            case interrupted
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
        let metadata: CodexSessionMetadata?
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
        let sessionsByCwd: [String: [CodexSessionMetadata]]
    }

    private let sessionsDir: URL
    private let cacheLock = NSLock()
    private let indexLock = NSLock()
    private var cache: [URL: CacheEntry] = [:]
    private var assistantTextCache: [URL: AssistantTextEntry] = [:]
    private var lifecycleCache: [URL: LifecycleEntry] = [:]
    private var indexState: IndexState?
    private static let eventTimestampFormatter = ISO8601DateFormatter()
    private static let indexTTL: TimeInterval = 30

    init(codexHome: URL = CodexSessionScanner.defaultCodexHome()) {
        self.sessionsDir = codexHome.appendingPathComponent("sessions", isDirectory: true)
    }

    static func defaultCodexHome() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex", isDirectory: true)
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

    /// Indexed scan. `newerThan` filters by file creation time so cached
    /// historical sessions do not get picked up by fresh-launch recovery.
    func scan(cwd: String, newerThan: Date? = nil) -> [CodexSessionMetadata] {
        let normalizedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCwd.isEmpty else { return [] }
        let sessions = indexedState().sessionsByCwd[normalizedCwd] ?? []
        guard let newerThan else { return sessions }
        return sessions.filter { $0.creation >= newerThan }
    }

    /// Uncached recent scan for recovery paths where the session file may have
    /// been created after the long-lived index was built. Uses creation OR mtime
    /// so copied files and actively-written sessions still count as recent.
    func scanRecentUncached(cwd: String, newerThan: Date) -> [CodexSessionMetadata] {
        let normalizedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedCwd.isEmpty else { return [] }
        return freshRecentScan(cwd: normalizedCwd, newerThan: newerThan)
    }

    private func indexedSessionFileURL(sessionId: String, cwd: String?, forceRebuild: Bool) -> URL? {
        let state = indexedState(forceRebuild: forceRebuild)
        if let cwd {
            let normalizedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
            if !normalizedCwd.isEmpty,
               let match = state.sessionsByCwd[normalizedCwd]?.first(where: { $0.sessionId == sessionId }) {
                return match.file
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
            at: sessionsDir,
            includingPropertiesForKeys: [
                .contentModificationDateKey,
                .creationDateKey,
                .isRegularFileKey,
            ],
            options: [.skipsHiddenFiles]
        ) else {
            return IndexState(builtAt: now, sessionFileById: [:], sessionsByCwd: [:])
        }

        var sessionFileById: [String: URL] = [:]
        var newestMtimeBySessionId: [String: Date] = [:]
        var sessionsByCwd: [String: [CodexSessionMetadata]] = [:]

        for case let fileURL as URL in enumerator {
            guard fileURL.pathExtension == "jsonl" else { continue }
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
            sessionsByCwd[metadata.cwd, default: []].append(metadata)
        }

        for cwd in sessionsByCwd.keys {
            sessionsByCwd[cwd]?.sort {
                if $0.mtime == $1.mtime {
                    return $0.sessionId < $1.sessionId
                }
                return $0.mtime > $1.mtime
            }
        }

        return IndexState(
            builtAt: now,
            sessionFileById: sessionFileById,
            sessionsByCwd: sessionsByCwd
        )
    }

    private func freshRecentScan(cwd: String, newerThan: Date) -> [CodexSessionMetadata] {
        guard let enumerator = FileManager.default.enumerator(
            at: sessionsDir,
            includingPropertiesForKeys: [
                .contentModificationDateKey,
                .creationDateKey,
                .isRegularFileKey,
            ],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        var matches: [CodexSessionMetadata] = []
        for case let fileURL as URL in enumerator {
            guard fileURL.pathExtension == "jsonl" else { continue }
            let values = try? fileURL.resourceValues(forKeys: [
                .contentModificationDateKey,
                .creationDateKey,
                .isRegularFileKey,
            ])
            if values?.isRegularFile == false { continue }
            let mtime = values?.contentModificationDate ?? Date(timeIntervalSince1970: 0)
            let creation = values?.creationDate ?? mtime
            // Avoid reading large historical Codex JSONL files during startup
            // self-heal. New sessions may have either birth time or mtime in
            // the recency window depending on filesystem/copy behavior.
            guard creation >= newerThan || mtime >= newerThan else { continue }
            guard let metadata = parse(file: fileURL, mtime: mtime, creation: creation),
                  metadata.cwd == cwd,
                  (metadata.creation >= newerThan || metadata.mtime >= newerThan) else {
                continue
            }
            matches.append(metadata)
        }
        return matches.sorted {
            if $0.mtime == $1.mtime {
                return $0.sessionId < $1.sessionId
            }
            return $0.mtime > $1.mtime
        }
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
                  let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let snapshot = Self.extractLifecycleSnapshot(from: object, file: file, mtime: mtime) else {
                continue
            }
            latest = snapshot
        }

        cacheLock.lock()
        lifecycleCache[file] = LifecycleEntry(mtime: mtime, snapshot: latest)
        cacheLock.unlock()
        return latest
    }

    private func parse(file: URL, mtime: Date, creation: Date) -> CodexSessionMetadata? {
        cacheLock.lock()
        if let entry = cache[file], entry.mtime == mtime {
            cacheLock.unlock()
            return entry.metadata
        }
        cacheLock.unlock()

        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }

        var sessionId: String?
        var cwd: String?
        var title: String?
        var titleIsBootstrap = false
        var iterator = CodexLineIterator(handle: handle)

        while let rawLine = iterator.next() {
            guard let jsonData = rawLine.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any]
            else { continue }

            switch object["type"] as? String {
            case "session_meta":
                guard let payload = object["payload"] as? [String: Any] else { continue }
                if sessionId == nil {
                    let value = (payload["id"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if value?.isEmpty == false {
                        sessionId = value
                    }
                }
                if cwd == nil {
                    let value = (payload["cwd"] as? String)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if value?.isEmpty == false {
                        cwd = value
                    }
                }
            case "response_item":
                if title == nil {
                    if let extracted = Self.extractUserText(from: object) {
                        if Self.isBootstrapUserText(extracted) {
                            title = truncate(extracted, to: 80)
                            titleIsBootstrap = true
                        } else {
                            title = truncate(extracted, to: 80)
                            titleIsBootstrap = false
                        }
                    }
                }
            case "event_msg":
                if title == nil || titleIsBootstrap {
                    if let extracted = Self.extractUserMessageText(from: object) {
                        title = truncate(extracted, to: 80)
                        titleIsBootstrap = false
                    }
                }
            default:
                continue
            }

            if sessionId != nil, cwd != nil, title != nil {
                break
            }
        }

        guard let sessionId, let cwd else { return nil }
        let metadata = CodexSessionMetadata(
            sessionId: sessionId,
            cwd: cwd,
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

    func metadata(sessionId: String, cwd: String?) -> CodexSessionMetadata? {
        guard let file = sessionFileURL(sessionId: sessionId, cwd: cwd) else { return nil }
        let values = try? file.resourceValues(forKeys: [
            .contentModificationDateKey,
            .creationDateKey,
        ])
        let mtime = values?.contentModificationDate ?? Date(timeIntervalSince1970: 0)
        let creation = values?.creationDate ?? mtime
        return parse(file: file, mtime: mtime, creation: creation)
    }

    private static func extractAssistantText(from object: [String: Any]) -> String? {
        let type = object["type"] as? String
        switch type {
        case "response_item":
            guard let payload = object["payload"] as? [String: Any],
                  (payload["type"] as? String) == "message",
                  (payload["role"] as? String) == "assistant",
                  let content = payload["content"] as? [[String: Any]] else {
                return nil
            }
            let chunks = content.compactMap { item -> String? in
                guard (item["type"] as? String) == "output_text" else { return nil }
                let text = (item["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                return (text?.isEmpty == false) ? text : nil
            }
            return chunks.isEmpty ? nil : chunks.joined(separator: "\n\n")
        case "event_msg":
            guard let payload = object["payload"] as? [String: Any],
                  (payload["type"] as? String) == "agent_message",
                  let text = (payload["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty else {
                return nil
            }
            return text
        default:
            return nil
        }
    }

    private static func extractUserText(from object: [String: Any]) -> String? {
        guard let payload = object["payload"] as? [String: Any],
              (payload["type"] as? String) == "message",
              (payload["role"] as? String) == "user",
              let content = payload["content"] as? [[String: Any]] else {
            return nil
        }

        let chunks = content.compactMap { item -> String? in
            switch item["type"] as? String {
            case "input_text", "text":
                let text = (item["text"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return text?.isEmpty == false ? text : nil
            default:
                return nil
            }
        }
        guard !chunks.isEmpty else { return nil }
        return chunks.joined(separator: "\n\n")
    }

    private static func isBootstrapUserText(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return trimmed.hasPrefix("# AGENTS.md instructions")
            || trimmed.contains("AGENTS.md instructions for ")
            || trimmed.contains("<environment_context>")
            || trimmed.contains("<permissions instructions>")
            || trimmed.contains("<collaboration_mode>")
    }

    private static func extractUserMessageText(from object: [String: Any]) -> String? {
        guard let payload = object["payload"] as? [String: Any],
              (payload["type"] as? String) == "user_message",
              let text = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return nil
        }
        return text
    }

    private static func extractLifecycleSnapshot(
        from object: [String: Any],
        file: URL,
        mtime: Date
    ) -> LifecycleSnapshot? {
        guard (object["type"] as? String) == "event_msg",
              let payload = object["payload"] as? [String: Any],
              let eventType = payload["type"] as? String else {
            return nil
        }

        let timestamp = (object["timestamp"] as? String).flatMap {
            eventTimestampFormatter.date(from: $0)
        }

        switch eventType {
        case "task_started":
            return LifecycleSnapshot(
                file: file,
                mtime: mtime,
                activity: .running,
                timestamp: timestamp
            )
        case "turn_aborted":
            guard (payload["reason"] as? String) == "interrupted" else { return nil }
            return LifecycleSnapshot(
                file: file,
                mtime: mtime,
                activity: .interrupted,
                timestamp: timestamp
            )
        case "task_complete":
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

private struct CodexLineIterator: Sequence, IteratorProtocol {
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
    /// instance. Session URLs are kept in `sessionFileById` across polls, so
    /// a cached mtime would mask fresh writes — the exact bug that made
    /// ask-to forwarding stall on the pre-bridge snapshot forever.
    var modificationDateOrEpoch: Date {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return (attrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
    }
}
