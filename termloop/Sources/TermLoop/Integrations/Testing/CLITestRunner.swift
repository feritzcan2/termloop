// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct CLITestRunner: TestRunner {
    /// Auth-check commands per binary. First match wins; otherwise falls
    /// back to `--version`.
    static let authChecks: [String: (args: [String], parseUser: (String) -> String?)] = [
        "app-insights-logs": (["account", "show", "--query", "user.name", "-o", "tsv"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "wrangler": (["whoami"], { out in
            out.components(separatedBy: "associated with the account")
               .dropFirst().first?.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "gh":       (["auth", "status"], { out in
            out.components(separatedBy: "Logged in to github.com as ")
               .dropFirst().first?
               .components(separatedBy: .whitespacesAndNewlines).first
        }),
        "aws":      (["sts", "get-caller-identity", "--output", "text"], { out in
            out.split(separator: "\t").last.map(String.init)?
               .trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "gcloud":   (["config", "get-value", "account"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "vercel":   (["whoami"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "codex":    (["--version"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "claude":   (["--version"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
        "gemini":   (["--version"], { out in
            out.trimmingCharacters(in: .whitespacesAndNewlines)
        }),
    ]

    func run(_ item: IntegrationItem) async -> IntegrationTestResult {
        guard let binary = item.binaryPath else {
            return .failure("binary not found on PATH")
        }
        let key = item.displayName.lowercased()
        let env = configuredEnv(for: key)
        if key == "app-insights-logs" {
            let (authExit, authOutput, authMs) = await IntegrationTestSupport.run(
                command: binary,
                args: ["account", "show", "--query", "user.name", "-o", "tsv"],
                env: env,
                timeoutMs: 5_000
            )
            let authTrimmed = authOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            guard authExit == 0, !authTrimmed.isEmpty else {
                return IntegrationTestResult(success: false,
                                             message: authTrimmed.isEmpty ? "run `az login` first" : authTrimmed,
                                             durationMs: authMs,
                                             capabilities: [],
                                             logPath: nil)
            }

            let (extExit, extOutput, extMs) = await IntegrationTestSupport.run(
                command: binary,
                args: ["extension", "show", "-n", "application-insights", "--query", "name", "-o", "tsv"],
                env: env,
                timeoutMs: 5_000
            )
            let extTrimmed = extOutput.trimmingCharacters(in: .whitespacesAndNewlines)
            if extExit == 0, extTrimmed == "application-insights" {
                return IntegrationTestResult(success: true,
                                             message: "authenticated as \(authTrimmed)",
                                             durationMs: authMs + extMs,
                                             capabilities: ["az monitor app-insights query"],
                                             logPath: nil)
            }
            return IntegrationTestResult(
                success: false,
                message: "authenticated as \(authTrimmed), but `application-insights` extension is missing",
                durationMs: authMs + extMs,
                capabilities: [],
                logPath: nil
            )
        }
        let (args, parser) = Self.authChecks[key] ?? (["--version"], { $0 })
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: binary, args: args, env: env, timeoutMs: 5_000
        )
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if exit == 0 {
            let subject = parser(output)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let msg = (subject?.isEmpty == false) ? "authenticated as \(subject!)" : "ok"
            return IntegrationTestResult(success: true,
                                         message: msg,
                                         durationMs: ms,
                                         capabilities: [],
                                         logPath: nil)
        }
        return IntegrationTestResult(success: false,
                                     message: trimmed.isEmpty ? "exit \(exit ?? -1)" : trimmed,
                                     durationMs: ms,
                                     capabilities: [],
                                     logPath: nil)
    }

    private func configuredEnv(for key: String) -> [String: String] {
        switch key {
        default:
            return [:]
        }
    }
}
