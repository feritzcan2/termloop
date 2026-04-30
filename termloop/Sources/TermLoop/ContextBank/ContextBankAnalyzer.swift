// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

/// Validates a curator-supplied suggestion payload (from the
/// `context_bank_propose_suggestion` MCP tool) into a typed
/// `ContextBankSuggestion`. The previous JSON-in-text parser (with
/// `ParseOutcome` + brace-matching `extractSuggestionsObject`) is gone —
/// the curator now invokes the tool directly, the MCP server hands a
/// structured dictionary to the socket dispatcher, and that dispatcher
/// calls this one validator. Action-specific shape checks (`.add`
/// requires `add_text`, `.replace` requires both, `.move` requires
/// `from_path`) live here so they stay testable in isolation.
enum ContextBankAnalyzer {
    static func suggestion(
        from item: [String: Any],
        sessionId: String
    ) -> ContextBankSuggestion? {
        guard let actionRaw = item["action"] as? String,
              let action = ContextBankSuggestion.Action(rawValue: actionRaw),
              let targetPath = item["target_path"] as? String,
              let reasoning = item["reasoning"] as? String
        else { return nil }

        let addText = item["add_text"] as? String
        let replaceOld = item["replace_old_text"] as? String
        let fromPath = item["from_path"] as? String
        let quote = item["source_quote"] as? String
        let confidence = (item["confidence"] as? Double)
            ?? Double(item["confidence"] as? Int ?? 0)
        // Mirror paths only apply to `.add`. Drop self-references and dedup
        // so the applier doesn't double-write to the primary target.
        let rawMirrors = (item["mirror_paths"] as? [String]) ?? []
        let mirrorPaths: [String] = {
            guard action == .add else { return [] }
            var seen = Set<String>([targetPath])
            var ordered: [String] = []
            for p in rawMirrors where !p.isEmpty && !seen.contains(p) {
                seen.insert(p)
                ordered.append(p)
            }
            return ordered
        }()

        switch action {
        case .add where addText == nil:
            return nil
        case .replace where addText == nil || replaceOld == nil:
            return nil
        case .move where fromPath == nil:
            return nil
        default:
            break
        }

        return ContextBankSuggestion(
            sourceSessionId: sessionId,
            action: action,
            targetPath: targetPath,
            mirrorPaths: mirrorPaths,
            fromPath: fromPath,
            addText: addText,
            replaceOldText: replaceOld,
            reasoning: reasoning,
            sourceQuote: quote,
            confidence: max(0, min(1, confidence))
        )
    }
}
