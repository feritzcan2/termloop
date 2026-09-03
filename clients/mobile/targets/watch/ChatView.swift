import AVFoundation
import NaturalLanguage
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

private struct StewardSpeechRequest: Codable {
    let projectId: String
    let sequence: Int
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

@MainActor
final class SpeechPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    @Published private(set) var isSpeaking = false

    private let synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var completion: (() -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func play(_ audio: Data?, fallbackText: String, completion: @escaping () -> Void) {
        cancel()
        self.completion = completion
        activatePlaybackSession()
        if let audio,
           let player = try? AVAudioPlayer(data: audio),
           player.prepareToPlay() {
            self.player = player
            player.delegate = self
            player.volume = 1
            player.enableRate = true
            player.rate = 1.12
            isSpeaking = true
            if player.play() { return }
        }
        player = nil
        let utterance = AVSpeechUtterance(string: String(fallbackText.prefix(1_500)))
        utterance.voice = speechVoice(for: fallbackText)
        utterance.rate = 0.5
        utterance.pitchMultiplier = 0.98
        utterance.volume = 1
        isSpeaking = true
        synthesizer.speak(utterance)
    }

    func cancel() {
        completion = nil
        player?.stop()
        player = nil
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private func speechVoice(for text: String) -> AVSpeechSynthesisVoice? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        if let language = recognizer.dominantLanguage?.rawValue,
           let voice = AVSpeechSynthesisVoice(language: language) {
            return voice
        }
        return Locale.preferredLanguages.first.flatMap { AVSpeechSynthesisVoice(language: $0) }
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finished() }
    }

    private func activatePlaybackSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        try? session.setActive(true)
    }

    private func finished() {
        guard isSpeaking else { return }
        isSpeaking = false
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        let action = completion
        completion = nil
        action?()
    }
}

private enum QuickMessageResult: Equatable {
    case preparing
    case sent
    case failed(String)
}

// Steward's asynchronous wrist inbox. One message fills the screen at a time;
// swiping pages history and tapping a reply can still read it aloud. The watch-
// face path overlays a purpose-built one-shot recorder and never waits for the
// answer: the gateway's later "Stew replied" push reopens this inbox.
struct ChatView: View {
    let autoStart: Bool

    init(autoStart: Bool = false) {
        self.autoStart = autoStart
        _quickCapture = State(initialValue: autoStart)
        _quickResult = State(initialValue: .preparing)
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var appState = AppState.shared
    @AppStorage("chatConnectionId") private var connectionId = ""
    @AppStorage("chatProjectId") private var projectId = ""
    @AppStorage("speakReplies") private var speakReplies = true

    @StateObject private var recorder = VoiceRecorder()
    @StateObject private var speech = SpeechPlayer()
    @State private var projects: [ChatProjectOption] = []
    @State private var messages: [ChatMessage] = []
    @State private var selectedSequence: Int?
    @State private var expandedMessage: ChatMessage?
    @State private var controlsPresented = false
    @State private var sending = false
    @State private var awaitingReplySince: Int?
    @State private var speakingReplySequence: Int?
    @State private var didAutoStart = false
    @State private var quickCapture: Bool
    @State private var quickResult: QuickMessageResult
    @State private var quickTarget: WatchProjectTarget? = nil

    var body: some View {
        ZStack {
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
                            Image(systemName: speech.isSpeaking ? "waveform" : (sending ? "ellipsis" : "mic.fill"))
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
                    speakerTapped()
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
            .opacity(quickCapture ? 0 : 1)
            .allowsHitTesting(!quickCapture)

            if quickCapture { quickMessageStage }
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
            targetChanged()
        }
        .onChange(of: connectionId) { _, _ in
            targetChanged()
        }
        .onChange(of: appState.autoTalkRequested) { _, requested in
            if requested { autoTalk() }
        }
        .onAppear {
            if appState.autoTalkRequested { autoTalk() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                recorder.cancel()
                speech.cancel()
                speakingReplySequence = nil
            } else if phase == .active {
                if quickCapture, quickResult == .preparing, recorder.phase == .idle {
                    // A cold complication launch can still be inactive when the
                    // initial 50 ms attempt fires. Start as soon as watchOS gives
                    // us the foreground instead of leaving the wrist waiting.
                    listen()
                } else if !quickCapture {
                    restoreAwaitingReply()
                    Task { await refresh() }
                }
            }
        }
        .onDisappear {
            recorder.cancel()
            speech.cancel()
        }
    }

    @ViewBuilder
    private var quickMessageStage: some View {
        switch quickResult {
        case .sent:
            VoiceStageView(
                stage: .success,
                title: "Gönderildi",
                caption: "Yanıt bildirimle gelecek"
            )
        case .failed(let message):
            VoiceStageView(
                stage: .failure,
                title: "Gönderilemedi",
                caption: message,
                onTap: beginQuickMessage
            )
        case .preparing:
            switch recorder.phase {
            case .listening:
                VoiceStageView(
                    stage: .listening,
                    level: recorder.level,
                    title: "Mesajını söyle",
                    caption: "1 sn sessizlikte gönderilir",
                    onTap: recorder.finish
                )
            case .transcribing:
                VoiceStageView(stage: .sending, title: "Gönderiliyor…")
            case .denied:
                VoiceStageView(
                    stage: .failure,
                    title: "Mikrofon izni kapalı",
                    caption: "Dikte etmek için dokun",
                    onTap: presentDictation
                )
            case .idle:
                VoiceStageView(stage: .sending, title: "Mikrofon açılıyor…")
            }
        }
    }

    private var footerLabel: String {
        let status: String
        if speech.isSpeaking { status = "stew konuşuyor…" }
        else if speakingReplySequence != nil { status = "ses hazırlanıyor…" }
        else {
            switch recorder.phase {
            case .listening: status = "dinliyorum…"
            case .transcribing: status = "yazıya çevriliyor…"
            case .denied: status = "mikrofon izni kapalı"
            case .idle:
                if let since = awaitingReplySince {
                    let replyReady = messages.contains { $0.author == "steward" && $0.sequence > since }
                    status = replyReady && !speakReplies ? "cevap hazır • sesi aç" : "yanıt bildirimle gelecek"
                } else {
                    status = ""
                }
            }
        }
        return status
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
        if speech.isSpeaking {
            speech.cancel()
            listen()
            return
        }
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
                else if quickCapture { quickResult = .failed("Yeniden denemek için dokun") }
                return
            }
            Task { await sendVoice(url) }
        }
    }

    private func speakerTapped() {
        if speakReplies {
            speakReplies = false
            speech.cancel()
            speakingReplySequence = nil
            return
        }
        speakReplies = true
        announceReplyIfArrived()
    }

    private func presentDictation() {
        DictationPresenter.present { text in
            guard let text, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            Task {
                let delivered = await send(text)
                if quickCapture {
                    if delivered { Haptics.delivered() }
                    finishQuickMessage(delivered: delivered)
                }
            }
        }
    }

    // Watch-face complication path: resolve the already-synced default locally
    // and open the microphone without waiting for status or transcript network
    // reads. The wearer only taps once and speaks.
    private func autoTalk() {
        appState.autoTalkRequested = false
        didAutoStart = true
        beginQuickMessage()
    }

    private func run() async {
        if autoStart || quickCapture || appState.autoTalkRequested {
            if !didAutoStart {
                didAutoStart = true
                appState.autoTalkRequested = false
                beginQuickMessage()
            }
            // No status or transcript request belongs on the complication's
            // critical path. Dismissing the success screen cancels this task.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
            }
            return
        }
        await loadProjects()
        restoreAwaitingReply()
        await refresh()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(awaitingReplySince == nil ? 6 : 3))
            await refresh()
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
        restoreAwaitingReply()
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
        let previousNewest = messages.map(\.sequence).max()
        messages = list.messages.sorted { $0.sequence < $1.sequence }
        if let newest = messages.last?.sequence, newest != previousNewest {
            selectedSequence = newest
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
        let target = quickCapture
            ? quickTarget
            : WatchProjectTarget(connectionId: connectionId, projectId: projectId)
        guard let target,
              let credential = CredentialStore.credential(id: target.connectionId),
              !target.projectId.isEmpty
        else {
            Haptics.failed()
            if quickCapture { quickResult = .failed("iPhone'dan hedef projeyi seç") }
            return
        }
        guard let sent: VoiceSendResponse = try? await GatewayAPI.postAudio(
            credential: credential,
            path: "/watch/voice",
            query: [URLQueryItem(name: "project", value: target.projectId)],
            fileURL: url
        ) else {
            Haptics.failed()
            if quickCapture { quickResult = .failed("Bağlantıyı kontrol edip tekrar dene") }
            return
        }
        awaitReply(
            after: sent.message.sequence,
            connectionId: target.connectionId,
            projectId: target.projectId
        )
        messages.append(sent.message)
        selectedSequence = sent.message.sequence
        Haptics.delivered()
        if quickCapture { finishQuickMessage(delivered: true) }
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
        awaitReply(after: sent.message.sequence, connectionId: connectionId, projectId: projectId)
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
        awaitReply(after: sent.message.sequence, connectionId: connectionId, projectId: projectId)
        messages.append(sent.message)
        selectedSequence = sent.message.sequence
        Haptics.delivered()
        return true
    }

    // Speak only a reply that answers this session's own question: everything
    // already on screen when the page opens stays silent.
    private func announceReplyIfArrived() {
        guard let since = awaitingReplySince,
              recorder.phase == .idle,
              speakingReplySequence == nil,
              let reply = messages
                .filter({ $0.author == "steward" && $0.sequence > since })
                .max(by: { $0.sequence < $1.sequence })
        else { return }
        guard speakReplies else { return }
        speakingReplySequence = reply.sequence
        Haptics.reply()
        Task { await speak(reply, after: since) }
    }

    private func speak(_ reply: ChatMessage, after userSequence: Int) async {
        let targetConnectionId = connectionId
        let targetProjectId = projectId
        guard !targetConnectionId.isEmpty, !targetProjectId.isEmpty else {
            speakingReplySequence = nil
            return
        }
        let audio: Data?
        if let credential = CredentialStore.credential(id: targetConnectionId) {
            audio = try? await GatewayAPI.postBinary(
                credential: credential,
                path: "/watch/speech",
                body: StewardSpeechRequest(projectId: targetProjectId, sequence: reply.sequence)
            )
        } else {
            audio = nil
        }
        guard scenePhase == .active,
              connectionId == targetConnectionId,
              projectId == targetProjectId,
              awaitingReplySince == userSequence,
              speakingReplySequence == reply.sequence
        else {
            speakingReplySequence = nil
            return
        }
        speech.play(audio, fallbackText: reply.content) {
            StewardReplyStore.clear(
                sequence: userSequence,
                connectionId: targetConnectionId,
                projectId: targetProjectId
            )
            if awaitingReplySince == userSequence { awaitingReplySince = nil }
            speakingReplySequence = nil
        }
    }

    private func awaitReply(after sequence: Int, connectionId: String, projectId: String) {
        if self.connectionId == connectionId && self.projectId == projectId {
            awaitingReplySince = sequence
            speakingReplySequence = nil
        }
        StewardReplyStore.remember(sequence: sequence, connectionId: connectionId, projectId: projectId)
    }

    private func restoreAwaitingReply() {
        awaitingReplySince = StewardReplyStore.sequence(connectionId: connectionId, projectId: projectId)
    }

    private func targetChanged() {
        messages = []
        speech.cancel()
        speakingReplySequence = nil
        restoreAwaitingReply()
        Task { await refresh() }
    }

    private func beginQuickMessage() {
        quickCapture = true
        quickResult = .preparing
        speech.cancel()
        speakingReplySequence = nil
        guard prepareQuickTarget() else {
            quickResult = .failed("iPhone'dan hedef projeyi seç")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            guard quickCapture, scenePhase == .active, recorder.phase == .idle else { return }
            listen()
        }
    }

    private func prepareQuickTarget() -> Bool {
        if let selected = WatchSelectionStore.chatTarget,
           CredentialStore.credential(id: selected.connectionId) != nil {
            connectionId = selected.connectionId
            projectId = selected.projectId
            quickTarget = selected
            return !selected.projectId.isEmpty
        }
        guard let credential = CredentialStore.preferred(),
              let defaultProjectId = credential.targetProjectId,
              !defaultProjectId.isEmpty
        else { return false }
        connectionId = credential.id
        projectId = defaultProjectId
        WatchSelectionStore.chatTarget = WatchProjectTarget(
            connectionId: credential.id,
            projectId: defaultProjectId
        )
        quickTarget = WatchProjectTarget(connectionId: credential.id, projectId: defaultProjectId)
        return true
    }

    private func finishQuickMessage(delivered: Bool) {
        guard quickCapture else { return }
        if !delivered {
            quickResult = .failed("Bağlantıyı kontrol edip tekrar dene")
            return
        }
        quickResult = .sent
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            guard quickCapture, quickResult == .sent else { return }
            dismiss()
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
