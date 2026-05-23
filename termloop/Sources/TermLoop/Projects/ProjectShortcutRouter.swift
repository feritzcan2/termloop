// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
enum ProjectShortcutRouter {
    /// Maps numbered project shortcuts to a zero-based project index.
    /// 1...8 target fixed indices; 9 always targets the last project.
    static func projectIndex(forDigit digit: Int, projectCount: Int) -> Int? {
        guard projectCount > 0 else { return nil }
        guard (1...9).contains(digit) else { return nil }

        if digit == 9 {
            return projectCount - 1
        }

        let index = digit - 1
        return index < projectCount ? index : nil
    }

    @discardableResult
    static func selectProject(forDigit digit: Int, tabManager: TabManager?) -> Bool {
        let store = ProjectStore.shared
        guard let targetIndex = projectIndex(forDigit: digit, projectCount: store.projects.count) else {
            return false
        }

        let project = store.projects[targetIndex]
        do {
            try store.setActive(id: project.id)
        } catch {
            ProjectStore.presentError(error)
            return true
        }

        selectFirstWorkspace(forProjectId: project.id, tabManager: tabManager)
        return true
    }

    private static func selectFirstWorkspace(forProjectId projectId: UUID, tabManager: TabManager?) {
        guard let tabManager else { return }
        if let current = tabManager.selectedTabId,
           let tab = tabManager.tabs.first(where: { $0.id == current }),
           tab.projectId == projectId {
            return
        }
        if let first = tabManager.tabs.first(where: { $0.projectId == projectId }) {
            tabManager.selectedTabId = first.id
        }
    }
}
