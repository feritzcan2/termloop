import SwiftUI

struct WatchTask: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let projectId: String
    let projectName: String?
    let branch: String?
    let hasWorktree: Bool
}

struct TasksResponse: Codable {
    let tasks: [WatchTask]
}

struct TaskAgentResponse: Codable {
    let sessionId: String
    let name: String?
}

private struct UnifiedWatchTask: Identifiable {
    let connectionId: String
    let connectionName: String
    let task: WatchTask

    var id: String { "\(connectionId):\(task.id)" }
}

// Open tasks with a one-tap agent start. The gateway resolves the
// inspected launch manifest (preview → ticket → launch); the watch only
// triggers it.
struct TasksView: View {
    @ObservedObject private var appState = AppState.shared

    @State private var tasks: [UnifiedWatchTask] = []
    @State private var status = "Yükleniyor…"
    @State private var startingTaskId: String?
    @State private var startedTaskIds: Set<String> = []

    var body: some View {
        List {
            if tasks.isEmpty {
                EmptyStateView(
                    icon: "checklist",
                    text: appState.hasConnections ? status : "iPhone'da TermLoop'u aç"
                )
            }
            ForEach(tasks) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.task.title)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(2)
                    Text("\(item.connectionName) · \(item.task.projectName ?? "Proje")")
                        .font(.mono(10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Button {
                        Task { await start(item) }
                    } label: {
                        if startedTaskIds.contains(item.id) {
                            Label("Başlatıldı", systemImage: "checkmark.circle.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.phosphor)
                        } else if startingTaskId == item.id {
                            Label("Başlatılıyor…", systemImage: "hourglass")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.secondary)
                        } else {
                            Label("Claude başlat", systemImage: "play.fill")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.stew)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                    .disabled(startingTaskId != nil || startedTaskIds.contains(item.id))
                }
                .cardRow()
            }
        }
        .navigationTitle("❯ tasks")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        let connections = appState.connections
        tasks = await withTaskGroup(of: [UnifiedWatchTask].self) { group in
            for connection in connections {
                group.addTask {
                    guard let credential = CredentialStore.credential(id: connection.id),
                          let response = try? await GatewayAPI.fetch(
                            TasksResponse.self,
                            credential: credential,
                            path: "/watch/tasks"
                          )
                    else { return [] }
                    return response.tasks.map {
                        UnifiedWatchTask(connectionId: connection.id, connectionName: connection.name, task: $0)
                    }
                }
            }
            var result: [UnifiedWatchTask] = []
            for await items in group { result.append(contentsOf: items) }
            return result.sorted {
                $0.task.title.localizedCaseInsensitiveCompare($1.task.title) == .orderedAscending
            }
        }
        status = tasks.isEmpty ? "Açık task yok" : ""
    }

    private func start(_ item: UnifiedWatchTask) async {
        guard let credential = CredentialStore.credential(id: item.connectionId) else { return }
        startingTaskId = item.id
        defer { startingTaskId = nil }
        let result: TaskAgentResponse? = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/task-agent",
            body: ["taskId": item.task.id]
        )
        if result != nil {
            startedTaskIds.insert(item.id)
            Haptics.delivered()
        } else {
            Haptics.failed()
            status = "Başlatılamadı"
        }
    }
}
