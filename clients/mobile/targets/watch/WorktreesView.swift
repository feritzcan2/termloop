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

struct UnifiedWorktree: Identifiable, Hashable {
    let connectionId: String
    let connectionName: String
    let worktree: WorktreeSummary

    var id: String { "\(connectionId):\(worktree.id)" }
}

struct PatchEntry: Codable {
    let path: String
    let patch: String
}

struct PatchBundleResponse: Codable {
    let files: [PatchEntry]
}

struct GatewayResponseError: LocalizedError {
    let statusCode: Int
    let message: String

    var errorDescription: String? { message }
}

private struct GatewayErrorPayload: Decodable {
    let error: String?
}

enum GatewayAPI {
    // One shared session: per-call URLSession instances are never released by
    // the system until invalidated, which starves the watch's memory budget.
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 45
        return URLSession(configuration: config)
    }()

    static func baseURL(host: String) -> URL? {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: "https://\(trimmed)")
    }

    static func fetch<T: Decodable>(
        _ type: T.Type,
        credential: GatewayCredential,
        path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let request = try authorizedRequest(credential: credential, path: path, query: query)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(type, from: data)
    }

    static func post<Body: Encodable, T: Decodable>(
        credential: GatewayCredential,
        path: String,
        body: Body
    ) async throws -> T {
        var request = try authorizedRequest(credential: credential, path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Raw recorded audio, uploaded as the request body. The Mac daemon owns
    /// provider access, so no OpenAI credential ever reaches the Watch.
    static func postAudio<T: Decodable>(
        credential: GatewayCredential,
        path: String,
        query: [URLQueryItem],
        fileURL: URL
    ) async throws -> T {
        var request = try authorizedRequest(credential: credential, path: path, query: query)
        request.httpMethod = "POST"
        request.setValue("audio/m4a", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 40
        let audio = try Data(contentsOf: fileURL)
        let (data, response) = try await session.upload(for: request, from: audio)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func postBinary<Body: Encodable>(
        credential: GatewayCredential,
        path: String,
        body: Body
    ) async throws -> Data {
        var request = try authorizedRequest(credential: credential, path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard response.statusCode == 200 else {
            let payload = try? JSONDecoder().decode(GatewayErrorPayload.self, from: data)
            throw GatewayResponseError(
                statusCode: response.statusCode,
                message: payload?.error ?? "Mac yanıt vermedi"
            )
        }
    }

    private static func authorizedRequest(
        credential: GatewayCredential,
        path: String,
        query: [URLQueryItem] = []
    ) throws -> URLRequest {
        guard let base = baseURL(host: credential.host),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { throw URLError(.userAuthenticationRequired) }
        components.path = path
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

struct WorktreesView: View {
    @ObservedObject private var appState = AppState.shared
    @Binding var path: NavigationPath

    @State private var worktrees: [UnifiedWorktree] = []
    @State private var status = "Yükleniyor…"

    var body: some View {
        List {
            if worktrees.isEmpty {
                EmptyStateView(
                    icon: "arrow.triangle.branch",
                    text: appState.hasConnections ? status : "iPhone'da TermLoop'u aç"
                )
            }
            ForEach(worktrees) { item in
                NavigationLink(value: item) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.worktree.name)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                        if let branch = item.worktree.branch {
                            HStack(spacing: 3) {
                                Image(systemName: "arrow.triangle.branch")
                                    .font(.system(size: 8))
                                Text(branch).font(.mono(10)).lineLimit(1)
                            }
                            .foregroundStyle(.secondary)
                        }
                        Text("\(item.connectionName) · \(item.worktree.files.count) dosya\(item.worktree.truncated ? " +" : "")")
                            .font(.mono(10))
                            .foregroundStyle(Theme.stew)
                    }
                }
                .cardRow()
            }
        }
        .navigationTitle("❯ diff")
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: appState.pendingWorktree) { _, _ in
            consumePendingWorktree()
        }
        .onChange(of: appState.connections) { _, _ in
            Task { await load() }
        }
    }

    private func load() async {
        let connections = appState.connections
        worktrees = await withTaskGroup(of: [UnifiedWorktree].self) { group in
            for connection in connections {
                group.addTask {
                    guard let credential = CredentialStore.credential(id: connection.id),
                          let response = try? await GatewayAPI.fetch(
                            WorktreesResponse.self,
                            credential: credential,
                            path: "/watch/worktrees"
                          )
                    else { return [] }
                    return response.worktrees.map {
                        UnifiedWorktree(connectionId: connection.id, connectionName: connection.name, worktree: $0)
                    }
                }
            }
            var result: [UnifiedWorktree] = []
            for await items in group { result.append(contentsOf: items) }
            return result
        }
        status = worktrees.isEmpty ? "Değişiklik yok" : ""
        consumePendingWorktree()
    }

    private func consumePendingWorktree() {
        guard let pending = appState.pendingWorktree else { return }
        guard let worktree = worktrees.first(where: { item in
            if let connectionId = pending.connectionId, item.connectionId != connectionId { return false }
            guard let root = item.worktree.path else { return false }
            return pending.cwd == root || pending.cwd.hasPrefix(root + "/")
        }) else { return }
        appState.pendingWorktree = nil
        path = NavigationPath()
        path.append(worktree)
    }
}

struct PagerRoute: Hashable {
    let worktree: UnifiedWorktree
    let index: Int
}

struct FileListView: View {
    let worktree: UnifiedWorktree

    var body: some View {
        List(Array(worktree.worktree.files.enumerated()), id: \.element.id) { index, file in
            NavigationLink(value: PagerRoute(worktree: worktree, index: index)) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.path.split(separator: "/").last.map(String.init) ?? file.path)
                        .font(.mono(13, .semibold))
                        .lineLimit(1)
                    Text(file.path)
                        .font(.mono(9))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    Text("\(file.kind) · \(file.side)")
                        .font(.mono(10))
                        .foregroundStyle(file.side == "untracked" ? Theme.amber : .secondary)
                }
            }
            .cardRow()
        }
        .navigationTitle(worktree.worktree.name)
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
    @State private var status = "Yükleniyor…"

    init(route: PagerRoute) {
        self.route = route
        _selection = State(initialValue: route.index)
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(Array(route.worktree.worktree.files.enumerated()), id: \.offset) { index, file in
                DiffPage(
                    file: file,
                    position: "\(index + 1)/\(route.worktree.worktree.files.count)",
                    lines: patches[file.path].map(DiffLine.parse),
                    status: status
                )
                .tag(index)
            }
        }
        .tabViewStyle(.verticalPage)
        .navigationTitle(route.worktree.worktree.name)
        .task { await loadAll() }
    }

    private func loadAll() async {
        guard patches.isEmpty else { return }
        do {
            guard let credential = CredentialStore.credential(id: route.worktree.connectionId) else {
                status = "Mac bağlantısı bulunamadı"
                return
            }
            let response = try await GatewayAPI.fetch(
                PatchBundleResponse.self,
                credential: credential,
                path: "/watch/patches",
                query: [URLQueryItem(name: "wt", value: route.worktree.worktree.id)]
            )
            patches = Dictionary(response.files.map { ($0.path, $0.patch) }, uniquingKeysWith: { first, _ in first })
            status = "Boş diff"
        } catch {
            status = "TermLoop'a ulaşılamadı"
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
                HStack(spacing: 4) {
                    Text(position)
                        .font(.mono(10, .bold))
                        .foregroundStyle(Theme.stew)
                    Text(file.path)
                        .font(.mono(10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.bottom, 3)
                if let lines, !lines.isEmpty {
                    ForEach(lines) { line in
                        Text(line.text)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(line.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    Text(lines == nil ? status : "Boş diff").foregroundStyle(.secondary)
                }
            }
        }
    }
}
