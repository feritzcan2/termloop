import ExpoModulesCore
import WatchConnectivity

private final class WatchCredentialRecord: Record {
  @Field var connectionId: String = ""
  @Field var name: String = ""
  @Field var host: String = ""
  @Field var token: String = ""
  @Field var targetProjectId: String?
}

public class WatchSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WatchSync")

    AsyncFunction("syncCredentials") {
      (credentials: [WatchCredentialRecord], activeConnectionIds: [String], promise: Promise) in
      let refreshed = credentials.compactMap(WatchCredential.init(record:))
      WatchSyncBridge.shared.sync(
        refreshed: refreshed,
        activeConnectionIds: Set(activeConnectionIds.filter(WatchCredential.validConnectionId))
      ) { delivered in
        promise.resolve(delivered)
      }
    }
  }
}

private struct WatchCredential {
  let connectionId: String
  let name: String
  let host: String
  let token: String
  let targetProjectId: String?

  init?(record: WatchCredentialRecord) {
    guard Self.validConnectionId(record.connectionId),
          !record.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !record.host.isEmpty,
          record.token.count >= 16
    else { return nil }
    connectionId = record.connectionId
    name = String(record.name.prefix(120))
    host = record.host
    token = record.token
    targetProjectId = record.targetProjectId
  }

  init?(dictionary: [String: Any]) {
    guard let connectionId = dictionary["connectionId"] as? String,
          let name = dictionary["name"] as? String,
          let host = dictionary["host"] as? String,
          let token = dictionary["watchToken"] as? String,
          Self.validConnectionId(connectionId), !name.isEmpty, !host.isEmpty, token.count >= 16
    else { return nil }
    self.connectionId = connectionId
    self.name = String(name.prefix(120))
    self.host = host
    self.token = token
    targetProjectId = dictionary["targetProjectId"] as? String
  }

  var dictionary: [String: Any] {
    var value: [String: Any] = [
      "connectionId": connectionId,
      "name": name,
      "host": host,
      "watchToken": token,
    ]
    if let targetProjectId { value["targetProjectId"] = targetProjectId }
    return value
  }

  static func validConnectionId(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil
  }
}

/// `applicationContext` is one durable latest-state snapshot. Every update
/// merges newly refreshed credentials with the last snapshot, retains saved
/// Macs that are temporarily offline, and removes connections deleted on the
/// phone. Watch tokens never enter UserDefaults or logs.
private final class WatchSyncBridge: NSObject, WCSessionDelegate {
  static let shared = WatchSyncBridge()

  private let queue = DispatchQueue(label: "ai.termloop.watch-sync")
  private var pending: [(refreshed: [WatchCredential], activeIds: Set<String>, completion: (Bool) -> Void)] = []

  func sync(
    refreshed: [WatchCredential],
    activeConnectionIds: Set<String>,
    completion: @escaping (Bool) -> Void
  ) {
    guard WCSession.isSupported() else {
      completion(false)
      return
    }
    queue.async {
      let session = WCSession.default
      session.delegate = self
      if session.activationState == .activated {
        completion(self.deliver(refreshed: refreshed, activeIds: activeConnectionIds, session: session))
      } else {
        self.pending.append((refreshed, activeConnectionIds, completion))
        session.activate()
      }
    }
  }

  private func deliver(
    refreshed: [WatchCredential],
    activeIds: Set<String>,
    session: WCSession
  ) -> Bool {
    guard session.isPaired, session.isWatchAppInstalled else { return false }
    var merged: [String: WatchCredential] = [:]
    let previous = session.applicationContext["connections"] as? [[String: Any]] ?? []
    for dictionary in previous {
      guard let credential = WatchCredential(dictionary: dictionary),
            activeIds.contains(credential.connectionId)
      else { continue }
      merged[credential.connectionId] = credential
    }
    for credential in refreshed where activeIds.contains(credential.connectionId) {
      merged[credential.connectionId] = credential
    }
    let snapshot = merged.values
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      .prefix(16)
      .map(\.dictionary)
    do {
      try session.updateApplicationContext(["version": 2, "connections": Array(snapshot)])
      return true
    } catch {
      return false
    }
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    queue.async {
      let waiting = self.pending
      self.pending = []
      for item in waiting {
        let delivered = activationState == .activated && self.deliver(
          refreshed: item.refreshed,
          activeIds: item.activeIds,
          session: session
        )
        item.completion(delivered)
      }
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }
}
