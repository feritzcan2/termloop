// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Composed markdown surface: a toolbar with Preview / Edit toggle, Open-in-
/// editor, and Close; below it either `MarkdownRenderer` or `MarkdownEditor`.
/// Used by the full-screen document surfaces so
/// both share the same chrome, typography, and Esc-to-close behavior.
struct MarkdownSurface: View {
    enum Mode { case preview, edit }

    let title: String
    let subtitle: String?
    let fileURL: URL?
    @Binding var text: AttributedString
    let allowEdit: Bool
    var autosaveDebounce: Duration? = .milliseconds(500)
    var onCommit: ((String) -> Void)? = nil
    let onClose: () -> Void

    @State private var mode: Mode

    init(
        title: String,
        subtitle: String?,
        fileURL: URL?,
        text: Binding<AttributedString>,
        mode: Mode,
        allowEdit: Bool,
        autosaveDebounce: Duration? = .milliseconds(500),
        onCommit: ((String) -> Void)? = nil,
        onClose: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.fileURL = fileURL
        self._text = text
        self.allowEdit = allowEdit
        self.autosaveDebounce = autosaveDebounce
        self.onCommit = onCommit
        self.onClose = onClose
        self._mode = State(initialValue: mode)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            content
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                if let subtitle {
                    Text(subtitle)
                        .font(MarkdownTheme.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if allowEdit {
                Picker("", selection: $mode) {
                    Text(String(localized: "markdown.mode.preview",
                                defaultValue: "Preview", table: "TermLoop"))
                        .tag(Mode.preview)
                    Text(String(localized: "markdown.mode.edit",
                                defaultValue: "Edit", table: "TermLoop"))
                        .tag(Mode.edit)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 140)
            }

            if let fileURL {
                Button { NSWorkspace.shared.open(fileURL) } label: {
                    Text(String(localized: "markdown.button.openInEditor",
                                defaultValue: "OPEN IN EDITOR", table: "TermLoop"))
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            Button(action: onClose) {
                HStack(spacing: 4) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                    Text(String(localized: "markdown.button.closeToTerminal",
                                defaultValue: "TERMINAL", table: "TermLoop"))
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.primary.opacity(0.3), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(NSColor.windowBackgroundColor))
    }

    @ViewBuilder
    private var content: some View {
        switch mode {
        case .preview:
            ScrollView {
                MarkdownRenderer(content: String(text.characters))
                    .padding(.horizontal, MarkdownTheme.containerPaddingH)
                    .padding(.vertical, MarkdownTheme.containerPaddingV)
            }
        case .edit:
            MarkdownEditor(
                text: $text,
                autosaveDebounce: autosaveDebounce,
                onCommit: onCommit,
                placeholder: nil
            )
        }
    }
}
