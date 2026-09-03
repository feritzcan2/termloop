import AppIntents
import SwiftUI
import WatchKit
import UserNotifications

// The launcher is always voice-first, so the route carries no options.
struct ProjectAgentLauncherRoute: Hashable {}

struct AgentAttentionRoute: Hashable {
    let target: PendingAgentAttentionTarget
}

// The watch registers its own APNs token instead of relying on iPhone
// notification mirroring: watchOS does not reliably launch the companion app
// from a tapped forwarded notification, while direct watch delivery both opens
// the app on tap and suppresses the mirrored duplicate. Idempotent and retried
// on every activation because the launch-time attempt can race network
// readiness and credential arrival.
enum PushRegistrar {
    static func syncIfPossible() {
        guard let apnsToken = UserDefaults.standard.string(forKey: "apnsDeviceToken"), !apnsToken.isEmpty
        else { return }
        for credential in CredentialStore.loadAll() {
            guard let base = GatewayAPI.baseURL(host: credential.host),
                  let url = URL(string: base.absoluteString + "/push/register")
            else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
            request.httpBody = try? JSONEncoder().encode([
                "deviceToken": apnsToken,
                "environment": apnsEnvironment,
                "bundleId": Bundle.main.bundleIdentifier ?? "ai.termloop.mobile.watch",
            ])
            GatewayAPI.session.dataTask(with: request) { _, _, _ in }.resume()
        }
    }

    // TestFlight/App Store builds carry no embedded provisioning profile and use
    // the production APNs environment; development-signed installs embed a
    // profile whose aps-environment entitlement says development. The gateway
    // also retries the other APNs host on token mismatch, so a wrong guess
    // self-heals.
    private static var apnsEnvironment: String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let keyRange = text.range(of: "<key>aps-environment</key>")
        else { return "production" }
        let window = text[keyRange.upperBound...].prefix(120)
        return window.contains("<string>development</string>") ? "development" : "production"
    }
}

enum Haptics {
    static func delivered() { WKInterfaceDevice.current().play(.success) }
    static func failed() { WKInterfaceDevice.current().play(.failure) }
    static func reply() { WKInterfaceDevice.current().play(.notification) }
}

// SwiftUI offers no programmatic dictation, but the WatchKit root interface
// controller can still present the system text input sheet as the denied-mic
// fallback for one-off messages.
enum DictationPresenter {
    static func present(completion: @escaping (String?) -> Void) {
        guard let controller = WKApplication.shared().rootInterfaceController else {
            completion(nil)
            return
        }
        controller.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { results in
            completion(results?.first as? String)
        }
    }
}

final class AppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    static let agentCategory = "TERMLOOP_AGENT_ATTENTION"
    static let stewardCategory = "TERMLOOP_STEW_REPLY"
    static let stewardProposalCategory = "TERMLOOP_STEW_PROPOSAL"
    static let stewardSuggestionCategory = "TERMLOOP_STEW_SUGGESTION"

    func applicationDidFinishLaunching() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerNotificationCategories(center)
        PhoneSyncController.shared.start()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            // Register even if alerts were denied: the token is still issued.
            DispatchQueue.main.async {
                WKApplication.shared().registerForRemoteNotifications()
            }
        }
    }

    func applicationDidBecomeActive() {
        PushRegistrar.syncIfPossible()
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "apnsDeviceToken")
        PushRegistrar.syncIfPossible()
    }

    // Inline dictation straight from the notification: an agent question gets a
    // terminal reply, a Stew reply gets a follow-up chat message. Neither needs
    // the app opened.
    private func registerNotificationCategories(_ center: UNUserNotificationCenter) {
        let reply = UNTextInputNotificationAction(
            identifier: "TERMLOOP_REPLY",
            title: "Yanıtla",
            options: [],
            textInputButtonTitle: "Gönder",
            textInputPlaceholder: "Dikte et…"
        )
        let approve = UNNotificationAction(identifier: "TERMLOOP_APPROVE", title: "Onayla", options: [])
        let decline = UNNotificationAction(identifier: "TERMLOOP_DECLINE", title: "Şimdi değil", options: [])
        let accept = UNNotificationAction(identifier: "TERMLOOP_ACCEPT", title: "Uygula", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.agentCategory, actions: [reply], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.stewardCategory, actions: [reply], intentIdentifiers: []),
            UNNotificationCategory(
                identifier: Self.stewardProposalCategory,
                actions: [approve, decline, reply],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: Self.stewardSuggestionCategory,
                actions: [accept, reply],
                intentIdentifiers: []
            ),
        ])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let stewardActions = [
            "TERMLOOP_APPROVE": "approve",
            "TERMLOOP_DECLINE": "decline",
            "TERMLOOP_ACCEPT": "accept",
        ]
        if let action = stewardActions[response.actionIdentifier] {
            await deliverStewardAction(action: action, userInfo: userInfo)
            return
        }
        if let textResponse = response as? UNTextInputNotificationResponse,
           response.actionIdentifier == "TERMLOOP_REPLY" {
            await deliverInlineReply(text: textResponse.userText, userInfo: userInfo)
            return
        }
        // Default tap: a Stew reply opens the chat. Agent attention opens one
        // focused action page: voice reply first, with the notification's
        // bounded terminal excerpt and matching worktree changes one tap away.
        let connectionId = userInfo["connectionId"] as? String
        if let chatProjectId = userInfo["chatProjectId"] as? String, !chatProjectId.isEmpty,
           let connectionId {
            await MainActor.run {
                AppState.shared.pendingChatTarget = WatchProjectTarget(
                    connectionId: connectionId,
                    projectId: chatProjectId
                )
            }
        } else if let sessionId = userInfo["sessionId"] as? String,
                  let runtimeEpoch = Self.integer(userInfo["runtimeEpoch"]) {
            let content = response.notification.request.content
            await MainActor.run {
                AppState.shared.pendingAgentAttention = PendingAgentAttentionTarget(
                    connectionId: connectionId,
                    sessionId: sessionId,
                    runtimeEpoch: runtimeEpoch,
                    projectId: userInfo["projectId"] as? String,
                    cwd: userInfo["cwd"] as? String,
                    title: content.title,
                    message: content.body
                )
            }
        }
    }

    private static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        return (value as? NSNumber)?.intValue
    }

    private func deliverStewardAction(action: String, userInfo: [AnyHashable: Any]) async {
        guard let credential = credential(for: userInfo),
              let projectId = userInfo["chatProjectId"] as? String, !projectId.isEmpty,
              let messageId = userInfo["stewardMessageId"] as? String, !messageId.isEmpty
        else {
            Haptics.failed()
            return
        }
        let result: ChatSendResponse? = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/steward-action",
            body: StewardActionRequest(projectId: projectId, messageId: messageId, action: action)
        )
        result == nil ? Haptics.failed() : Haptics.delivered()
    }

    private func deliverInlineReply(text: String, userInfo: [AnyHashable: Any]) async {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        guard let credential = credential(for: userInfo) else {
            Haptics.failed()
            return
        }
        if let chatProjectId = userInfo["chatProjectId"] as? String, !chatProjectId.isEmpty {
            let sent: ChatSendResponse? = try? await GatewayAPI.post(
                credential: credential,
                path: "/watch/chat",
                body: ["projectId": chatProjectId, "content": content]
            )
            sent != nil ? Haptics.delivered() : Haptics.failed()
            return
        }
        guard let sessionId = userInfo["sessionId"] as? String,
              let runtimeEpoch = userInfo["runtimeEpoch"] as? Int
        else { return }
        let result: ReplyResponse? = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/reply",
            body: WatchReplyBody(sessionId: sessionId, runtimeEpoch: runtimeEpoch, text: content)
        )
        result?.delivered == true ? Haptics.delivered() : Haptics.failed()
    }

    private func credential(for userInfo: [AnyHashable: Any]) -> GatewayCredential? {
        if let connectionId = userInfo["connectionId"] as? String,
           let credential = CredentialStore.credential(id: connectionId) {
            return credential
        }
        return CredentialStore.preferred()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

// Assignable to the Ultra's Action Button via Shortcuts: one press opens the
// app straight into one bounded Steward voice message.
struct TalkToStewIntent: AppIntent {
    static let title: LocalizedStringResource = "Stew'a Sesli Mesaj"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppState.shared.pendingChatTarget = WatchSelectionStore.chatTarget
        AppState.shared.autoTalkRequested = true
        return .result()
    }
}

// The one-press voice path: the Action Button (or Siri) prompts for the
// message with the system dictation sheet and this sends it to the Steward
// without ever opening the app. The reply arrives as a push.
struct SendToStewIntent: AppIntent {
    static let title: LocalizedStringResource = "Stew'a Söyle"
    static let openAppWhenRun = false

    @Parameter(title: "Mesaj", requestValueDialog: "Stew'a ne söyleyeyim?")
    var message: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let content = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return .result(dialog: "Mesaj boştu.") }
        guard let credential = CredentialStore.preferred() else {
            return .result(dialog: "Önce iPhone'da TermLoop'u aç.")
        }
        var projectId = WatchSelectionStore.chatTarget?.connectionId == credential.id
            ? WatchSelectionStore.chatTarget?.projectId ?? ""
            : credential.targetProjectId ?? ""
        if projectId.isEmpty {
            let status = try? await GatewayAPI.fetch(
                StatusResponse.self,
                credential: credential,
                path: "/watch/status"
            )
            projectId = status?.projects.first?.id ?? ""
        }
        guard !projectId.isEmpty else { return .result(dialog: "TermLoop'a ulaşılamadı.") }
        let sent: ChatSendResponse? = try? await GatewayAPI.post(
            credential: credential,
            path: "/watch/chat",
            body: ["projectId": projectId, "content": content]
        )
        return .result(dialog: sent != nil ? "Stew'a iletildi — cevabı bildirimle gelecek." : "Gönderilemedi.")
    }
}

struct TermLoopShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendToStewIntent(),
            phrases: ["\(.applicationName) Stew'a söyle"],
            shortTitle: "Stew'a Söyle",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: TalkToStewIntent(),
            phrases: ["\(.applicationName) Stew'a sesli mesaj"],
            shortTitle: "Stew'a Mesaj",
            systemImageName: "mic.circle.fill"
        )
    }
}

@main
struct TermLoopWatchApp: App {
    @WKApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

// One obvious landing surface: all agents. Secondary tools are ordinary
// destinations rather than five swipe pages, so the Digital Crown and back
// gesture behave like a native watch app.
struct ContentView: View {
    @ObservedObject private var appState = AppState.shared
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if appState.hasConnections {
                    SessionsView()
                } else {
                    SetupView()
                }
            }
            .navigationDestination(for: UnifiedWorktree.self) { FileListView(worktree: $0) }
            .navigationDestination(for: PagerRoute.self) { DiffPagerView(route: $0) }
            .navigationDestination(for: ProjectAgentLauncherRoute.self) { _ in
                ProjectAgentLauncherView()
            }
            .navigationDestination(for: AgentAttentionRoute.self) { route in
                AgentAttentionView(target: route.target)
            }
            .navigationDestination(for: WatchDestination.self) { destination in
                switch destination {
                case .talk: ChatView(autoStart: true)
                case .chat: ChatView()
                case .tasks: TasksView()
                case .changes: WorktreesView(path: $path)
                case .connections: SetupView()
                }
            }
        }
        .onOpenURL { url in
            switch url.host {
            case "message", "talk":
                path = NavigationPath()
                path.append(WatchDestination.talk)
            case "launch-agent":
                path = NavigationPath()
                path.append(ProjectAgentLauncherRoute())
            default:
                return
            }
        }
        .onChange(of: appState.pendingWorktree) { _, newValue in
            if newValue != nil {
                path = NavigationPath()
                path.append(WatchDestination.changes)
            }
        }
        .onChange(of: appState.pendingAgentAttention) { _, newValue in
            openAgentAttention(newValue)
        }
        .onChange(of: appState.pendingChatTarget) { _, newValue in
            if newValue != nil {
                path = NavigationPath()
                path.append(WatchDestination.chat)
            }
        }
        .onAppear {
            if appState.pendingWorktree != nil { path.append(WatchDestination.changes) }
            openAgentAttention(appState.pendingAgentAttention)
            if appState.pendingChatTarget != nil { path.append(WatchDestination.chat) }
        }
    }

    private func openAgentAttention(_ target: PendingAgentAttentionTarget?) {
        guard let target else { return }
        appState.pendingAgentAttention = nil
        path = NavigationPath()
        path.append(AgentAttentionRoute(target: target))
    }
}
