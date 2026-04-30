// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// TermLoop-local shell-quoting helpers. Kept separate from upstream's
/// several copies so our code doesn't reach across the fork boundary and
/// so the escape rule is controlled here.
enum TermLoopShell {
    /// POSIX-safe single-quote quoting. Wraps `value` in single quotes and
    /// escapes embedded single quotes as `'\''`.
    static func quoteSingle(_ value: String) -> String {
        let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
        return "'\(escaped)'"
    }

    /// Whitelist check for identifiers that get spliced UNQUOTED into shell
    /// commands — e.g. `claude --resume <sessionId>`. Rejects every shell
    /// metacharacter (quotes, `;`, `|`, `&`, `$`, backtick, whitespace,
    /// newlines, …) so a malicious socket caller or a tampered sidecar
    /// can't inject commands through an id. UUIDs and claude's
    /// `sess-<hex>` format both pass.
    static func isSafeUnquotedIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 128 else { return false }
        for scalar in value.unicodeScalars {
            let c = Character(scalar)
            if c.isLetter || c.isNumber || c == "-" || c == "_" { continue }
            return false
        }
        return true
    }

    /// Recomposes a fully-quoted shell command for display/inspection.
    /// Expects `args` to already be the final spawn-ready argv.
    static func composeCommand(
        executable: String,
        args: [String],
        env: [String: String],
        cwd: String?
    ) -> String {
        var segments: [String] = env
            .sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\(quoteSingle($0.value))" }
        segments.append(executable)
        segments.append(contentsOf: args.map(quoteSingle))
        let command = segments.joined(separator: " ")
        if let cwd, !cwd.isEmpty {
            return "cd \(quoteSingle(cwd)) && " + command
        }
        return command
    }
}
