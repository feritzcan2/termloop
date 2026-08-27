import SwiftUI

struct ChangedFile: Codable, Identifiable, Hashable {
    var id: String { entryId }
    let entryId: String
    let path: String
    let kind: String
    let side: String
}

struct WorktreeSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let branch: String?
    let path: String?
    let truncated: Bool
    let files: [ChangedFile]
}

struct WorktreesResponse: Codable {
    let worktrees: [WorktreeSummary]
}

struct PatchEntry: Codable {
    let path: String
    let patch: String
}

struct PatchBundleResponse: Codable {
    let files: [PatchEntry]
}

enum SpikeAPI {
    // One shared session: per-call URLSession instances are never released by
    // the system until invalidated, which starves the watch's memory budget.
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    static func baseURL(host: String) -> URL? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return URL(string: trimmed)
        }
        return URL(string: "https://\(trimmed)")
    }

    static func fetch<T: Decodable>(_ type: T.Type, path: String, query: [URLQueryItem] = []) async throws -> T {
        let defaults = UserDefaults.standard
        guard let base = baseURL(host: defaults.string(forKey: "host") ?? ""),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw URLError(.badURL) }
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        if let token = defaults.string(forKey: "watchToken"), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.userAuthenticationRequired)
        }
        return try JSONDecoder().decode(type, from: data)
    }
}

struct WorktreesView: View {
    @AppStorage("watchToken") private var watchToken = ""
    @ObservedObject private var appState = AppState.shared

    @State private var worktrees: [WorktreeSummary] = []
    @State private var status = "Loading…"
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if worktrees.isEmpty {
                    Text(watchToken.isEmpty ? "Pair on the Setup page first" : status)
                        .foregroundStyle(.secondary)
                }
                ForEach(worktrees) { worktree in
                    NavigationLink(value: worktree) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(worktree.name).font(.headline).lineLimit(1)
                            if let branch = worktree.branch {
                                Text(branch).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Text("\(worktree.files.count) file(s)\(worktree.truncated ? " +" : "")")
                                .font(.caption2)
                        }
                    }
                }
            }
            .navigationTitle("Changes")
            .navigationDestination(for: WorktreeSummary.self) { FileListView(worktree: $0) }
            .navigationDestination(for: PagerRoute.self) { DiffPagerView(route: $0) }
        }
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: appState.pendingWorktreeCwd) { _, _ in
            consumePendingWorktree()
        }
    }

    private func load() async {
        guard !watchToken.isEmpty else { return }
        do {
            let response = try await SpikeAPI.fetch(WorktreesResponse.self, path: "/watch/worktrees")
            worktrees = response.worktrees
            status = response.worktrees.isEmpty ? "No changes anywhere" : ""
            consumePendingWorktree()
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }

    private func consumePendingWorktree() {
        guard let cwd = appState.pendingWorktreeCwd else { return }
        guard let worktree = worktrees.first(where: { summary in
            guard let root = summary.path else { return false }
            return cwd == root || cwd.hasPrefix(root + "/")
        }) else { return }
        appState.pendingWorktreeCwd = nil
        path = NavigationPath()
        path.append(worktree)
    }
}

struct PagerRoute: Hashable {
    let worktree: WorktreeSummary
    let index: Int
}

struct FileListView: View {
    let worktree: WorktreeSummary

    var body: some View {
        List(Array(worktree.files.enumerated()), id: \.element.id) { index, file in
            NavigationLink(value: PagerRoute(worktree: worktree, index: index)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.path.split(separator: "/").last.map(String.init) ?? file.path)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    Text(file.path).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    Text("\(file.kind) · \(file.side)")
                        .font(.caption2)
                        .foregroundStyle(file.side == "untracked" ? .orange : .secondary)
                }
            }
        }
        .navigationTitle(worktree.name)
    }
}

struct DiffLine: Identifiable {
    let id: Int
    let text: String
    let color: Color

    static func parse(_ patch: String) -> [DiffLine] {
        let allLines = patch.split(separator: "\n", omittingEmptySubsequences: false)
        let cap = 1200
        var mapped = allLines.prefix(cap)
            .enumerated()
            .map { index, raw -> DiffLine in
                let text = String(raw)
                let color: Color
                if text.hasPrefix("+++") || text.hasPrefix("---") { color = .secondary }
                else if text.hasPrefix("+") { color = .green }
                else if text.hasPrefix("-") { color = .red }
                else if text.hasPrefix("@@") { color = .cyan }
                else { color = .primary }
                return DiffLine(id: index, text: text.isEmpty ? " " : text, color: color)
            }
        if allLines.count > cap {
            mapped.append(DiffLine(id: cap, text: "… \(allLines.count - cap) more lines truncated", color: .orange))
        }
        return mapped
    }
}

// One vertical page per changed file: the Digital Crown flips between files,
// finger drag scrolls inside a file's diff. All patches arrive in a single
// /watch/patches request so page flips never wait on the network.
struct DiffPagerView: View {
    let route: PagerRoute

    @State private var selection: Int
    @State private var patches: [String: String] = [:]
    @State private var status = "Loading…"

    init(route: PagerRoute) {
        self.route = route
        _selection = State(initialValue: route.index)
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Array(route.worktree.files.enumerated()), id: \.offset) { index, file in
                DiffPage(
                    file: file,
                    position: "\(index + 1)/\(route.worktree.files.count)",
                    lines: patches[file.path].map(DiffLine.parse),
                    status: status
                )
                .tag(index)
            }
        }
        .tabViewStyle(.verticalPage)
        .navigationTitle(route.worktree.name)
        .task { await loadAll() }
    }

    private func loadAll() async {
        guard patches.isEmpty else { return }
        do {
            let response = try await SpikeAPI.fetch(
                PatchBundleResponse.self,
                path: "/watch/patches",
                query: [URLQueryItem(name: "wt", value: route.worktree.id)]
            )
            patches = Dictionary(response.files.map { ($0.path, $0.patch) }, uniquingKeysWith: { first, _ in first })
            status = "Empty diff"
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }
}

struct DiffPage: View {
    let file: ChangedFile
    let position: String
    let lines: [DiffLine]?
    let status: String

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("\(position) · \(file.path)")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 2)
                if let lines, !lines.isEmpty {
                    ForEach(lines) { line in
                        Text(line.text)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(line.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    Text(lines == nil ? status : "Empty diff").foregroundStyle(.secondary)
                }
            }
        }
    }
}
