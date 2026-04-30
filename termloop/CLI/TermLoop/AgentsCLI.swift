// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// `cmux agent ...` subcommand dispatcher. Thin wrapper over the v2 socket —
/// every call delegates to `AgentSocketCommands` via `SocketClient.sendV2`.
enum AgentsCLI {
    /// Run an `agent` subcommand. Returns a process exit status (0 = success,
    /// 1 = socket/error, 2 = usage).
    static func run(
        _ args: [String],
        client: SocketClient,
        jsonOutput: Bool
    ) -> Int32 {
        guard let sub = args.first else {
            printUsage()
            return 2
        }
        let rest = Array(args.dropFirst())
        switch sub {
        case "template":  return template(rest, client: client, jsonOutput: jsonOutput)
        case "help", "-h", "--help":
            printUsage()
            return 0
        default:
            FileHandle.standardError.write(Data("unknown agent subcommand: \(sub)\n".utf8))
            printUsage()
            return 2
        }
    }

    private static func printUsage() {
        let text = """
        Usage: termloop agent <command> [...]
          template list | show <id> | reload
        """
        FileHandle.standardError.write(Data((text + "\n").utf8))
    }

    // MARK: - subcommand handlers

    private static func template(
        _ args: [String],
        client: SocketClient,
        jsonOutput: Bool
    ) -> Int32 {
        guard let sub = args.first else {
            printUsage()
            return 2
        }
        switch sub {
        case "list":
            return call(client: client, method: "agent.template.list", params: [:], jsonOutput: jsonOutput)
        case "show":
            guard let id = args.dropFirst().first, !id.isEmpty else {
                FileHandle.standardError.write(Data("agent template show requires <id>\n".utf8))
                return 2
            }
            return call(client: client, method: "agent.template.get", params: ["id": id], jsonOutput: jsonOutput)
        case "reload":
            return call(client: client, method: "agent.template.reload", params: [:], jsonOutput: jsonOutput)
        default:
            FileHandle.standardError.write(Data("unknown template subcommand: \(sub)\n".utf8))
            return 2
        }
    }

    // MARK: - helpers

    private static func call(
        client: SocketClient,
        method: String,
        params: [String: Any],
        jsonOutput: Bool
    ) -> Int32 {
        do {
            let payload = try client.sendV2(method: method, params: params)
            render(payload)
            return 0
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            return 1
        }
    }

    private static func render(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload) else {
            print("{}")
            return
        }
        let opts: JSONSerialization.WritingOptions = [.prettyPrinted, .sortedKeys]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: opts),
              let s = String(data: data, encoding: .utf8) else {
            print("{}")
            return
        }
        print(s)
    }
}
