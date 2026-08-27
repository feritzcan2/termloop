import SwiftUI

private struct ProjectAgentLaunchResponse: Codable {
    let sessionId: String
    let name: String?
    let runtimeEpoch: Int?
    let promptDelivered: Bool?
    let transcript: String?
}

private struct TranscribeResponse: Codable {
    let transcript: String
}

private enum ProjectAgentChoice: String, CaseIterable, Identifiable {
    case claude
    case codex

    var id: String { rawValue }
    var label: String { self == .claude ? "Claude" : "Codex" }
}

private struct LaunchProject: Identifiable, Hashable {
    let connectionId: String
    let connectionName: String
    let project: StatusProject

    var id: String { "\(connectionId):\(project.id)" }
}

// Voice-first launcher: opening it starts listening immediately, silence or a
// tap on the circle keeps the prompt, and what remains is one compact confirm
// screen — the remembered Mac·Project·Agent as a single row with choices tucked
// behind “Değiştir”, plus one launch action. Every outcome (launching, launched, prompt not
// delivered, failed) is a full-screen stage with a single obvious tap.
struct ProjectAgentLauncherView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var appState = AppState.shared
    @AppStorage("agentLaunchConnectionId") private var connectionId = ""
    @AppStorage("agentLaunchProjectId") private var projectId = ""
    @AppStorage("agentLaunchAgentId") private var agentId = ProjectAgentChoice.claude.rawValue

    private enum Step: Equatable {
        case record
        case recordFailed(String)
        case confirm
        case busy(String)
        case done(String)
        case promptStuck(sessionId: String, runtimeEpoch: Int)
        case failed(String)
    }

    @StateObject private var recorder = VoiceRecorder()
    @State private var step = Step.record
    @State private var promptAudioURL: URL?
    // The Mac's transcription of the recording, fetched right after the take
    // so the confirm screen shows the exact words before anything launches.
    @State private var promptText: String?
    @State private var transcribing = false
    @State private var promptUnrecognized = false
    @State private var projects: [LaunchProject] = []
    @State private var projectsLoading = true
    @State private var pickerPresented = false
    @State private var didAutoRecord = false

    private var selected: LaunchProject? {
        projects.first { $0.connectionId == connectionId && $0.project.id == projectId }
    }

    var body: some View {
        Group {
            switch step {
            case .record:
                recordStage(
                    VoiceStageView(
                        stage: .listening,
                        level: recorder.level,
                        title: "Promptu söyle",
                        caption: "2 sn sessizlik veya dokunuş bitirir",
                        onTap: { recorder.finish() }
                    )
                )
            case .recordFailed(let message):
                recordStage(
                    VoiceStageView(
                        stage: .failure,
                        title: message,
                        caption: "tekrar söylemek için dokun",
                        onTap: { beginRecording() }
                    )
                )
            case .confirm:
                confirmList
            case .busy(let message):
                VoiceStageView(stage: .sending, title: message, detail: promptText)
            case .done(let message):
                VoiceStageView(stage: .success, title: message, detail: promptText)
            case .promptStuck(let sessionId, let runtimeEpoch):
                VoiceStageView(
                    stage: .failure,
                    title: "Agent başladı, prompt gitmedi",
                    caption: "tekrar göndermek için dokun",
                    detail: promptText,
                    onTap: { Task { await resendPrompt(sessionId: sessionId, runtimeEpoch: runtimeEpoch) } }
                )
            case .failed(let message):
                VoiceStageView(
                    stage: .failure,
                    title: message,
                    caption: "tekrar denemek için dokun",
                    onTap: { step = .confirm }
                )
            }
        }
        .navigationTitle("❯ başlat")
        .task { await loadProjects() }
        .onAppear {
            guard !didAutoRecord else { return }
            didAutoRecord = true
            // Let the first frame mount, then open the mic without an
            // artificial navigation delay. Project loading already runs in
            // parallel with the take.
            DispatchQueue.main.async { beginRecording() }
        }
        .onDisappear {
            recorder.cancel()
            cleanupPrompt()
        }
        .sheet(isPresented: $pickerPresented) { projectPicker }
    }

    // While listening, skipping the prompt stays one small tap away — the same
    // launcher also serves "just start an agent" without any dictation.
    private func recordStage(_ stage: VoiceStageView) -> some View {
        VStack(spacing: 0) {
            stage
            Button("Promptsuz devam") {
                recorder.cancel()
                cleanupPrompt()
                step = .confirm
            }
            .font(.mono(11))
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.bottom, 2)
        }
    }

    private var confirmList: some View {
        List {
            if promptAudioURL != nil {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Label(
                            transcribing ? "Yazıya çevriliyor…" : "Prompt",
                            systemImage: transcribing ? "waveform" : "waveform.circle.fill"
                        )
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.phosphor)
                        .symbolEffect(.variableColor.iterative, isActive: transcribing)
                        Spacer()
                        Button("Söyle") { beginRecording() }
                            .font(.mono(11))
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.stew)
                    }
                    if let promptText {
                        // The prompt's text form: read it before launching,
                        // re-record with one tap if it came out wrong.
                        Text("❯ \(promptText)")
                            .font(.mono(11))
                            .foregroundStyle(.primary)
                            .lineLimit(5)
                    } else if !transcribing {
                        Text("yazıya çevrilemedi · ses olarak gönderilecek")
                            .font(.mono(10))
                            .foregroundStyle(.secondary)
                    }
                }
                .cardRow()
            } else {
                Button { beginRecording() } label: {
                    Label(
                        promptUnrecognized ? "Ses anlaşılamadı · tekrar söyle" : "Prompt söyle",
                        systemImage: "mic.fill"
                    )
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(promptUnrecognized ? Theme.amber : Theme.stew)
                }
                .cardRow()
            }

            if projectsLoading && projects.isEmpty {
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            } else if projects.isEmpty {
                EmptyStateView(
                    icon: "folder",
                    text: appState.hasConnections ? "Başlatılabilecek proje yok" : "iPhone'da TermLoop'u aç"
                )
            } else {
                Button { pickerPresented = true } label: {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 3) {
                            launchTargetLine(
                                icon: "folder.fill",
                                text: selected?.project.name ?? "Proje seç"
                            )
                            launchTargetLine(
                                icon: "cpu",
                                text: selectedAgentLabel
                            )
                            if connectedMacCount > 1, let selected {
                                launchTargetLine(
                                    icon: "desktopcomputer",
                                    text: selected.connectionName
                                )
                            }
                        }
                        Spacer(minLength: 2)
                        Text("Değiştir")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Theme.stew)
                    }
                }
                .cardRow()

                Button { Task { await launch() } } label: {
                    Label(
                        "Başlat",
                        systemImage: "play.fill"
                    )
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: .infinity)
                }
                .tint(Theme.stew)
                .foregroundStyle(.black)
                .buttonStyle(.borderedProminent)
                .disabled(selected == nil || transcribing)
            }
        }
    }

    private var projectPicker: some View {
        NavigationStack {
            List {
                Section("Agent") {
                    ForEach(ProjectAgentChoice.allCases) { choice in
                        Button {
                            agentId = choice.rawValue
                        } label: {
                            HStack {
                                Text(choice.label)
                                Spacer()
                                if choice.rawValue == agentId {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.stew)
                                }
                            }
                        }
                    }
                }
                Section("Mac · Proje") {
                    ForEach(projects) { option in
                        Button {
                            connectionId = option.connectionId
                            projectId = option.project.id
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.project.name).lineLimit(1)
                                    Text(option.connectionName)
                                        .font(.mono(10))
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if option.id == selected?.id {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.stew)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Değiştir")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Bitti") { pickerPresented = false }
                }
            }
        }
    }

    private var selectedAgentLabel: String {
        ProjectAgentChoice(rawValue: agentId)?.label ?? ProjectAgentChoice.claude.label
    }

    private var connectedMacCount: Int {
        Set(projects.map(\.connectionId)).count
    }

    private func launchTargetLine(icon: String, text: String) -> some View {
        Label(text, systemImage: icon)
            .font(.mono(10))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
    }

    private func beginRecording() {
        cleanupPrompt()
        promptText = nil
        promptUnrecognized = false
        step = .record
        recorder.begin { url in
            guard let url else {
                step = recorder.phase == .denied
                    ? .recordFailed("Mikrofon izni kapalı")
                    : .recordFailed("Ses algılanmadı")
                return
            }
            recorder.markTranscribed()
            promptAudioURL = url
            Haptics.delivered()
            step = .confirm
            Task { await transcribePrompt(url) }
        }
    }

    // Fetch the text form right away: the confirm screen shows the exact words
    // and the launch then sends those words. If the Mac cannot transcribe, the
    // recording itself remains the fallback payload.
    private func transcribePrompt(_ url: URL) async {
        let credentialId = selected?.connectionId
            ?? (connectionId.isEmpty ? appState.connections.first?.id ?? "" : connectionId)
        guard let credential = CredentialStore.credential(id: credentialId) else { return }
        transcribing = true
        var text: String?
        var unrecognized = false
        // One quiet retry: a cold gateway path (fresh TLS, waking tunnel) can
        // eat the first request without meaning transcription is broken. A 422
        // is deterministic — the take holds no recognizable speech — so it is
        // never retried.
        for attempt in 0..<2 {
            do {
                let result: TranscribeResponse = try await GatewayAPI.postAudio(
                    credential: credential,
                    path: "/watch/transcribe",
                    query: [],
                    fileURL: url
                )
                if !result.transcript.isEmpty { text = result.transcript }
                break
            } catch let cause as GatewayResponseError where cause.statusCode == 422 {
                unrecognized = true
                break
            } catch {
                if attempt == 0 { try? await Task.sleep(for: .seconds(0.6)) }
            }
        }
        // A newer take owns the screen now; its own task reports instead.
        guard promptAudioURL == url else { return }
        transcribing = false
        if let text {
            promptText = text
        } else if unrecognized {
            // Launching with this audio would fail the same way at delivery
            // time, so drop it and ask for a new take instead of promising an
            // audio fallback that cannot work.
            cleanupPrompt()
            promptUnrecognized = true
        }
    }

    // Removes only the recording; the text form stays visible through the
    // launch result stages and resets when a new take starts.
    private func cleanupPrompt() {
        if let promptAudioURL { try? FileManager.default.removeItem(at: promptAudioURL) }
        promptAudioURL = nil
    }

    private func loadProjects() async {
        let connections = appState.connections
        let loaded = await withTaskGroup(of: [LaunchProject].self) { group in
            for connection in connections {
                group.addTask {
                    guard let credential = CredentialStore.credential(id: connection.id),
                          let status = try? await GatewayAPI.fetch(
                            StatusResponse.self,
                            credential: credential,
                            path: "/watch/status"
                          )
                    else { return [] }
                    return status.projects.map {
                        LaunchProject(connectionId: connection.id, connectionName: connection.name, project: $0)
                    }
                }
            }
            var result: [LaunchProject] = []
            for await options in group { result.append(contentsOf: options) }
            return result
        }
        projects = loaded.sorted {
            if $0.connectionName != $1.connectionName {
                return $0.connectionName.localizedCaseInsensitiveCompare($1.connectionName) == .orderedAscending
            }
            return $0.project.name.localizedCaseInsensitiveCompare($1.project.name) == .orderedAscending
        }
        if selected == nil, let preferred = preferredProject() {
            connectionId = preferred.connectionId
            projectId = preferred.project.id
        }
        if ProjectAgentChoice(rawValue: agentId) == nil { agentId = ProjectAgentChoice.claude.rawValue }
        projectsLoading = false
    }

    private func preferredProject() -> LaunchProject? {
        if let target = WatchSelectionStore.chatTarget,
           let match = projects.first(where: {
               $0.connectionId == target.connectionId && $0.project.id == target.projectId
           }) {
            return match
        }
        return projects.first
    }

    private func launch() async {
        guard let selected,
              let credential = CredentialStore.credential(id: selected.connectionId)
        else { return }
        step = .busy("Başlatılıyor…")
        do {
            let result: ProjectAgentLaunchResponse
            if let promptText {
                // The confirmed text on screen is exactly what launches.
                result = try await GatewayAPI.post(
                    credential: credential,
                    path: "/watch/project-agent",
                    body: ["projectId": selected.project.id, "agentId": agentId, "prompt": promptText]
                )
            } else if let promptAudioURL {
                result = try await GatewayAPI.postAudio(
                    credential: credential,
                    path: "/watch/project-agent-voice",
                    query: [
                        URLQueryItem(name: "project", value: selected.project.id),
                        URLQueryItem(name: "agent", value: agentId),
                    ],
                    fileURL: promptAudioURL
                )
                if let text = result.transcript, !text.isEmpty { promptText = text }
            } else {
                result = try await GatewayAPI.post(
                    credential: credential,
                    path: "/watch/project-agent",
                    body: ["projectId": selected.project.id, "agentId": agentId]
                )
            }
            let name = result.name ?? "Agent"
            let promptRequested = promptText != nil || promptAudioURL != nil
            if promptRequested && result.promptDelivered != true {
                // The agent is running but the prompt is unconfirmed: keep the
                // recording and retry delivery to that exact session instead of
                // relaunching a second agent.
                Haptics.failed()
                step = .promptStuck(sessionId: result.sessionId, runtimeEpoch: result.runtimeEpoch ?? 0)
            } else {
                await finish("\(name) başlatıldı")
            }
        } catch let cause as GatewayResponseError {
            Haptics.failed()
            step = .failed(cause.statusCode == 404 ? "Bu Mac'in mobil erişimini güncelle" : cause.message)
        } catch {
            Haptics.failed()
            step = .failed("Agent başlatılamadı")
        }
    }

    private func resendPrompt(sessionId: String, runtimeEpoch: Int) async {
        guard let credential = CredentialStore.credential(id: connectionId) else {
            step = .confirm
            return
        }
        step = .busy("Prompt gönderiliyor…")
        let result: ReplyResponse?
        if let promptText {
            result = try? await GatewayAPI.post(
                credential: credential,
                path: "/watch/reply",
                body: WatchReplyBody(sessionId: sessionId, runtimeEpoch: runtimeEpoch, text: promptText)
            )
        } else if let promptAudioURL {
            result = try? await GatewayAPI.postAudio(
                credential: credential,
                path: "/watch/reply-voice",
                query: [
                    URLQueryItem(name: "session", value: sessionId),
                    URLQueryItem(name: "epoch", value: String(runtimeEpoch)),
                ],
                fileURL: promptAudioURL
            )
        } else {
            step = .confirm
            return
        }
        if result?.delivered == true {
            await finish("Prompt iletildi")
        } else {
            Haptics.failed()
            step = .promptStuck(sessionId: sessionId, runtimeEpoch: runtimeEpoch)
        }
    }

    private func finish(_ message: String) async {
        Haptics.delivered()
        cleanupPrompt()
        step = .done(message)
        try? await Task.sleep(for: .seconds(1.1))
        dismiss()
    }
}
