// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

@MainActor
final class TaskHelperAgentBridge {
    static let shared = TaskHelperAgentBridge()

    private init() {}

    // MARK: - v1 stubs.

    func onTaskCreated(_ task: TermLoopTask) {
        // v1: no-op.
    }

    func onStatusChanged(taskId: UUID, from: TermLoopTask.Status, to: TermLoopTask.Status) {
        // v1: no-op.
    }

    func runNow(taskId: UUID) {
        // v1: no-op. UI button disabled.
    }
}
