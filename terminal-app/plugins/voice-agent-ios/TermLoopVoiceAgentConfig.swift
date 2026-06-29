import Foundation
import Security

enum TermLoopVoiceAgentStore {
  struct Config {
    let id: String
    let name: String
    let host: String
    let alternateHosts: [String]
    let port: UInt16
    let deviceId: String?
    let accessToken: String?
    let password: String?

    var hostCandidates: [String] {
      var out: [String] = []
      for value in [host] + alternateHosts {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty && !out.contains(trimmed) {
          out.append(trimmed)
        }
      }
      return out
    }
  }

  enum StoreError: Error, LocalizedError {
    case invalidConfig
    case missingConfig
    case keychain(OSStatus)

    var errorDescription: String? {
      switch self {
      case .invalidConfig:
        return "Invalid voice agent connection config."
      case .missingConfig:
        return "Open TermLoop Mobile once before using the Watch shortcut."
      case .keychain(let status):
        return "Keychain error \(status)."
      }
    }
  }

  private static let defaultsKey = "termloop.voice_agent.connection.v1"
  private static let keychainService = "ai.termloop.mobile.voice-agent"
  private static let tokenAccount = "access-token"
  private static let passwordAccount = "password"

  static func save(dictionary: NSDictionary) throws {
    guard
      let id = dictionary["id"] as? String,
      let name = dictionary["name"] as? String,
      let host = dictionary["host"] as? String,
      let portNumber = dictionary["port"] as? NSNumber
    else {
      throw StoreError.invalidConfig
    }

    let portValue = portNumber.uint16Value
    guard portValue > 0 else { throw StoreError.invalidConfig }

    let alternateHosts = (dictionary["alternateHosts"] as? [String]) ?? []
    let deviceId = dictionary["deviceId"] as? String
    let accessToken = dictionary["accessToken"] as? String
    let password = dictionary["password"] as? String

    var metadata: [String: Any] = [
      "id": id,
      "name": name,
      "host": host,
      "alternateHosts": alternateHosts,
      "port": Int(portValue)
    ]
    if let deviceId, !deviceId.isEmpty {
      metadata["deviceId"] = deviceId
    }

    UserDefaults.standard.set(metadata, forKey: defaultsKey)
    try writeSecret(account: tokenAccount, value: accessToken)
    try writeSecret(account: passwordAccount, value: password)
  }

  static func load() throws -> Config {
    guard
      let metadata = UserDefaults.standard.dictionary(forKey: defaultsKey),
      let id = metadata["id"] as? String,
      let name = metadata["name"] as? String,
      let host = metadata["host"] as? String,
      let port = metadata["port"] as? Int
    else {
      throw StoreError.missingConfig
    }

    return Config(
      id: id,
      name: name,
      host: host,
      alternateHosts: (metadata["alternateHosts"] as? [String]) ?? [],
      port: UInt16(port),
      deviceId: metadata["deviceId"] as? String,
      accessToken: try readSecret(account: tokenAccount),
      password: try readSecret(account: passwordAccount)
    )
  }

  static func clear(connectionId: String?) throws {
    if let connectionId,
       let metadata = UserDefaults.standard.dictionary(forKey: defaultsKey),
       let storedId = metadata["id"] as? String,
       storedId != connectionId {
      return
    }

    UserDefaults.standard.removeObject(forKey: defaultsKey)
    try writeSecret(account: tokenAccount, value: nil)
    try writeSecret(account: passwordAccount, value: nil)
  }

  private static func readSecret(account: String) throws -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw StoreError.keychain(status) }
    guard let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private static func writeSecret(account: String, value: String?) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: account
    ]

    SecItemDelete(query as CFDictionary)
    guard let value, !value.isEmpty else { return }
    let attrs: [String: Any] = query.merging([
      kSecValueData as String: Data(value.utf8),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]) { _, new in new }
    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else { throw StoreError.keychain(status) }
  }
}

@objc(TermLoopVoiceAgentConfig)
class TermLoopVoiceAgentConfig: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(saveConnection:resolver:rejecter:)
  func saveConnection(
    _ config: NSDictionary,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try TermLoopVoiceAgentStore.save(dictionary: config)
      resolve(true)
    } catch {
      reject("voice_agent_config_failed", error.localizedDescription, error)
    }
  }

  @objc(clearConnection:resolver:rejecter:)
  func clearConnection(
    _ connectionId: NSString?,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try TermLoopVoiceAgentStore.clear(connectionId: connectionId as String?)
      resolve(true)
    } catch {
      reject("voice_agent_clear_failed", error.localizedDescription, error)
    }
  }
}
