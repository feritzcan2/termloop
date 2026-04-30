// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Shared state for the doc editor overlay. When a markdown file is
/// selected (e.g. an ability `SKILL.md` or a Context Bank doc) the
/// terminal area is replaced with the editable markdown editor.
@MainActor
final class DocEditorStore: ObservableObject {
    static let shared = DocEditorStore()

    @Published private(set) var selectedFileURL: URL?
    @Published private(set) var folderName: String = ""
    @Published private(set) var displayTitle: String = ""
    @Published var showEditor: Bool = false

    /// Convenience for call sites that previously read a path string.
    var selectedFilePath: String? { selectedFileURL?.path }

    private init() {}

    func select(fileURL: URL, folderName: String, displayTitle: String) {
        self.selectedFileURL = fileURL
        self.folderName = folderName
        self.displayTitle = displayTitle
        showEditor = true
    }

    /// Convenience wrapper: derive display title from the file name.
    func select(fileURL: URL, folderName: String) {
        let name = fileURL.lastPathComponent
        let title = (name as NSString).deletingPathExtension
        select(fileURL: fileURL, folderName: folderName, displayTitle: title.isEmpty ? name : title)
    }

    func close() {
        guard showEditor || selectedFileURL != nil else { return }
        showEditor = false
        selectedFileURL = nil
        folderName = ""
        displayTitle = ""
    }
}
