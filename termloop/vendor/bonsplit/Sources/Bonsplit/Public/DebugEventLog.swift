#if DEBUG
import Combine
import Foundation

/// Unified ring-buffer event log for key, mouse, focus, and split events.
/// Writes every entry to a debug log path so `tail -f` works in real time.
public final class DebugEventLog: @unchecked Sendable {
    public static let shared = DebugEventLog()

    private var entries: [String] = []
    private let capacity = 500
    private let queue = DispatchQueue(label: "cmux.debug-event-log")
    private static let logPath = resolveLogPath()
    private static let maxLogFileBytes = resolveMaxLogFileBytes()
    private let subject = PassthroughSubject<String, Never>()

    public static var logFilePath: String { logPath }

    public var eventPublisher: AnyPublisher<String, Never> {
        subject.eraseToAnyPublisher()
    }

    public func snapshot() -> [String] {
        queue.sync { entries }
    }

    public func clearBuffer() {
        queue.async {
            self.entries.removeAll()
        }
    }

    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    private static func sanitizePathToken(_ raw: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let unicode = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let sanitized = String(unicode).trimmingCharacters(in: CharacterSet(charactersIn: "-."))
        return sanitized.isEmpty ? "debug" : sanitized
    }

    private static func resolveLogPath() -> String {
        let env = ProcessInfo.processInfo.environment

        if let explicit = env["TERMLOOP_DEBUG_LOG"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !explicit.isEmpty {
            return explicit
        }

        if let tag = env["TERMLOOP_TAG"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !tag.isEmpty {
            return "/tmp/termloop-debug-\(sanitizePathToken(tag)).log"
        }

        if let socketPath = env["TERMLOOP_SOCKET_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !socketPath.isEmpty {
            let socketBase = URL(fileURLWithPath: socketPath).deletingPathExtension().lastPathComponent
            if socketBase.hasPrefix("cmux-debug-") {
                return "/tmp/\(socketBase).log"
            }
        }

        if let bundleId = Bundle.main.bundleIdentifier,
           bundleId != "com.termloop.app.debug" {
            return "/tmp/termloop-debug-\(sanitizePathToken(bundleId)).log"
        }

        return "/tmp/termloop-debug.log"
    }

    private static func resolveMaxLogFileBytes() -> UInt64 {
        let env = ProcessInfo.processInfo.environment
        let raw = env["TERMLOOP_DEBUG_LOG_MAX_BYTES"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw, !raw.isEmpty, let parsed = UInt64(raw) else {
            return 32 * 1024 * 1024
        }
        return parsed
    }

    private static func rotateLogFileIfNeeded(incomingByteCount: Int) {
        guard maxLogFileBytes > 0 else { return }

        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: logPath),
              let currentSize = attrs[.size] as? NSNumber else {
            return
        }

        let projectedSize = currentSize.uint64Value + UInt64(max(0, incomingByteCount))
        guard projectedSize > maxLogFileBytes else { return }

        let rotatedPath = "\(logPath).1"
        try? fm.removeItem(atPath: rotatedPath)
        do {
            try fm.moveItem(atPath: logPath, toPath: rotatedPath)
        } catch {
            try? fm.removeItem(atPath: logPath)
        }
    }

    public func log(_ msg: String) {
        let ts = Self.formatter.string(from: Date())
        let entry = "\(ts) \(msg)"
        queue.async {
            if self.entries.count >= self.capacity {
                self.entries.removeFirst()
            }
            self.entries.append(entry)
            self.subject.send(entry)
            // Append to file for real-time tail -f. Uses throwing APIs so an I/O
            // failure (disk full, deleted file, permission error) can't raise an
            // uncaught NSFileHandleOperationException and abort the app.
            let line = entry + "\n"
            guard let data = line.data(using: .utf8) else { return }
            let url = URL(fileURLWithPath: Self.logPath)
            Self.rotateLogFileIfNeeded(incomingByteCount: data.count)
            if FileManager.default.fileExists(atPath: Self.logPath) {
                do {
                    let handle = try FileHandle(forWritingTo: url)
                    defer { try? handle.close() }
                    try handle.seekToEnd()
                    try handle.write(contentsOf: data)
                } catch {
                    // Last-resort fallback: recreate the file with the new line.
                    FileManager.default.createFile(atPath: Self.logPath, contents: data)
                }
            } else {
                FileManager.default.createFile(atPath: Self.logPath, contents: data)
            }
        }
    }

    /// Write all buffered entries to the log file (full dump, replacing contents).
    public func dump() {
        queue.async {
            let content = self.entries.joined(separator: "\n") + "\n"
            try? content.write(toFile: Self.logPath, atomically: true, encoding: .utf8)
        }
    }
}

/// Convenience free function. Logs the message and appends to the configured debug log path.
public func dlog(_ msg: String) {
    DebugEventLog.shared.log(msg)
}
#endif
