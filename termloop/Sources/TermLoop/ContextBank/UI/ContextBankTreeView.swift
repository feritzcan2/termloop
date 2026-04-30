// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

struct ContextBankTreeView: View {
    let files: [ContextBankFile]
    let tree: [ContextBankTreeNode]
    @Binding var selection: ContextBankSelection
    var onOpen: (ContextBankFile) -> Void = { _ in }

    @State private var collapsedFolderIds: Set<String> = []

    var body: some View {
        let visibleRows = ContextBankTreeBuilder.flatten(tree, collapsedIds: collapsedFolderIds)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 1) {
                if files.isEmpty && tree.isEmpty {
                    Text(String(
                        localized: "contextBank.tree.empty",
                        defaultValue: "No CLAUDE.md or AGENTS.md files found.",
                        table: "TermLoop"
                    ))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
                    .padding(.top, 14)
                } else {
                    ForEach(visibleRows) { node in
                        row(for: node)
                    }
                }
            }
            .padding(.vertical, 6)
        }
        .background(Color(NSColor.textBackgroundColor).opacity(0.25))
    }

    @ViewBuilder
    private func row(for node: ContextBankTreeNode) -> some View {
        switch node {
        case .folder(let id, let label, let depth, _):
            FolderRow(
                id: id,
                label: label,
                depth: depth,
                isCollapsed: collapsedFolderIds.contains(id),
                toggle: { toggle(id: id) }
            )
        case .file(let file, let depth, let hasProposals):
            FileRow(
                file: file,
                depth: depth,
                hasProposals: hasProposals,
                isSelected: selection == .file(file.url),
                onSelect: {
                    let canonical = resolveCanonical(file)
                    selection = .file(canonical.url)
                },
                onOpen: { onOpen(resolveCanonical(file)) }
            )
        case .newFile(let path, let depth):
            NewFileRow(
                path: path,
                depth: depth,
                isSelected: false  // selecting the parent virtual row is a no-op; the child suggestion is the actionable item
            )
        case .suggestion(let suggestion, let depth):
            SuggestionRow(
                suggestion: suggestion,
                depth: depth,
                isSelected: selection == .suggestion(suggestion.id),
                onSelect: { selection = .suggestion(suggestion.id) }
            )
        }
    }

    private func toggle(id: String) {
        if collapsedFolderIds.contains(id) {
            collapsedFolderIds.remove(id)
        } else {
            collapsedFolderIds.insert(id)
        }
    }

    /// If the user clicks a symlinked row, redirect to the canonical file
    /// so the editor they open is the real source of truth. Falls back to
    /// the tapped file when the target is missing from the index (e.g. the
    /// link points outside the scanned project root).
    private func resolveCanonical(_ file: ContextBankFile) -> ContextBankFile {
        guard file.isSymlink, let target = file.symlinkTargetName else { return file }
        let targetURL = file.url
            .deletingLastPathComponent()
            .appendingPathComponent(target)
            .standardizedFileURL
        if let match = files.first(where: { $0.url.standardizedFileURL == targetURL }) {
            return match
        }
        return file
    }
}

private struct FolderRow: View {
    let id: String
    let label: String
    let depth: Int
    let isCollapsed: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 4) {
                Color.clear.frame(width: indent(depth))
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: "folder")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundStyle(.secondary)
                Text(displayLabel)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var displayLabel: String {
        depth == 0 && label.isEmpty ? "/" : label
    }
}

private struct FileRow: View {
    let file: ContextBankFile
    let depth: Int
    let hasProposals: Bool
    let isSelected: Bool
    let onSelect: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onSelect) {
                HStack(spacing: 4) {
                    Color.clear.frame(width: indent(depth))
                    Color.clear.frame(width: 10)
                    Image(systemName: iconName(for: file.kind))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(file.kind.displayName)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(file.isSymlink ? .secondary : .primary)
                    if file.isSymlink {
                        Image(systemName: "link")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Color.accentColor.opacity(0.8))
                        if let target = file.symlinkTargetName {
                            Text("→ \(target)")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    if hasProposals {
                        Image(systemName: "sparkles")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .help(String(
                                localized: "contextBank.tree.fileHasProposals",
                                defaultValue: "This file has pending suggestions",
                                table: "TermLoop"
                            ))
                    }
                    Spacer(minLength: 6)
                    if !file.isSymlink {
                        Text(file.capacityLabel)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(file.isOverLimit ? Color.red : Color.secondary.opacity(0.7))
                        capacityBar
                            .frame(width: 36, height: 3)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    Rectangle()
                        .fill(isSelected ? Color.primary.opacity(0.10) : Color.clear)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onOpen) {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .help(String(localized: "contextBank.tree.openInEditor",
                         defaultValue: "Open in external editor",
                         table: "TermLoop"))
        }
        .contextMenu {
            Button(String(
                localized: "contextBank.tree.menu.copyPath",
                defaultValue: "Copy Path",
                table: "TermLoop"
            )) {
                copyString(file.url.path)
            }
            Button(String(
                localized: "contextBank.tree.menu.copyRelativePath",
                defaultValue: "Copy Relative Path",
                table: "TermLoop"
            )) {
                copyString(file.relativePath)
            }
            if file.isSymlink, let target = file.symlinkTargetName {
                Button(String(
                    localized: "contextBank.tree.menu.copySymlinkTarget",
                    defaultValue: "Copy Symlink Target",
                    table: "TermLoop"
                )) {
                    copyString(target)
                }
            }
            Divider()
            Button(String(
                localized: "contextBank.tree.menu.revealInFinder",
                defaultValue: "Reveal in Finder",
                table: "TermLoop"
            )) {
                NSWorkspace.shared.activateFileViewerSelecting([file.url])
            }
            Button(String(
                localized: "contextBank.tree.menu.openInEditor",
                defaultValue: "Open in External Editor",
                table: "TermLoop"
            )) {
                onOpen()
            }
        }
    }

    private func copyString(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    private var capacityBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(Color.primary.opacity(0.08))
                    .frame(height: 3)
                Rectangle()
                    .fill(barColor)
                    .frame(
                        width: min(geo.size.width, geo.size.width * min(file.fillRatio, 1.0)),
                        height: 3
                    )
            }
        }
    }

    private var barColor: Color {
        if file.isOverLimit { return .red }
        if file.fillRatio > 0.85 { return .orange }
        return .accentColor
    }
}

/// Virtual leaf for a curator `add` proposal whose `target_path` does not
/// exist on disk yet. Visually distinct (green tint, `+` icon) so the
/// user immediately sees "this would create a new file." Not selectable
/// itself — clicking the suggestion child is the actionable path.
private struct NewFileRow: View {
    let path: String
    let depth: Int
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Color.clear.frame(width: indent(depth))
            Color.clear.frame(width: 10)
            Image(systemName: "doc.badge.plus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.green)
            Text((path as NSString).lastPathComponent)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.green)
            Text("(new)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(.tertiary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(path)
    }
}

/// Inline child of a `file` or `newFile` row: the curator's proposed
/// entry. Tapping selects it; the right pane shows the diff + reasoning
/// + Accept / Reject. Action symbol (`⊕`/`≈`/`↗`) communicates kind.
private struct SuggestionRow: View {
    let suggestion: ContextBankSuggestion
    let depth: Int
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 4) {
                Color.clear.frame(width: indent(depth))
                Color.clear.frame(width: 10)
                Text(actionGlyph)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(actionColor)
                    .frame(width: 12)
                Text(headline)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                Text("\(Int(suggestion.confidence * 100))%")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Rectangle()
                    .fill(isSelected ? Color.accentColor.opacity(0.18) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var actionGlyph: String {
        switch suggestion.action {
        case .add: return "⊕"
        case .replace: return "≈"
        case .move: return "↗"
        }
    }

    private var actionColor: Color {
        switch suggestion.action {
        case .add: return .green
        case .replace: return .orange
        case .move: return .blue
        }
    }

    /// Pulls the first non-empty line out of `add_text` (or the reasoning
    /// when there is no add_text — `move` action without explicit text).
    /// Stripped of leading `#` so a "## Heading" surfaces as "Heading".
    private var headline: String {
        let raw = suggestion.addText ?? suggestion.reasoning
        let firstLine = raw
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? ""
        return firstLine
            .trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .trimmingCharacters(in: .whitespaces)
    }
}

private func indent(_ depth: Int) -> CGFloat {
    CGFloat(depth) * 12
}

private func iconName(for kind: ContextBankFile.Kind) -> String {
    switch kind {
    case .claude: return "doc.text"
    case .agents: return "doc.badge.gearshape"
    case .gemini: return "sparkle"
    }
}
