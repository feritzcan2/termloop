import Foundation
import AppKit

final class UpdateLogStore {
    static let shared = UpdateLogStore()

    private let queue = DispatchQueue(label: "termloop.update.log")
    private var entries: [String] = []
    private let maxEntries = 200
    private let logURL: URL
    private let formatter: ISO8601DateFormatter

    private init() {
        formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let logsDir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        logURL = logsDir.appendingPathComponent("Logs/termloop-update.log")
        ensureLogFile()
    }

    func append(_ message: String) {
        let timestamp = formatter.string(from: Date())
        let bundle = Bundle.main.bundleIdentifier ?? "<no.bundle.id>"
        let pid = ProcessInfo.processInfo.processIdentifier
        let line = "[\(timestamp)] [\(bundle):\(pid)] \(message)"
        queue.async { [weak self] in
            guard let self else { return }
            entries.append(line)
            if entries.count > maxEntries {
                entries.removeFirst(entries.count - maxEntries)
            }
            appendToFile(line: line)
        }
    }

    func snapshot() -> String {
        queue.sync {
            entries.joined(separator: "\n")
        }
    }

    func logPath() -> String {
        logURL.path
    }

    private func ensureLogFile() {
        let directory = logURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            try? Data().write(to: logURL)
        }
    }

    private func appendToFile(line: String) {
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
        } else {
            try? data.write(to: logURL, options: .atomic)
        }
    }
}

/// Stubbed out in our fork — the disk-backed focus log was measured writing
/// 46MB+/day during normal use and is no longer useful to us. Upstream call
/// sites still invoke `append(_:)`, so the shared instance and API surface
/// are retained as no-ops.
final class FocusLogStore {
    static let shared = FocusLogStore()

    private init() {}

    func append(_ message: String) {}
    func snapshot() -> String { "" }
    func logPath() -> String { "" }
}
