// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Shared state for every markdown document opened in the main area. Callers
/// provide document metadata once; the overlay swap renders it through
/// `MarkdownDocumentSurface` regardless of whether it came from Plan,
/// Abilities, Context Bank, or a task scratchpad.
@MainActor
final class MarkdownDocumentStore: ObservableObject {
    static let shared = MarkdownDocumentStore()

    struct Document: Identifiable, Equatable {
        let fileURL: URL
        let folderName: String
        let displayTitle: String
        let mode: MarkdownSurface.Mode
        let allowEdit: Bool

        var id: String { fileURL.standardizedFileURL.path }
        var title: String { folderName + " — " + displayTitle }
    }

    @Published private(set) var document: Document?

    /// Convenience for call sites that previously read a path string.
    var selectedFileURL: URL? { document?.fileURL }
    var selectedFilePath: String? { selectedFileURL?.path }

    private init() {}

    func open(
        fileURL: URL,
        folderName: String,
        displayTitle: String,
        mode: MarkdownSurface.Mode = .preview,
        allowEdit: Bool = true
    ) {
        document = Document(
            fileURL: fileURL,
            folderName: folderName,
            displayTitle: displayTitle,
            mode: mode,
            allowEdit: allowEdit
        )
    }

    /// Convenience wrapper: derive display title from the file name.
    func open(
        fileURL: URL,
        folderName: String,
        mode: MarkdownSurface.Mode = .preview,
        allowEdit: Bool = true
    ) {
        let name = fileURL.lastPathComponent
        let title = (name as NSString).deletingPathExtension
        open(
            fileURL: fileURL,
            folderName: folderName,
            displayTitle: title.isEmpty ? name : title,
            mode: mode,
            allowEdit: allowEdit
        )
    }

    func close() {
        guard document != nil else { return }
        document = nil
    }
}
