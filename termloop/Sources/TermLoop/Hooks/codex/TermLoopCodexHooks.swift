// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import os

/// Global Codex `~/.codex/config.toml` management.
///
/// `ensureGlobalCodexConfigInstalled()` idempotently writes
/// `codex_hooks = true` plus a canonical `[mcp_servers.termloop]` section
/// wrapped in `# TermLoop-managed: BEGIN/END` markers. Per-workspace
/// hooks.json writing has been removed — user-scope `~/.codex/hooks.json`
/// is the single source of truth now, owned by `ClaudeHookInstaller`'s
/// sibling in the CLI (`termloop codex install-hooks`).
enum TermLoopCodexHooks {
    private static let logger = Logger(subsystem: "com.termloop.fork", category: "codex-hooks")
    private static let managedBlockBegin = "# TermLoop-managed: BEGIN"
    private static let managedBlockEnd   = "# TermLoop-managed: END"

    static func ensureGlobalCodexConfigInstalled() {
        do {
            try ensureFeatureFlagAndBuiltInMCP()
        } catch {
            logger.warning("codex config: failed to install built-in MCP (\(error.localizedDescription, privacy: .public))")
        }
    }

    // MARK: - config.toml feature flag

    /// Ensures `[features] codex_hooks = true` is present in `~/.codex/config.toml`.
    /// Idempotent. Preserves any other content in the file (other sections,
    /// other keys under `[features]`, comments). Does NOT parse TOML — just
    /// scans for the section header and the exact key line.
    /// Test seam: lets tests redirect the global `~/.codex/config.toml`
    /// write to a temp directory so test runs don't mutate the developer's
    /// real codex config. Production code never reads this.
    static var configHomeOverride: String?

    private static func ensureFeatureFlagAndBuiltInMCP() throws {
        let fm = FileManager.default
        let home = configHomeOverride ?? NSHomeDirectory()
        let codexDir = "\(home)/.codex"
        let configPath = "\(codexDir)/config.toml"

        try fm.createDirectory(atPath: codexDir, withIntermediateDirectories: true)

        let original = (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""
        let updated = upsertManagedMCPBlock(upsertFeatureFlag(original))
        guard updated != original else { return }

        try updated.write(
            toFile: configPath,
            atomically: true,
            encoding: .utf8
        )
    }

    /// Ensures `codex_hooks = true` is a top-level TOML key.
    ///
    /// Prepended to the top of the file (not EOF) because TOML section scope
    /// continues until the next `[header]`, so an EOF append would place the
    /// key under whatever section the file ends with (e.g. `[mcp_servers.x]`)
    /// rather than at the root table.
    static func upsertFeatureFlag(_ content: String) -> String {
        if content.range(of: #"(?m)^codex_hooks\s*=\s*true\b"#, options: .regularExpression) != nil {
            return content
        }
        let separator = content.isEmpty ? "" : (content.hasPrefix("\n") ? "" : "\n")
        return "codex_hooks = true\n\(separator)\(content)"
    }

    /// Upserts the canonical `[mcp_servers.termloop]` block wrapped in
    /// `# TermLoop-managed: BEGIN/END` markers. Any unmarked
    /// `[mcp_servers.termloop]` section is stripped — even when a managed
    /// block already exists — so the file never has a duplicate key that
    /// Codex's TOML parser would reject.
    static func upsertManagedMCPBlock(_ content: String) -> String {
        var updated = stripUnmarkedTermLoopSections(content)
        let canonical = canonicalMCPBlock()
        if let managedRange = managedBlockRange(in: updated) {
            updated.replaceSubrange(managedRange, with: canonical)
            return updated
        }
        let prefix = updated.isEmpty || updated.hasSuffix("\n") ? "" : "\n"
        return updated + "\(prefix)\n\(canonical)"
    }

    /// Removes every `[mcp_servers.termloop]` section that is NOT inside a
    /// managed block. Repeats the scan after each strip so indices stay valid.
    private static func stripUnmarkedTermLoopSections(_ content: String) -> String {
        var updated = content
        while let section = nextUnmarkedTermLoopSection(in: updated) {
            updated.removeSubrange(section)
        }
        return updated
    }

    private static func nextUnmarkedTermLoopSection(in content: String) -> Range<String.Index>? {
        let managed = managedBlockRange(in: content)
        var searchStart = content.startIndex
        while searchStart < content.endIndex {
            guard let header = content.range(of: "[mcp_servers.termloop]", range: searchStart..<content.endIndex) else {
                return nil
            }
            // Skip the header inside the managed block — that's our canonical.
            if let managed, managed.contains(header.lowerBound) {
                searchStart = managed.upperBound
                continue
            }
            let afterHeader = header.upperBound
            let nextSection = content.range(
                of: #"(?m)^\[[^\]]+\]"#,
                options: .regularExpression,
                range: afterHeader..<content.endIndex
            )?.lowerBound ?? content.endIndex
            return header.lowerBound..<nextSection
        }
        return nil
    }

    private static func canonicalMCPBlock() -> String {
        // `/bin/sh` matches the historical pre-refactor form so older
        // TermLoop builds running alongside this one don't detect our
        // block as "missing" and append a duplicate section.
        """
        \(managedBlockBegin)
        [mcp_servers.termloop]
        command = "/bin/sh"
        args = ["-lc", "exec \\"${TERMLOOP_BUNDLED_CLI_PATH:-$(command -v termloop)}\\" termloop-mcp"]
        \(managedBlockEnd)

        """
    }

    private static func managedBlockRange(in content: String) -> Range<String.Index>? {
        guard let beginRange = content.range(of: managedBlockBegin),
              let endRange = content.range(of: managedBlockEnd, range: beginRange.upperBound..<content.endIndex)
        else { return nil }
        // Extend to include trailing newline of the END marker if present.
        var end = endRange.upperBound
        if end < content.endIndex, content[end] == "\n" {
            end = content.index(after: end)
        }
        return beginRange.lowerBound..<end
    }

    #if DEBUG
    /// Test-only pure transform equivalent to the disk write path.
    internal static func applyToTomlContentForTesting(_ content: String) -> String {
        upsertManagedMCPBlock(upsertFeatureFlag(content))
    }
    #endif
}
