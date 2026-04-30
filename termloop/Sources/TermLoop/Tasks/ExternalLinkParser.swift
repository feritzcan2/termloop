// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

enum ExternalLinkParser {
    static func parse(_ raw: String) -> TermLoopTask.ExternalLink? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let host = url.host else { return nil }

        // Jira cloud: <site>.atlassian.net/browse/<KEY>
        if host.hasSuffix(".atlassian.net") {
            let pathComponents = url.pathComponents
            if let browseIdx = pathComponents.firstIndex(of: "browse"),
               browseIdx + 1 < pathComponents.count {
                return TermLoopTask.ExternalLink(url: url, provider: .jira, ticketKey: pathComponents[browseIdx + 1])
            }
            return TermLoopTask.ExternalLink(url: url, provider: .jira, ticketKey: nil)
        }

        // Linear: linear.app/<team>/issue/<KEY>/<slug>
        if host == "linear.app" {
            let comps = url.pathComponents
            if let issueIdx = comps.firstIndex(of: "issue"),
               issueIdx + 1 < comps.count {
                return TermLoopTask.ExternalLink(url: url, provider: .linear, ticketKey: comps[issueIdx + 1])
            }
            return TermLoopTask.ExternalLink(url: url, provider: .linear, ticketKey: nil)
        }

        // GitHub: github.com/<owner>/<repo>/issues/<num>
        if host == "github.com" {
            let comps = url.pathComponents.dropFirst() // drop leading "/"
            let arr = Array(comps)
            if arr.count >= 4, arr[2] == "issues" {
                let key = "\(arr[0])/\(arr[1])#\(arr[3])"
                return TermLoopTask.ExternalLink(url: url, provider: .github, ticketKey: key)
            }
            return TermLoopTask.ExternalLink(url: url, provider: .github, ticketKey: nil)
        }

        return TermLoopTask.ExternalLink(url: url, provider: .other, ticketKey: nil)
    }
}
