// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import AppKit
import SwiftUI

/// Main-area markdown document host. All chrome (toolbar, Preview/Edit toggle,
/// close, auto-save) is supplied by `MarkdownSurface`; this view only loads
/// and saves the selected file.
struct MarkdownDocumentSurface: View {
    let document: MarkdownDocumentStore.Document
    let onClose: () -> Void

    @State private var text: AttributedString = AttributedString("")

    var body: some View {
        MarkdownSurface(
            title: document.title,
            subtitle: nil,
            fileURL: document.fileURL,
            text: $text,
            mode: document.mode,
            allowEdit: document.allowEdit,
            autosaveDebounce: .milliseconds(500),
            onCommit: { saveToDisk($0) },
            onClose: {
                saveToDisk(String(text.characters))
                onClose()
            }
        )
        .task(id: document.id) { loadFromDisk() }
    }

    private func loadFromDisk() {
        guard let content = try? String(contentsOf: document.fileURL, encoding: .utf8) else { return }
        if String(text.characters) == content { return }
        text = AttributedString(content)
    }

    private func saveToDisk(_ content: String) {
        guard document.allowEdit else { return }
        try? content.write(to: document.fileURL, atomically: true, encoding: .utf8)
    }
}
