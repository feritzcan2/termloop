// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Inspects a hook entry for static validity (script exists, is executable)
/// without triggering side effects. Claude and Codex hooks share this shape.
struct HookTestRunner: TestRunner {
    func run(_ item: IntegrationItem) async -> IntegrationTestResult {
        let start = Date()
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        let command = item.summary.components(separatedBy: " · ").first ?? item.summary
        guard let probe = primaryExecutableProbe(in: command) else {
            return .failure("no command", durationMs: ms)
        }

        // Shell-wrapped hooks (`[ -z "$x" ] && something`, `if ...; then`,
        // inline sh -c pipelines, etc.) can't be statically resolved to a
        // single binary. Don't falsely fail them — treat the hook as ok
        // and let the actual agent runtime decide at invoke time.
        if Self.isShellConstruct(probe) {
            return IntegrationTestResult(success: true,
                                         message: "shell-wrapped: \(probe)",
                                         durationMs: ms,
                                         capabilities: [],
                                         logPath: nil)
        }

        let resolved: URL? = {
            if probe.hasPrefix("/") {
                return URL(fileURLWithPath: probe)
            }
            return CLIDiscovery.findBinary(name: probe,
                                           in: CLIDiscovery.pathDirectories())
        }()
        guard let url = resolved, FileManager.default.isExecutableFile(atPath: url.path) else {
            return .failure("not executable: \(probe)", durationMs: ms)
        }
        return IntegrationTestResult(success: true,
                                     message: "executable: \(url.path)",
                                     durationMs: ms,
                                     capabilities: [],
                                     logPath: nil)
    }

    private static let shellConstructs: Set<String> = [
        "[", "[[", "{", "(", "if", "case", "for", "while", "until", "function",
        "then", "do", "done", "fi", "esac", "true", "false",
        "cd", "pwd", "echo", "printf", "test", "export", "source", ".",
        "eval", "exec", "read", "shift", "set", "unset", "trap", "return",
        "alias", "local", "declare", "typeset", "readonly",
    ]

    private static func isShellConstruct(_ probe: String) -> Bool {
        shellConstructs.contains(probe)
    }

    private func primaryExecutableProbe(in command: String) -> String? {
        let primary = command
            .components(separatedBy: "||").first?
            .components(separatedBy: "&&").last?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? command
        if primary.isEmpty { return nil }

        let absolutePattern = #"/[^\s\"']+"#
        if let regex = try? NSRegularExpression(pattern: absolutePattern),
           let match = regex.firstMatch(in: primary,
                                        range: NSRange(location: 0, length: (primary as NSString).length)) {
            return (primary as NSString).substring(with: match.range)
        }

        let token = primary
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            .components(separatedBy: .whitespacesAndNewlines)
            .first?
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        guard let token, !token.isEmpty, token != "[" else { return nil }
        return token
    }
}
