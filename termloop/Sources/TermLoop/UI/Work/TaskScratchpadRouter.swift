// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import SwiftUI

/// Invisible SwiftUI subscriber that forwards
/// `Notification.Name.termLoopOpenFileInMainPanel` payloads into the
/// shared `ScratchpadStore`, which drives the main-panel markdown editor
/// overlay (same mechanism used by folder docs and PlanTab).
///
/// Mount this once somewhere that is alive whenever the Tasks sub-tab is
/// visible. It renders as a zero-sized `Color.clear` so it has no layout
/// impact.
struct TaskScratchpadRouter: View {
    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .allowsHitTesting(false)
            .onReceive(
                NotificationCenter.default.publisher(
                    for: .termLoopOpenFileInMainPanel
                )
            ) { note in
                guard let url = note.userInfo?["path"] as? URL else { return }
                // Ensure parent dir + file exist so the editor has something
                // to open even on first click. Write an empty file if missing.
                ensureFileExists(at: url)
                let folderName = url.deletingLastPathComponent().lastPathComponent
                DocEditorStore.shared.select(fileURL: url, folderName: folderName)
            }
    }

    private func ensureFileExists(at url: URL) {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: Data(), attributes: nil)
        }
    }
}
