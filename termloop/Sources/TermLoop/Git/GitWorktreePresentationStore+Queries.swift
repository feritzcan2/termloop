// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

extension GitWorktreePresentationStore {
    func branch(for directory: String) -> String? {
        snapshot(for: directory)?.branch
    }

    func files(for directory: String) -> [SidebarGitChangeItem] {
        snapshot(for: directory)?.files ?? []
    }

    func isDirty(_ directory: String) -> Bool {
        snapshot(for: directory)?.isDirty ?? false
    }
}
