import SwiftUI

struct WatchReplyBody: Codable {
    let sessionId: String
    let runtimeEpoch: Int
    let text: String
}

struct ReplyResponse: Codable {
    let delivered: Bool
    let transcript: String?
}

enum WatchDestination: Hashable {
    case talk
    case chat
    case tasks
    case changes
    case connections
}

struct UnifiedSession: Identifiable, Hashable {
    let connectionId: String
    let connectionName: String
    let projectName: String
    let session: StatusSession

    var id: String { "\(connectionId):\(session.id)" }
}

private struct ConnectionStatusResult {
    let connectionId: String
    let sessions: [UnifiedSession]
    let reachable: Bool
}

// The Watch's home screen is one merged agent surface. Source Mac and Project
// remain visible context, but selecting them is never required just to see what
// is running or answer an agent.
struct SessionsView: View {
    @ObservedObject private var appState = AppState.shared

    @State private var sessions: [UnifiedSession] = []
    @State private var unreachableConnectionIds: Set<String> = []
    @State private var status = "Yükleniyor…"
    @State private var replyTarget: UnifiedSession?

    var body: some View {
        List {
            NavigationLink(value: WatchDestination.talk) {
                HStack(spacing: 10) {
                    ZStack {
                        Circle().fill(Theme.stew)
                        Image(systemName: "mic.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.black)
                    }
                    .frame(width: 42, height: 42)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sesli mesaj")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Dokun, söyle, gönder")
                            .font(.mono(10))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .cardRow()

            NavigationLink(value: ProjectAgentLauncherRoute()) {
                Label("Agent başlat", systemImage: "plus.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.stew)
            }
            .cardRow()

            if sessions.isEmpty {
                EmptyStateView(
                    icon: appState.hasConnections ? "terminal" : "iphone.radiowaves.left.and.right",
                    text: appState.hasConnections ? status : "iPhone'da TermLoop'u aç"
                )
            } else {
                Section("Aktif · \(sessions.count)") {
                    ForEach(sessions) { item in
                        Button { replyTarget = item } label: {
                            SessionRow(item: item)
                        }
                        .cardRow()
                    }
                }
            }

            if !unreachableConnectionIds.isEmpty {
                Label(
                    "\(unreachableConnectionIds.count) Mac çevrimdışı",
                    systemImage: "wifi.slash"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .cardRow()
            }

            Section("Daha fazla") {
                NavigationLink(value: WatchDestination.chat) {
                    Label("Stew", systemImage: "bubble.left.and.bubble.right")
                }
                NavigationLink(value: WatchDestination.tasks) {
                    Label("Tasklar", systemImage: "checklist")
                }
                NavigationLink(value: WatchDestination.changes) {
                    Label("Değişiklikler", systemImage: "arrow.triangle.branch")
                }
                NavigationLink(value: WatchDestination.connections) {
                    Label("Mac'ler", systemImage: "desktopcomputer")
                }
            }
        }
        .navigationTitle("❯ agents")
        .sheet(item: $replyTarget) { item in
            AgentVoiceReplyView(item: item)
        }
        .task { await run() }
        .refreshable { await load() }
        .onChange(of: appState.connections) { _, _ in Task { await load() } }
    }

    private func run() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private func load() async {
        let connections = appState.connections
        guard !connections.isEmpty else {
            sessions = []
            unreachableConnectionIds = []
            status = "iPhone'da TermLoop'u aç"
            return
        }
        let results = await withTaskGroup(of: ConnectionStatusResult.self) { group in
            for connection in connections {
                group.addTask {
                    guard let credential = CredentialStore.credential(id: connection.id),
                          let response = try? await GatewayAPI.fetch(
                            StatusResponse.self,
                            credential: credential,
                            path: "/watch/status"
                          )
                    else {
                        return ConnectionStatusResult(
                            connectionId: connection.id,
                            sessions: [],
                            reachable: false
                        )
                    }
                    let names = Dictionary(
                        response.projects.map { ($0.id, $0.name) },
                        uniquingKeysWith: { first, _ in first }
                    )
                    return ConnectionStatusResult(
                        connectionId: connection.id,
                        sessions: response.sessions.map {
                            UnifiedSession(
                                connectionId: connection.id,
                                connectionName: connection.name,
                                projectName: names[$0.projectId] ?? "Proje",
                                session: $0
                            )
                        },
                        reachable: true
                    )
                }
            }
            var collected: [ConnectionStatusResult] = []
            for await result in group { collected.append(result) }
            return collected
        }
        sessions = results.flatMap(\.sessions).sorted {
            let left = rank($0.session.status)
            let right = rank($1.session.status)
            if left != right { return left < right }
            if $0.connectionName != $1.connectionName {
                return $0.connectionName.localizedCaseInsensitiveCompare($1.connectionName) == .orderedAscending
            }
            return $0.session.name.localizedCaseInsensitiveCompare($1.session.name) == .orderedAscending
        }
        unreachableConnectionIds = Set(results.filter { !$0.reachable }.map(\.connectionId))
        status = sessions.isEmpty ? "Çalışan agent yok" : ""
    }

    private func rank(_ status: String) -> Int {
        switch status {
        case "awaitingInput": return 0
        case "working": return 1
        default: return 2
        }
    }
}

struct SessionRow: View {
    let item: UnifiedSession

    var body: some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(AgentStatusStyle.color(item.session.status))
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.session.name)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Text("\(item.connectionName) · \(item.projectName)")
                    .font(.mono(10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(AgentStatusStyle.label(item.session.status))
                    .font(.mono(10, .semibold))
                    .foregroundStyle(AgentStatusStyle.color(item.session.status))
            }
        }
    }
}

// Notification landing page for one exact Session. Voice reply remains the
// primary wrist action; the bounded terminal excerpt carried by APNs and the
// matching worktree changes stay available without crowding the reply flow.
struct AgentAttentionView: View {
    let target: PendingAgentAttentionTarget

    @ObservedObject private var appState = AppState.shared
    @State private var item: UnifiedSession?
    @State private var replyPresented = false
    @State private var messagePresented = false

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: 3) {
                Text(item?.session.name ?? target.title)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
                if let item {
                    Text("\(item.connectionName) · \(item.projectName)")
                        .font(.mono(9))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .cardRow()

            Button { replyPresented = true } label: {
                Label("Sesli yanıtla", systemImage: "mic.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .tint(Theme.stew)
            .foregroundStyle(.black)
            .buttonStyle(.borderedProminent)
            .disabled(item == nil)

            Button { messagePresented = true } label: {
                Label("Son mesaj", systemImage: "text.bubble")
            }
            .cardRow()

            Button { openChanges() } label: {
                Label("Changes", systemImage: "arrow.triangle.branch")
            }
            .disabled(target.cwd == nil)
            .cardRow()
        }
        .navigationTitle("❯ attention")
        .task { await loadSession() }
        .sheet(isPresented: $replyPresented) {
            if let item { AgentVoiceReplyView(item: item) }
        }
        .sheet(isPresented: $messagePresented) {
            NavigationStack {
                ScrollView {
                    Text(target.message.isEmpty ? "Son mesaj önizlemesi yok" : target.message)
                        .font(.mono(12))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                }
                .navigationTitle("Son mesaj")
            }
        }
    }

    private func loadSession() async {
        guard let credential = credential else { return }
        let response = try? await GatewayAPI.fetch(
            StatusResponse.self,
            credential: credential,
            path: "/watch/status"
        )
        let session = response?.sessions.first { $0.id == target.sessionId }
            ?? StatusSession(
                id: target.sessionId,
                runtimeEpoch: target.runtimeEpoch,
                name: target.title.isEmpty ? "Agent" : target.title,
                agent: "agent",
                projectId: target.projectId ?? "",
                cwd: target.cwd,
                status: "awaitingInput"
            )
        let projectName = response?.projects.first { $0.id == session.projectId }?.name ?? "Proje"
        item = UnifiedSession(
            connectionId: credential.id,
            connectionName: credential.name,
            projectName: projectName,
            session: session
        )
    }

    private var credential: GatewayCredential? {
        if let connectionId = target.connectionId,
           let credential = CredentialStore.credential(id: connectionId) {
            return credential
        }
        return CredentialStore.preferred()
    }

    private func openChanges() {
        guard let cwd = target.cwd else { return }
        appState.pendingWorktree = PendingWorktreeTarget(
            connectionId: target.connectionId,
            cwd: cwd
        )
    }
}

// Tapping an agent goes straight to speech: the sheet starts listening the
// moment it appears, silence or a tap on the circle sends, and each state —
// listening, sending, sent, failed — is one large glanceable stage. A failed
// send keeps the recording so retry is one tap, never a re-dictation.
struct AgentVoiceReplyView: View {
    let item: UnifiedSession
    @Environment(\.dismiss) private var dismiss

    @StateObject private var recorder = VoiceRecorder()

    private enum Step: Equatable {
        case listening
        case sending
        case sent
        case noSpeech
        case micDenied
        case sendFailed
    }

    @State private var step = Step.listening
    @State private var pendingAudio: URL?
    @State private var transcript: String?

    var body: some View {
        VStack(spacing: 2) {
            Text(item.session.name)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
            Text("\(item.connectionName) · \(item.projectName)")
                .font(.mono(9))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            stage
        }
        .onAppear { beginListening() }
        .onDisappear {
            recorder.cancel()
            discardAudio()
        }
    }

    @ViewBuilder private var stage: some View {
        switch step {
        case .listening:
            VoiceStageView(
                stage: .listening,
                level: recorder.level,
                title: "Dinliyor…",
                caption: "sessizlik veya dokunuş gönderir",
                onTap: { recorder.finish() }
            )
        case .sending:
            VoiceStageView(stage: .sending, title: "Gönderiliyor…", detail: transcript)
        case .sent:
            VoiceStageView(stage: .success, title: "Gönderildi", detail: transcript)
        case .noSpeech:
            VoiceStageView(
                stage: .failure,
                title: "Ses algılanmadı",
                caption: "tekrar söylemek için dokun",
                onTap: { beginListening() }
            )
        case .micDenied:
            VoiceStageView(
                stage: .failure,
                title: "Mikrofon izni kapalı",
                caption: "izin verip tekrar dokun",
                onTap: { beginListening() }
            )
        case .sendFailed:
            VoiceStageView(
                stage: .failure,
                title: "Gönderilemedi",
                caption: "tekrar göndermek için dokun",
                detail: transcript,
                onTap: { resend() }
            )
        }
    }

    private func beginListening() {
        discardAudio()
        transcript = nil
        step = .listening
        recorder.begin { url in
            guard let url else {
                step = recorder.phase == .denied ? .micDenied : .noSpeech
                return
            }
            recorder.markTranscribed()
            pendingAudio = url
            Task { await send(url) }
        }
    }

    private func resend() {
        guard let pendingAudio else {
            beginListening()
            return
        }
        Task { await send(pendingAudio) }
    }

    private func send(_ url: URL) async {
        step = .sending
        guard let credential = CredentialStore.credential(id: item.connectionId) else {
            Haptics.failed()
            step = .sendFailed
            return
        }
        let result: ReplyResponse? = try? await GatewayAPI.postAudio(
            credential: credential,
            path: "/watch/reply-voice",
            query: [
                URLQueryItem(name: "session", value: item.session.id),
                URLQueryItem(name: "epoch", value: String(item.session.runtimeEpoch)),
            ],
            fileURL: url
        )
        if let sent = result?.transcript, !sent.isEmpty { transcript = sent }
        if result?.delivered == true {
            Haptics.delivered()
            discardAudio()
            step = .sent
            try? await Task.sleep(for: .seconds(1.4))
            dismiss()
        } else {
            Haptics.failed()
            step = .sendFailed
        }
    }

    private func discardAudio() {
        if let pendingAudio { try? FileManager.default.removeItem(at: pendingAudio) }
        pendingAudio = nil
    }
}
