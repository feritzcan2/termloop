// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Bundled meta-prompt used when the user asks an AI agent to create or refine
/// a project-local ability bundle. The authoritative prompt body lives in the
/// source-controlled markdown file under `Templates/` next to this file.
enum AbilityPrompts {
    static let creator: String = ProjectInstructionStore.loadBundledMarkdown(named: "prompt-ability-creator.md")
}
