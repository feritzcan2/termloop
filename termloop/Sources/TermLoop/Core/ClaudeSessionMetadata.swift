// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// One line of parsed transcript, shared between the in-app preview and the
/// CLI replay subcommand. Tool results and "thinking" events are intentionally
/// dropped from this enum — they are too noisy for preview and replay preface.
enum TranscriptLine: Equatable {
    case user(String)
    case assistant(String)
    case toolCall(name: String, arg: String)
}

/// Metadata extracted from one Claude Code session JSONL file.
struct JSONLMetadata: Equatable {
    let sessionId: String          // filename minus .jsonl
    let path: URL                  // absolute JSONL path
    let cwd: String                // from first event that carries `cwd`
    let mtime: Date                // file modification time
    let title: String              // first user message, truncated to ~80 chars
    let messageCount: Int          // user + assistant count (approximate)
    let lastAssistantSnippet: String  // last assistant message, truncated to ~100 chars
    let lastUserSnippet: String        // last user message, truncated to ~100 chars
    let previewLines: [TranscriptLine]  // last ~15 user/assistant/tool_use events
}
