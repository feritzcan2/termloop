import AVFoundation
import SwiftUI

struct ChatMessage: Codable, Identifiable, Equatable {
    let id: String
    let sequence: Int
    let author: String
    let kind: String
    let content: String
    let atEpochMs: Int
}

struct ChatListResponse: Codable {
    let messages: [ChatMessage]
}

struct ChatSendResponse: Codable {
    let message: ChatMessage
}

struct VoiceSendResponse: Codable {
    let transcript: String
    let message: ChatMessage
}

struct StewardActionRequest: Codable {
    let projectId: String
    let messageId: String
    let action: String
}

struct StatusProject: Codable, Identifiable, Hashable {
    let id: String
    let name: String
}

private struct ChatProjectOption: Identifiable, Hashable {
    let connectionId: String
    let connectionName: String
    let project: StatusProject

    var id: String { "\(connectionId):\(project.id)" }
}

struct StatusSession: Codable, Identifiable, Hashable {
    let id: String
    let runtimeEpoch: Int
    let name: String
    let agent: String
    let projectId: String
    let cwd: String?
    let status: String
}

struct StatusResponse: Codable {
    let projects: [StatusProject]
    let sessions: [StatusSession]
}

enum Speech {
    static let synthesizer = AVSpeechSynthesizer()

    static func speak(_ text: String) {
        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: String(text.prefix(600)))
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }
}

// Voice conversation with the project Steward. One message fills the screen at
// a time; swiping left/right pages through the history and the newest message
// is always the landing page. Dictation goes in through the watch keyboard's
// mic, replies come back on the polled Companion transcript and are optionally
// spoken aloud. When a reply lands after the app left the foreground, the
// gateway's "Stew replied" push reopens this page.
struct ChatView: View {
    let autoStart: Bool

    init(autoStart: Bool = false) {
        self.autoStart = autoStart
    }

    @ObservedObject private var appState = AppState.shared
    @AppStorage("chatConnectionId") private var connectionId = ""
    @AppStorage("chatProjectId") private var projectId = ""
    @AppStorage("speakReplies") private var speakReplies = true

    @StateObject private var recorder = VoiceRecorder()
    @State private var projects: [ChatProjectOption] = []
    @State private var messages: [ChatMessage] = []
    @State private var selectedSequence: Int?
    @State private var expandedMessage: ChatMessage?
    @State private var controlsPresented = false
    @State private var sending = false
    @State private var lastSpokenSequence = 0
    @State private var awaitingReplySince: Int?
    @State private var didAutoStart = false

    var body: some View {
        VStack(spacing: 3) {
            if messages.isEmpty {
                Spacer()
                EmptyStateView(
                    icon: "bubble.left.and.bubble.right",
                    text: appState.hasConnections ? "Henüz mesaj yok — mikrofona dokun" : "iPhone'da TermLoop'u aç"
                )
                Spacer()
            } else {
                // Horizontal-only paging: a vertical drag is never claimed here,
                // so it always reaches the outer tab pager. A message longer than
                // the page opens full-screen on tap instead of scrolling in place.
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(Array(messages.enumerated()), id: \.element.sequence) { index, message in
                            MessagePage(message: message, position: index + 1, total: messages.count)
                                .containerRelativeFrame(.horizontal)
                                .id(message.sequence)
                                .onTapGesture { expandedMessage = message }
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .defaultScrollAnchor(.trailing)
                .scrollPosition(id: $selectedSequence)
            }
            Text(footerLabel)
                .font(.mono(11))
                .foregroundStyle(footerColor)
                .frame(height: 13)
            // One tap, speak, done: the dictation sheet's confirm submits and
            // the message sends itself — no separate send button. The mic is
            // the page's one loud element; everything flanking it stays quiet.
            HStack {
                Group {
                    Button {
                        controlsPresented = true
                    } label: {
                        Image(systemName: "checklist")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.stew)
                    }
                    .buttonStyle(.plain)
                }
                .frame(width: 34, height: 34)
                Spacer()
                Button {
                    micTapped()
                } label: {
                    if recorder.isBusy {
                        ListeningRing(level: recorder.level, transcribing: recorder.phase == .transcribing)
                    } else {
                        ZStack {
                            Circle().fill(Theme.stew)
                            Image(systemName: sending ? "ellipsis" : "mic.fill")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.black)
                        }
                        .frame(width: 42, height: 42)
                    }
                }
                .buttonStyle(.plain)
                .disabled(sending || recorder.phase == .transcribing)
                Spacer()
                Button {
                    speakReplies.toggle()
                } label: {
                    Image(systemName: speakReplies ? "speaker.wave.2.fill" : "speaker.slash")
                        .font(.system(size: 14))
                        .foregroundStyle(speakReplies ? Theme.stew : .secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 34, height: 34)
            }
            .padding(.horizontal, 2)
        }
        .navigationTitle(currentProjectName)
        .sheet(item: $expandedMessage) { message in
            MessageDetailSheet(
                message: message,
                actionable: messages.last?.id == message.id
            ) { action in
                await respond(to: message, action: action)
            }
        }
        .sheet(isPresented: $controlsPresented) {
            StewardControlsSheet(
                projects: projects,
                selectedId: "\(connectionId):\(projectId)",
                onSelectProject: {
                    connectionId = $0.connectionId
                    projectId = $0.project.id
                    WatchSelectionStore.chatTarget = WatchProjectTarget(
                        connectionId: $0.connectionId,
                        projectId: $0.project.id
                    )
                },
                onCommand: { command in await send(command) }
            )
        }
        .task { await run() }
        .onChange(of: projectId) { _, _ in
            messages = []
            Task { await refresh() }
        }
        .onChange(of: connectionId) { _, _ in
            messages = []
            Task { await refresh() }
        }
        .onChange(of: appState.autoTalkRequested) { _, requested in
            if requested { autoTalk() }
        }
        .onAppear {
            if appState.autoTalkRequested { autoTalk() }
        }
    }

    private var footerLabel: String {
        switch recorder.phase {
        case .listening: return "dinliyorum…"
        case .transcribing: return "yazıya çevriliyor…"
        case .denied: return "mikrofon izni kapalı"
        case .idle: return awaitingReplySince == nil ? "" : "stew düşünüyor…"
        }
    }

    private var footerColor: Color {
        recorder.phase == .denied ? Theme.amber : Theme.stew
    }

    private var currentProjectName: String {
        guard projects.count > 1,
              let project = projects.first(where: {
                  $0.connectionId == connectionId && $0.project.id == projectId
              })
        else { return "❯ stew" }
        return "❯ \(project.project.name.lowercased())"
    }

    // One tap on the mic: start listening, or stop the take early. Speaking and
    // then falling silent is the ordinary way to finish — there is no confirm
    // step. If the microphone was refused, the system dictation sheet remains
    // as the way in.
    private func micTapped() {
        if recorder.phase == .listening {
            recorder.finish()
            return
        }
        guard recorder.phase != .transcribing else { return }
        listen()
    }

    private func listen() {
        recorder.begin { url in
            guard let url else {
                if recorder.phase == .denied { presentDictation() }
                return
            }
            Task { await sendVoice(url) }
        }
    }

    private func presentDictation() {
        DictationPresenter.present { text in
            guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            Task { _ = await send(text) }
        }
    }

    // Watch-face complication path: the app opens already listening, so the
    // wearer only has to speak.
    private func autoTalk() {
        appState.autoTalkRequested = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            listen()
        }
    }

    private func run() async {
        await loadProjects()
        if autoStart && !didAutoStart {
            didAutoStart = true
            listen()
        }
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(awaitingReplySince == nil ? 6 : 3))
        }
    }

    private func loadProjects() async {
        projects = await withTaskGroup(of: [ChatProjectOption].self) { group in
            for connection in appState.connections {
                group.addTask {
                    guard let credential = CredentialStore.credential(id: connection.id),
                          let status = try? await GatewayAPI.fetch(
                            StatusResponse.self,
                            credential: credential,
                            path: "/watch/status"
                          )
                    else { return [] }
                    return status.projects.map {
                        ChatProjectOption(connectionId: connection.id, connectionName: connection.name, project: $0)
                    }
                }
            }
            var result: [ChatProjectOption] = []
            for await options in group { result.append(contentsOf: options) }
            return result
        }
        if let pending = appState.pendingChatTarget,
           projects.contains(where: {
               $0.connectionId == pending.connectionId && $0.project.id == pending.projectId
           }) {
            connectionId = pending.connectionId
            projectId = pending.projectId
            appState.pendingChatTarget = nil
        }
        if !projects.contains(where: { $0.connectionId == connectionId && $0.project.id == projectId }),
           let first = projects.first {
            connectionId = first.connectionId
            projectId = first.project.id
        }
        if !connectionId.isEmpty && !projectId.isEmpty {
            WatchSelectionStore.chatTarget = WatchProjectTarget(connectionId: connectionId, projectId: projectId)
        }
    }

    private func refresh() async {
        guard let credential = CredentialStore.credential(id: connectionId), !projectId.isEmpty else { return }
        guard let list = try? await GatewayAPI.fetch(
            ChatListResponse.self,
            credential: credential,
            path: "/watch/chat",
            query: [URLQueryItem(name: "project", value: projectId)]
        ) else { return }
        // Land on the newest message only when something new arrived, so
        // browsing old pages is never yanked back by the poll.
        let previousLast = messages.last?.sequence
        messages = list.messages
        if let last = messages.last?.sequence, last != previousLast {
            selectedSequence = last
        }
        announceReplyIfArrived()
    }

    // The recording goes to the gateway, the Mac transcribes it on-device, and
    // the resulting text lands in the Steward transcript in one round trip.
    private func sendVoice(_ url: URL) async {
        defer {
            try? FileManager.default.removeItem(at: url)
            recorder.markTranscribed()
        }
        guard let credential = CredentialStore.credential(id: connectionId), !projectId.isEmpty else {
            Haptics.failed()
            return
        }
        guard let sent: VoiceSendResponse = try? await GatewayAPI.postAudio(
            credential: credential,
            path: "/watch/voice",
            query: [URLQueryItem(name: "project", value: projectId)],
            fileURL: url
        ) else {
            Haptics.failed()
            return
        }
        awaitingReplySince = sent.message.sequence
        lastSpokenSequence = sent.message.sequence
        messages.append(sent.message)
        selectedSequence = sent.message.sequence
    }

    private func send(_ text: String) async -> Bool {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let credential = CredentialStore.credential(id: connectionId),
              !content.isEmpty, !projectId.isEmpty
        else { return false }
        sending = true
        defer { sending = false }
        guard let sent: ChatSendResponse = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/chat",
            body: ["projectId": projectId, "content": content]
        ) else {
            Haptics.failed()
            return false
        }
        awaitingReplySince = sent.message.sequence
        lastSpokenSequence = sent.message.sequence
        messages.append(sent.message)
        selectedSequence = sent.message.sequence
        return true
    }

    private func respond(to message: ChatMessage, action: String) async -> Bool {
        guard let credential = CredentialStore.credential(id: connectionId), !projectId.isEmpty else { return false }
        sending = true
        defer { sending = false }
        guard let sent: ChatSendResponse = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/steward-action",
            body: StewardActionRequest(projectId: projectId, messageId: message.id, action: action)
        ) else {
            Haptics.failed()
            return false
        }
        awaitingReplySince = sent.message.sequence
        lastSpokenSequence = sent.message.sequence
        messages.append(sent.message)
        selectedSequence = sent.message.sequence
        Haptics.delivered()
        return true
    }

    // Speak only a reply that answers this session's own question: everything
    // already on screen when the page opens stays silent.
    private func announceReplyIfArrived() {
        guard let since = awaitingReplySince,
              let reply = messages.last(where: { $0.author == "steward" && $0.sequence > since })
        else { return }
        awaitingReplySince = nil
        if reply.sequence > lastSpokenSequence {
            lastSpokenSequence = reply.sequence
            Haptics.reply()
            if speakReplies { Speech.speak(reply.content) }
        }
    }
}

// A single transcript message as a full-screen page: an author chip and the
// monospaced position on top, the content full-bleed underneath — the chip
// carries authorship so the text needs no box around it. The page itself
// never scrolls vertically (that gesture belongs to the tab pager); overflow
// truncates and the tap-to-expand sheet shows the rest.
struct MessagePage: View {
    let message: ChatMessage
    let position: Int
    let total: Int

    private var isStew: Bool { message.author == "steward" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(messageBadge)
                    .font(.mono(10, .bold))
                    .foregroundStyle(isStew ? .black : .white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(isStew ? Theme.stew : Theme.graphite))
                Spacer()
                Text("\(position)/\(total)")
                    .font(.mono(10))
                    .foregroundStyle(.tertiary)
            }
            Text(message.content)
                .font(.system(size: 16))
                .lineSpacing(3)
                .lineLimit(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 2)
        .contentShape(Rectangle())
    }

    private var messageBadge: String {
        if message.author != "steward" { return "❯ SEN" }
        if message.kind == "proposal" { return "KARAR" }
        if message.kind == "suggestion" { return "ÖNERİ" }
        return "STEW"
    }
}

// Full message on tap, in its own sheet: vertical scrolling lives here, safely
// outside the pager's gesture space.
struct MessageDetailSheet: View {
    let message: ChatMessage
    let actionable: Bool
    let onAction: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var responding = false
    @State private var responseFailed = false

    private var isStew: Bool { message.author == "steward" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(isStew ? "STEW" : "❯ SEN")
                    .font(.mono(10, .bold))
                    .foregroundStyle(isStew ? .black : .white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(isStew ? Theme.stew : Theme.graphite))
                Text(message.content)
                    .font(.system(size: 16))
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if actionable && message.kind == "proposal" {
                    Button("Onayla") { decide("approve") }
                        .tint(Theme.stew)
                        .disabled(responding)
                    Button("Şimdi değil") { decide("decline") }
                        .disabled(responding)
                } else if actionable && message.kind == "suggestion" {
                    Button("Uygula") { decide("accept") }
                        .tint(Theme.stew)
                        .disabled(responding)
                } else if !actionable && ["proposal", "suggestion"].contains(message.kind) {
                    Text("Bu karar artık güncel değil.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if responseFailed {
                    Text("Bu istek artık güncel olmayabilir. Sohbeti yenileyip tekrar dene.")
                        .font(.footnote)
                        .foregroundStyle(Theme.amber)
                }
            }
        }
    }

    private func decide(_ action: String) {
        guard !responding else { return }
        responding = true
        responseFailed = false
        Task {
            if await onAction(action) { dismiss() }
            else { responseFailed = true }
            responding = false
        }
    }
}

private struct StewardCommand: Identifiable {
    let id: String
    let label: String
    let icon: String
    let prompt: String
}

private let stewardCommands = [
    StewardCommand(
        id: "needs-you",
        label: "Benden ne bekliyor?",
        icon: "person.crop.circle.badge.questionmark",
        prompt: "Şu anda bu projede benden karar veya onay bekleyen her şeyi, en acilden başlayarak kısa seçeneklerle göster. Bekleyen bir şey yoksa açıkça söyle."
    ),
    StewardCommand(
        id: "pipeline",
        label: "Pipeline durumu",
        icon: "point.3.connected.trianglepath.dotted",
        prompt: "Açık Taskların delivery pipeline durumunu özetle. Takılanları, kanıtı ve alabileceğin bir sonraki aksiyonu belirt; aksiyon gerekiyorsa bana proposal olarak sor."
    ),
    StewardCommand(
        id: "routines",
        label: "Routine sorunları",
        icon: "waveform.path.ecg",
        prompt: "Worker ve Routine sağlıklarını kontrol et. Yalnızca gerçek sorunları ve gereken aksiyonları özetle; uygulayabileceğin aksiyonlar için proposal göster."
    ),
    StewardCommand(
        id: "agents",
        label: "Agent durumları",
        icon: "terminal",
        prompt: "Bu projedeki çalışan Agentları kontrol et. Benden yanıt, review veya karar bekleyenleri kısa şekilde sırala."
    ),
    StewardCommand(
        id: "project",
        label: "Projeyi özetle",
        icon: "list.bullet.rectangle",
        prompt: "Bu projenin güncel durumunu, aktif Taskları, önemli engelleri ve sıradaki kararları saat ekranına uygun kısa bir özetle anlat."
    ),
]

private struct StewardControlsSheet: View {
    let projects: [ChatProjectOption]
    let selectedId: String
    let onSelectProject: (ChatProjectOption) -> Void
    let onCommand: (String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var sendingCommandId: String?

    var body: some View {
        List {
            if projects.count > 1 {
                Section("Proje") {
                    ForEach(projects) { option in
                        Button {
                            onSelectProject(option)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.project.name)
                                    Text(option.connectionName)
                                        .font(.mono(10))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if option.id == selectedId {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Theme.stew)
                                }
                            }
                        }
                    }
                }
            }
            Section("Stew'a sor") {
                ForEach(stewardCommands) { command in
                    Button {
                        run(command)
                    } label: {
                        Label(
                            sendingCommandId == command.id ? "Gönderiliyor…" : command.label,
                            systemImage: command.icon
                        )
                    }
                    .disabled(sendingCommandId != nil)
                }
            }
        }
        .navigationTitle("❯ kontrol")
    }

    private func run(_ command: StewardCommand) {
        guard sendingCommandId == nil else { return }
        sendingCommandId = command.id
        Task {
            if await onCommand(command.prompt) { dismiss() }
            else { sendingCommandId = nil }
        }
    }
}
