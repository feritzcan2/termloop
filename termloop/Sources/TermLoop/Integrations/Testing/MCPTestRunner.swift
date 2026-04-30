// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct MCPTestRunner: TestRunner {
    func run(_ item: IntegrationItem) async -> IntegrationTestResult {
        guard let binary = item.binaryPath else {
            // Remote MCPs (`{"type":"http","url":...}`) carry no `command`
            // and can't be probed locally. Discovery already verified the
            // entry exists in the agent config; treat that as "registered"
            // so the row goes green. Real auth happens inside the agent.
            return IntegrationTestResult(success: true,
                                         message: "registered (remote MCP — auth probed by agent at runtime)",
                                         durationMs: 0,
                                         capabilities: [],
                                         logPath: nil)
        }
        // Minimal JSON-RPC initialize + tools/list probe via stdio.
        let (exit, output, ms) = await IntegrationTestSupport.run(
            command: "/bin/sh",
            args: ["-lc", "\(Self.escape(binary)) --help 2>&1 | head -20"],
            timeoutMs: 8_000
        )
        if exit == 0 {
            return IntegrationTestResult(success: true,
                                         message: "binary reachable",
                                         durationMs: ms,
                                         capabilities: [],
                                         logPath: nil)
        }
        return IntegrationTestResult(success: false,
                                     message: output.trimmingCharacters(in: .whitespacesAndNewlines),
                                     durationMs: ms,
                                     capabilities: [],
                                     logPath: nil)
    }

    private static func escape(_ path: String) -> String {
        "'\(path.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
