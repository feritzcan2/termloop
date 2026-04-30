// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Editable markdown doc that replaces the terminal area when a doc is
/// selected. All chrome (toolbar, Preview/Edit toggle, close, auto-save)
/// is supplied by `MarkdownSurface`.
struct DocEditorView: View {
    let fileURL: URL
    let folderName: String
    let displayTitle: String
    let onClose: () -> Void

    @State private var text: AttributedString = AttributedString("")

    var body: some View {
        MarkdownSurface(
            title: folderName + " — " + displayTitle,
            subtitle: nil,
            fileURL: fileURL,
            text: $text,
            mode: .edit,
            allowEdit: true,
            autosaveDebounce: .milliseconds(500),
            onCommit: { saveToDisk($0) },
            onClose: {
                saveToDisk(String(text.characters))
                onClose()
            }
        )
        .task(id: fileURL) { loadFromDisk() }
    }

    private func loadFromDisk() {
        guard let content = try? String(contentsOf: fileURL, encoding: .utf8) else { return }
        if String(text.characters) == content { return }
        text = AttributedString(content)
    }

    private func saveToDisk(_ content: String) {
        try? content.write(to: fileURL, atomically: true, encoding: .utf8)
    }
}
