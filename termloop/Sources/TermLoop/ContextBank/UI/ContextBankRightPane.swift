// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Right-hand detail pane of the Context Bank tab. Renders one of three
/// states based on `ContextBankStore.selection`:
/// - `.none` → empty state (instructional copy).
/// - `.file(url)` → shared markdown preview/editor for the selected file.
/// - `.suggestion(id)` → diff preview + reasoning + Accept / Reject.
struct ContextBankRightPane: View {
    @ObservedObject var store: ContextBankStore

    var body: some View {
        Group {
            switch store.selection {
            case .none:
                emptyState
            case .file(let url):
                FileViewer(
                    url: url,
                    onClose: { store.selection = .none }
                )
                .id((url.path as NSString).resolvingSymlinksInPath)
            case .suggestion(let id):
                if let suggestion = store.suggestions.first(where: { $0.id == id && $0.status == .pending }) {
                    SuggestionViewer(
                        suggestion: suggestion,
                        existingContent: existingContent(forTargetPath: suggestion.targetPath),
                        onAccept: { store.accept(suggestion) },
                        onReject: { store.reject(suggestion) }
                    )
                } else {
                    resolvedState
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(NSColor.textBackgroundColor))
    }

    private func existingContent(forTargetPath path: String) -> String? {
        // Resolve symlinks so an AGENTS.md target shows the underlying
        // CLAUDE.md content the user actually edits.
        let resolved = (path as NSString).resolvingSymlinksInPath
        return try? String(contentsOfFile: resolved, encoding: .utf8)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.tertiary)
            Text(String(
                localized: "contextBank.right.empty",
                defaultValue: "Select a file or suggestion from the tree.",
                table: "TermLoop"
            ))
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 24)
    }

    private var resolvedState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 22))
                .foregroundStyle(.tertiary)
            Text(String(
                localized: "contextBank.right.resolved",
                defaultValue: "This suggestion has been resolved.",
                table: "TermLoop"
            ))
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - File viewer

private struct FileViewer: View {
    let url: URL
    let onClose: () -> Void

    @State private var text: AttributedString = AttributedString("")
    @State private var loadError: String?
    @State private var loadedURL: URL?
    @State private var loadedContent: String = ""

    var body: some View {
        MarkdownSurface(
            title: url.lastPathComponent,
            subtitle: url.deletingLastPathComponent().path,
            fileURL: displayURL,
            text: $text,
            mode: .preview,
            allowEdit: true,
            autosaveDebounce: .milliseconds(500),
            onCommit: { save($0) },
            onClose: {
                save(String(text.characters))
                onClose()
            }
        )
        .onAppear(perform: load)
        .onChange(of: url) { _ in load() }
        .onDisappear { save(String(text.characters)) }
        .overlay(alignment: .topTrailing) {
            if let loadError {
                Text(loadError)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.red)
                    .padding(8)
            }
        }
    }

    private var displayURL: URL {
        readableURL ?? url
    }

    private var readableURL: URL? {
        let fm = FileManager.default
        let resolvedPath = (url.path as NSString).resolvingSymlinksInPath
        if fm.fileExists(atPath: resolvedPath) {
            return URL(fileURLWithPath: resolvedPath)
        }
        if fm.fileExists(atPath: url.path) {
            return url
        }
        return nil
    }

    private func load() {
        guard let target = readableURL else {
            loadedURL = nil
            loadedContent = ""
            text = AttributedString("")
            loadError = "Unable to open \(url.path)"
            return
        }
        do {
            let content = try String(contentsOf: target, encoding: .utf8)
            if String(text.characters) != content {
                text = AttributedString(content)
            }
            loadedURL = target
            loadedContent = content
            loadError = nil
        } catch {
            loadedURL = nil
            loadedContent = ""
            text = AttributedString("")
            loadError = "Unable to open \(target.path): \(error.localizedDescription)"
        }
    }

    private func save(_ content: String) {
        guard let target = loadedURL else { return }
        guard loadError == nil else { return }
        guard content != loadedContent else { return }
        do {
            try content.write(to: target, atomically: true, encoding: .utf8)
            loadedContent = content
            loadError = nil
        } catch {
            loadError = "Unable to save \(target.path): \(error.localizedDescription)"
        }
    }
}

// MARK: - Suggestion viewer

private struct SuggestionViewer: View {
    let suggestion: ContextBankSuggestion
    let existingContent: String?
    let onAccept: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    targetSummary
                    diffSection
                    reasoningSection
                    if let quote = suggestion.sourceQuote, !quote.isEmpty {
                        sourceQuoteSection(quote)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            Divider()
            actionBar
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(actionGlyph)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(actionColor))
            Text(actionLabel)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
            if !suggestion.mirrorPaths.isEmpty {
                Text("→ \(suggestion.mirrorPaths.count + 1) FILES")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .overlay(Capsule().stroke(Color.primary.opacity(0.25), lineWidth: 1))
            }
            Spacer()
            Text("CONFIDENCE \(Int(suggestion.confidence * 100))%")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var targetSummary: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(String(
                localized: "contextBank.right.target",
                defaultValue: "TARGET",
                table: "TermLoop"
            ))
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.tertiary)
            ForEach(suggestion.allTargetPaths, id: \.self) { path in
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
            }
            if existingContent == nil {
                Text(String(
                    localized: "contextBank.right.targetNew",
                    defaultValue: "(file does not exist yet — accept will create it)",
                    table: "TermLoop"
                ))
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Color.green)
            }
        }
    }

    @ViewBuilder
    private var diffSection: some View {
        if let oldText = suggestion.replaceOldText, suggestion.action != .add {
            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "contextBank.right.removing",
                    defaultValue: "— REMOVING",
                    table: "TermLoop"
                ))
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(.red)
                Text(oldText)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
                    .background(Color.red.opacity(0.10))
            }
        }
        if let addText = suggestion.addText {
            VStack(alignment: .leading, spacing: 4) {
                Text(String(
                    localized: "contextBank.right.adding",
                    defaultValue: "+ ADDING",
                    table: "TermLoop"
                ))
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .foregroundStyle(.green)
                Text(addText)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(8)
                    .background(Color.green.opacity(0.10))
            }
        }
    }

    private var reasoningSection: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(String(
                localized: "contextBank.right.reasoning",
                defaultValue: "REASONING",
                table: "TermLoop"
            ))
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.tertiary)
            Text(suggestion.reasoning)
                .font(.system(size: 11))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func sourceQuoteSection(_ quote: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(String(
                localized: "contextBank.right.sourceQuote",
                defaultValue: "SOURCE QUOTE",
                table: "TermLoop"
            ))
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(.tertiary)
            Text("\u{201C}\(quote)\u{201D}")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.secondary)
                .italic()
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            Spacer()
            Button(action: onReject) {
                Text(String(
                    localized: "contextBank.right.reject",
                    defaultValue: "Reject",
                    table: "TermLoop"
                ))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(Color.primary.opacity(0.25), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)

            Button(action: onAccept) {
                Text(String(
                    localized: "contextBank.right.accept",
                    defaultValue: "Accept",
                    table: "TermLoop"
                ))
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(Color.accentColor)
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color(NSColor.windowBackgroundColor))
    }

    private var actionGlyph: String {
        switch suggestion.action {
        case .add: return "ADD"
        case .replace: return "REPLACE"
        case .move: return "MOVE"
        }
    }

    private var actionLabel: String {
        switch suggestion.action {
        case .add: return existingContent == nil ? "Create new file" : "Append to file"
        case .replace: return "Replace block"
        case .move: return "Move block"
        }
    }

    private var actionColor: Color {
        switch suggestion.action {
        case .add: return .green
        case .replace: return .orange
        case .move: return .blue
        }
    }
}
