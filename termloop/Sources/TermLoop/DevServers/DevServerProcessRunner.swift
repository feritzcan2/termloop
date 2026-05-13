// Copyright (c) 2026-present Ferit Özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Darwin
import Foundation

public final class DevServerManagedProcess: @unchecked Sendable {
    public let runId: UUID
    public let pid: Int32
    public let processGroupId: pid_t?

    private let process: Process
    private let stdoutReader: DevServerPipeReader
    private let stderrReader: DevServerPipeReader

    fileprivate init(
        runId: UUID,
        process: Process,
        processGroupId: pid_t?,
        stdoutReader: DevServerPipeReader,
        stderrReader: DevServerPipeReader
    ) {
        self.runId = runId
        self.process = process
        self.pid = process.processIdentifier
        self.processGroupId = processGroupId
        self.stdoutReader = stdoutReader
        self.stderrReader = stderrReader
    }

    public var isRunning: Bool { process.isRunning }

    public func stop(graceSeconds: TimeInterval = 2.0) {
        guard process.isRunning else { return }
        signal(SIGTERM)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + graceSeconds) { [weak self] in
            guard let self, self.process.isRunning else { return }
            self.signal(SIGKILL)
        }
    }

    public func stopImmediately() {
        guard process.isRunning else { return }
        signal(SIGKILL)
    }

    private func signal(_ signal: Int32) {
        if let processGroupId, processGroupId > 0 {
            _ = Darwin.kill(-processGroupId, signal)
        } else if signal == SIGTERM {
            process.terminate()
        } else {
            _ = Darwin.kill(pid, signal)
        }
    }

    func flushReaders() {
        stdoutReader.flush()
        stderrReader.flush()
    }
}

public enum DevServerProcessRunner {
    public typealias LineHandler = @Sendable (_ stream: DevServerLogStream, _ line: String) -> Void
    public typealias ExitHandler = @Sendable (_ exitCode: Int32) -> Void

    public static func launch(
        runId: UUID,
        command: String,
        cwd: URL,
        environment: [String: String],
        onLine: @escaping LineHandler,
        onExit: @escaping ExitHandler
    ) throws -> DevServerManagedProcess {
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdoutReader = DevServerPipeReader(stream: .stdout, onLine: onLine)
        let stderrReader = DevServerPipeReader(stream: .stderr, onLine: onLine)
        let process = Process()
        let shell = resolvedShell()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-lc", command]
        process.currentDirectoryURL = cwd
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            stdoutReader.consume(handle.availableData)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            stderrReader.consume(handle.availableData)
        }

        process.terminationHandler = { process in
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            stdoutReader.flush()
            stderrReader.flush()
            onExit(process.terminationStatus)
        }

        do {
            try process.run()
        } catch {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            throw error
        }

        let pid = process.processIdentifier
        let processGroupId: pid_t? = Darwin.setpgid(pid, pid) == 0 ? pid : nil
        return DevServerManagedProcess(
            runId: runId,
            process: process,
            processGroupId: processGroupId,
            stdoutReader: stdoutReader,
            stderrReader: stderrReader
        )
    }

    private static func resolvedShell() -> String {
        let raw = ProcessInfo.processInfo.environment["SHELL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty, FileManager.default.isExecutableFile(atPath: raw) else {
            return "/bin/zsh"
        }
        return raw
    }
}

fileprivate final class DevServerPipeReader: @unchecked Sendable {
    private let stream: DevServerLogStream
    private let onLine: DevServerProcessRunner.LineHandler
    private let lock = NSLock()
    private var buffer = Data()

    init(stream: DevServerLogStream, onLine: @escaping DevServerProcessRunner.LineHandler) {
        self.stream = stream
        self.onLine = onLine
    }

    func consume(_ data: Data) {
        guard !data.isEmpty else {
            flush()
            return
        }
        var lines: [String] = []
        lock.lock()
        buffer.append(data)
        while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = buffer[..<newline]
            buffer.removeSubrange(...newline)
            if let line = Self.decode(lineData) {
                lines.append(line)
            }
        }
        lock.unlock()
        for line in lines { onLine(stream, line) }
    }

    func flush() {
        let line: String? = {
            lock.lock(); defer { lock.unlock() }
            guard !buffer.isEmpty else { return nil }
            let data = buffer
            buffer.removeAll(keepingCapacity: false)
            return Self.decode(data)
        }()
        if let line { onLine(stream, line) }
    }

    private static func decode(_ data: Data.SubSequence) -> String? {
        guard !data.isEmpty else { return nil }
        let trimmed = data.last == UInt8(ascii: "\r") ? data.dropLast() : data
        return String(data: Data(trimmed), encoding: .utf8)
    }
}
