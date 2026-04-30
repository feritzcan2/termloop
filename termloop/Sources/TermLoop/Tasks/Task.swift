// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation

struct TermLoopTask: Codable, Identifiable, Hashable {
    let id: UUID
    let projectId: UUID
    var title: String
    var branch: String
    var worktreePath: String
    var status: Status
    var createdAt: Date
    var updatedAt: Date

    var externalLink: ExternalLink?
    var helperAgentId: String?

    var prInfo: PRInfo?
    var mergeState: MergeState
    var lastSyncedAt: Date?
    var lastSyncError: String?

    enum Status: String, Codable { case idle, active, done, archived }

    struct ExternalLink: Codable, Hashable {
        var url: URL
        var provider: Provider
        var ticketKey: String?
        enum Provider: String, Codable { case jira, linear, github, other }
    }

    struct PRInfo: Codable, Hashable {
        var url: URL
        var number: Int
        var state: State
        var title: String?
        enum State: String, Codable { case draft, open, merged, closed }
    }

    struct MergeState: Codable, Hashable {
        var mergedInto: [String]
        var aheadBy: Int?
        var behindBy: Int?

        static let empty = MergeState(mergedInto: [], aheadBy: nil, behindBy: nil)
    }
}
