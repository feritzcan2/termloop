// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Legacy placeholder kept only because the Xcode project still references
/// this path. Worktree context is now injected directly via
/// `WorktreeContextBlock`; there is no separate worktree ability.
@available(*, unavailable, message: "Worktree context is injected by WorktreeContextBlock — no replacement store.")
enum WorktreeRulesStore {}
