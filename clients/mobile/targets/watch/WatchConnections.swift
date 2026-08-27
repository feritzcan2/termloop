import Foundation
import Security
import SwiftUI
import WatchConnectivity

struct GatewayCredential: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let host: String
    let token: String
    let targetProjectId: String?

    var connection: GatewayConnection {
        GatewayConnection(id: id, name: name, host: host, targetProjectId: targetProjectId)
    }
}

struct GatewayConnection: Equatable, Hashable, Identifiable {
    let id: String
    let name: String
    let host: String
    let targetProjectId: String?
}

struct WatchProjectTarget: Codable, Equatable, Hashable {
    let connectionId: String
    let projectId: String
}

struct PendingWorktreeTarget: Equatable {
    let connectionId: String?
    let cwd: String
}

struct PendingAgentAttentionTarget: Equatable, Hashable {
    let connectionId: String?
    let sessionId: String
    let runtimeEpoch: Int
    let projectId: String?
    let cwd: String?
    let title: String
    let message: String
}

enum WatchSelectionStore {
    private static let chatConnectionKey = "chatConnectionId"
    private static let chatProjectKey = "chatProjectId"

    static var chatTarget: WatchProjectTarget? {
        get {
            let defaults = UserDefaults.standard
            guard let connectionId = defaults.string(forKey: chatConnectionKey), !connectionId.isEmpty,
                  let projectId = defaults.string(forKey: chatProjectKey), !projectId.isEmpty
            else { return nil }
            return WatchProjectTarget(connectionId: connectionId, projectId: projectId)
        }
        set {
            let defaults = UserDefaults.standard
            defaults.set(newValue?.connectionId, forKey: chatConnectionKey)
            defaults.set(newValue?.projectId, forKey: chatProjectKey)
        }
    }
}

// The complete multi-Mac credential catalog is one Keychain item. Views only
// observe non-secret GatewayConnection metadata and resolve a token at the
// exact request boundary.
enum CredentialStore {
    static let accessGroup = "S9QXLS2NJ2.ai.termloop.watch.shared"
    private static let service = "ai.termloop.watch.gateway"
    private static let account = "gateway"

    static func loadAll() -> [GatewayCredential] {
        guard let data = readData() else { return [] }
        if let current = try? JSONDecoder().decode([GatewayCredential].self, from: data) {
            return valid(current)
        }
        // One-time migration from the original single-Mac dictionary.
        guard let legacy = try? JSONDecoder().decode([String: String].self, from: data),
              let host = legacy["host"], !host.isEmpty,
              let token = legacy["token"], !token.isEmpty
        else { return [] }
        let migrated = GatewayCredential(
            id: "legacy",
            name: host.split(separator: ".").first.map(String.init) ?? "Mac",
            host: host,
            token: token,
            targetProjectId: UserDefaults.standard.string(forKey: "chatProjectId")
        )
        saveAll([migrated])
        return [migrated]
    }

    static func credential(id: String) -> GatewayCredential? {
        loadAll().first { $0.id == id }
    }

    static func preferred() -> GatewayCredential? {
        if let selected = WatchSelectionStore.chatTarget,
           let credential = credential(id: selected.connectionId) {
            return credential
        }
        return loadAll().first
    }

    static func saveAll(_ credentials: [GatewayCredential]) {
        let bounded = valid(Array(credentials.prefix(16)))
        guard let data = try? JSONEncoder().encode(bounded) else { return }
        writeData(data)
    }

    static func upsert(_ credential: GatewayCredential) {
        var credentials = loadAll().filter { $0.id != credential.id }
        credentials.append(credential)
        saveAll(credentials.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
    }

    private static func valid(_ credentials: [GatewayCredential]) -> [GatewayCredential] {
        credentials.filter {
            $0.id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
                && !$0.name.isEmpty && !$0.host.isEmpty && $0.token.count >= 16
        }
    }

    private static func readData() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func writeData(_ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(insert as CFDictionary, nil)
    }
}

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published private(set) var connections = CredentialStore.loadAll().map(\.connection)
    @Published var pendingWorktree: PendingWorktreeTarget?
    @Published var pendingAgentAttention: PendingAgentAttentionTarget?
    @Published var pendingChatTarget: WatchProjectTarget?
    @Published var autoTalkRequested = false

    var hasConnections: Bool { !connections.isEmpty }

    func replaceCredentials(_ credentials: [GatewayCredential]) {
        CredentialStore.saveAll(credentials)
        connections = CredentialStore.loadAll().map(\.connection)
        PushRegistrar.syncIfPossible()
    }

    func upsertCredential(_ credential: GatewayCredential) {
        CredentialStore.upsert(credential)
        connections = CredentialStore.loadAll().map(\.connection)
        PushRegistrar.syncIfPossible()
    }
}

// Receives the complete latest-state connection snapshot from the paired
// iPhone. The old single-host payload remains readable during rollout.
final class PhoneSyncController: NSObject, WCSessionDelegate {
    static let shared = PhoneSyncController()

    func start() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        consume(context: session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        consume(context: applicationContext)
    }

    private func consume(context: [String: Any]) {
        if let dictionaries = context["connections"] as? [[String: Any]] {
            let credentials = dictionaries.compactMap(Self.credential(from:))
            Task { @MainActor in AppState.shared.replaceCredentials(credentials) }
            return
        }
        guard let host = context["host"] as? String, !host.isEmpty,
              let token = context["watchToken"] as? String, !token.isEmpty
        else { return }
        let projectId = context["chatProjectId"] as? String
        let credential = GatewayCredential(
            id: "legacy",
            name: host.split(separator: ".").first.map(String.init) ?? "Mac",
            host: host,
            token: token,
            targetProjectId: projectId
        )
        Task { @MainActor in AppState.shared.upsertCredential(credential) }
    }

    private static func credential(from value: [String: Any]) -> GatewayCredential? {
        guard let id = value["connectionId"] as? String,
              let name = value["name"] as? String,
              let host = value["host"] as? String,
              let token = value["watchToken"] as? String
        else { return nil }
        return GatewayCredential(
            id: id,
            name: name,
            host: host,
            token: token,
            targetProjectId: value["targetProjectId"] as? String
        )
    }
}
