// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum SessionReplayCLI {
    /// Dispatch entry for `cmux session <sub> <args>`. Called from the
    /// single-line marker-wrapped case in `CLI/cmux.swift`.
    static func run(_ args: [String]) -> Int32 {
        guard let sub = args.first else {
            FileHandle.standardError.write(Data("usage: termloop session replay <jsonl-path>\n".utf8))
            return 2
        }
        switch sub {
        case "replay":
            return replay(Array(args.dropFirst()))
        default:
            FileHandle.standardError.write(Data("unknown session subcommand: \(sub)\n".utf8))
            return 2
        }
    }

    private static func replay(_ args: [String]) -> Int32 {
        guard let path = args.first else {
            FileHandle.standardError.write(Data("usage: termloop session replay <jsonl-path>\n".utf8))
            return 2
        }
        let url = URL(fileURLWithPath: path)
        let sid = url.deletingPathExtension().lastPathComponent

        guard let handle = try? FileHandle(forReadingFrom: url) else {
            FileHandle.standardError.write(Data("session file not readable: \(path)\n".utf8))
            return 1
        }
        defer { try? handle.close() }

        ClaudeSessionReplayStream.stream(handle: handle) { line in
            let rendered = ClaudeSessionJSONLFormatter.render(line, colorize: true)
            print(rendered)
        }

        print("\u{001B}[2;37m─── resuming session \(sid) ───\u{001B}[0m")

        // Resolve the REAL claude binary, skipping the termloop shell-script wrapper
        // (which has a macOS-incompatible `mktemp` call that causes resume to fail).
        let claudePath = findRealClaudeBinary()

        let argv: [String] = ["claude", "--resume", sid]
        let cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
        defer { cArgs.forEach { if let p = $0 { free(p) } } }

        if let claudePath {
            execv(claudePath, cArgs)  // direct path → execv (not execvp)
        } else {
            execvp("claude", cArgs)  // fallback: PATH search
        }
        let err = String(cString: strerror(errno))
        FileHandle.standardError.write(Data("exec claude failed: \(err)\n".utf8))
        return 127
    }

    private static func findRealClaudeBinary() -> String? {
        let candidates = [
            (ProcessInfo.processInfo.environment["HOME"] ?? "") + "/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            "/usr/bin/claude"
        ]
        for path in candidates where !path.isEmpty {
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            if isShellScript(path: path) { continue }  // skip termloop wrapper
            return path
        }
        // Also scan PATH, skipping our own directory and any shell-script wrappers.
        let selfDir = (Bundle.main.bundleURL).appendingPathComponent("Contents/Resources/bin").path
        let pathEnv = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for dir in pathEnv.split(separator: ":") {
            let d = String(dir)
            if d == selfDir { continue }
            let candidate = d + "/claude"
            guard FileManager.default.isExecutableFile(atPath: candidate) else { continue }
            if isShellScript(path: candidate) { continue }
            return candidate
        }
        return nil
    }

    private static func isShellScript(path: String) -> Bool {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path),
                                    options: [.mappedIfSafe]).prefix(2)
        else { return false }
        return data.count >= 2 && data[0] == 0x23 && data[1] == 0x21  // "#!"
    }
}

/// Streaming pass that yields every transcript-worthy line in order.
/// Separate from the scanner's tail-only logic so replay prints the full file.
enum ClaudeSessionReplayStream {
    static func stream(handle: FileHandle, emit: (TranscriptLine) -> Void) {
        var buffer = Data()
        let chunk = 65_536
        while true {
            let data = handle.readData(ofLength: chunk)
            if data.isEmpty { break }
            buffer.append(data)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer[..<nl]
                buffer.removeSubrange(...nl)
                if let s = String(data: lineData, encoding: .utf8) {
                    emitLines(from: s, emit: emit)
                }
            }
        }
        if !buffer.isEmpty, let s = String(data: buffer, encoding: .utf8) {
            emitLines(from: s, emit: emit)
        }
    }

    private static func emitLines(from raw: String, emit: (TranscriptLine) -> Void) {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = obj["type"] as? String else { return }
        switch kind {
        case "user":
            if let s = userText(obj) { emit(.user(s)) }
        case "assistant":
            if let (text, tool) = assistantParts(obj) {
                if let t = text { emit(.assistant(t)) }
                if let (n, a) = tool { emit(.toolCall(name: n, arg: a)) }
            }
        default: break
        }
    }

    private static func userText(_ obj: [String: Any]) -> String? {
        guard let msg = obj["message"] as? [String: Any] else { return nil }
        if let s = msg["content"] as? String { return s.isEmpty ? nil : s }
        if let arr = msg["content"] as? [[String: Any]] {
            let texts = arr.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            return texts.isEmpty ? nil : texts.joined(separator: " ")
        }
        return nil
    }

    private static func assistantParts(_ obj: [String: Any]) -> (text: String?, tool: (String, String)?)? {
        guard let msg = obj["message"] as? [String: Any],
              let arr = msg["content"] as? [[String: Any]] else { return nil }
        var text: String?
        var tool: (String, String)?
        for item in arr {
            let t = item["type"] as? String
            if t == "text", let s = item["text"] as? String, !s.isEmpty {
                text = (text.map { $0 + " " } ?? "") + s
            } else if t == "tool_use", let n = item["name"] as? String {
                let input = item["input"] as? [String: Any] ?? [:]
                let arg = firstStringArg(input)
                tool = (n, arg)
            }
        }
        if text == nil && tool == nil { return nil }
        return (text, tool)
    }

    private static func firstStringArg(_ input: [String: Any]) -> String {
        if let s = input["file_path"] as? String { return s }
        if let s = input["path"] as? String { return s }
        if let s = input["command"] as? String { return s }
        if let (_, v) = input.first(where: { $0.value is String }),
           let s = v as? String { return s }
        return ""
    }
}
