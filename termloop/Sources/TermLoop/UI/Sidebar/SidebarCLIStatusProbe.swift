// Copyright (c) 2026-present Ferit özcan. All rights reserved.
// Part of TermLoop — GPL-3.0-or-later

import Foundation
import SwiftUI

/// Lightweight "is this CLI on PATH?" check for sidebar host status.
///
/// Only does a `FileManager.isExecutableFile` lookup against well-known
/// candidates plus the `GitExecutableResolver` PATH walk. No subprocess —
/// safe to call from SwiftUI body and main actor without freezing the UI.
@MainActor
final class SidebarCLIStatusProbe: ObservableObject {
    static let shared = SidebarCLIStatusProbe()

    enum Tool: String, CaseIterable, Identifiable {
        case git
        case gh
        case az
        case glab

        var id: String { rawValue }

        var displayName: String { rawValue }

        var fullName: String {
            switch self {
            case .git: return "git"
            case .gh: return "GitHub CLI"
            case .az: return "Azure CLI"
            case .glab: return "GitLab CLI"
            }
        }

        var candidates: [String] {
            switch self {
            case .git:
                return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "git"]
            case .gh:
                return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]
            case .az:
                return ["/opt/homebrew/bin/az", "/usr/local/bin/az", "az"]
            case .glab:
                return ["/opt/homebrew/bin/glab", "/usr/local/bin/glab", "glab"]
            }
        }
    }

    struct Status: Equatable {
        let tool: Tool
        let isAvailable: Bool
        let resolvedPath: String?
    }

    @Published private(set) var statuses: [Tool: Status] = [:]
    private var lastFetched: Date?
    private let ttl: TimeInterval = 60

    private init() {
        refreshIfStale()
    }

    func status(_ tool: Tool) -> Status {
        statuses[tool] ?? Status(tool: tool, isAvailable: false, resolvedPath: nil)
    }

    func refreshIfStale(force: Bool = false) {
        let now = Date()
        if !force, let last = lastFetched, now.timeIntervalSince(last) < ttl {
            return
        }
        var next: [Tool: Status] = [:]
        for tool in Tool.allCases {
            let path = resolved(for: tool)
            next[tool] = Status(tool: tool, isAvailable: path != nil, resolvedPath: path)
        }
        statuses = next
        lastFetched = now
    }

    private func resolved(for tool: Tool) -> String? {
        let fileManager = FileManager.default
        for candidate in tool.candidates {
            if candidate.hasPrefix("/") {
                if fileManager.isExecutableFile(atPath: candidate) {
                    return candidate
                }
                continue
            }
            if let resolved = lookupOnPath(candidate, fileManager: fileManager) {
                return resolved
            }
        }
        return nil
    }

    private func lookupOnPath(_ executable: String, fileManager: FileManager) -> String? {
        var seen: Set<String> = []
        var directories: [String] = []
        func appendPath(_ raw: String?) {
            guard let raw else { return }
            for component in raw.split(separator: ":").map(String.init) {
                let trimmed = component.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
                directories.append(trimmed)
            }
        }
        appendPath(ProcessInfo.processInfo.environment["PATH"])
        appendPath(getenv("PATH").map { String(cString: $0) })
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].forEach { appendPath($0) }

        for directory in directories {
            let candidate = URL(fileURLWithPath: directory, isDirectory: true)
                .appendingPathComponent(executable)
                .path
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }
}
