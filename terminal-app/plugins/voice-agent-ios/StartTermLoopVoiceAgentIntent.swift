import Foundation
import Network

#if canImport(AppIntents)
import AppIntents

@available(iOS 16.0, *)
struct StartTermLoopVoiceAgentIntent: AppIntent {
  static var title: LocalizedStringResource = "Start TermLoop Voice Agent"
  static var description = IntentDescription("Starts a new TermLoop agent in the current project without creating a worktree.")
  static var openAppWhenRun = false

  @Parameter(title: "Prompt")
  var prompt: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedPrompt.isEmpty else {
      throw TermLoopVoiceAgentIntentError.emptyPrompt
    }

    let config = try TermLoopVoiceAgentStore.load()
    let result = try await TermLoopVoiceAgentRunner.start(prompt: trimmedPrompt, config: config)
    return .result(dialog: "Started \(result.agentName) in TermLoop.")
  }
}

@available(iOS 16.0, *)
enum TermLoopVoiceAgentIntentError: Error, LocalizedError {
  case emptyPrompt

  var errorDescription: String? {
    switch self {
    case .emptyPrompt:
      return "Dictate a prompt before starting the agent."
    }
  }
}
#endif

struct TermLoopVoiceAgentStartResult {
  let agentName: String
}

enum TermLoopVoiceAgentRunner {
  private static let connectTimeoutSeconds: UInt64 = 4

  static func start(
    prompt: String,
    config: TermLoopVoiceAgentStore.Config
  ) async throws -> TermLoopVoiceAgentStartResult {
    var lastError: Error?
    for host in config.hostCandidates {
      let client = TermLoopRPCClient(host: host, port: config.port)
      do {
        try await client.connect(timeoutSeconds: connectTimeoutSeconds)
        defer { client.close() }

        if let deviceId = config.deviceId, let accessToken = config.accessToken {
          try validateAuthResult(try await client.call(
            method: "auth.token",
            params: ["device_id": deviceId, "access_token": accessToken]
          ))
        } else if let password = config.password {
          try validateAuthResult(try await client.call(method: "auth.login", params: ["password": password]))
        } else {
          throw TermLoopRPCError.missingAuth
        }

        let project = try await loadCurrentProject(client: client)
        let agent = try await loadAgent(client: client)
        var params: [String: Any] = [
          "title": "Voice Agent",
          "terminal_agent_id": agent.id,
          "prompt_text": prompt
        ]
        if let projectId = project.id {
          params["project_id"] = projectId
        }
        if let cwd = project.path {
          params["cwd"] = cwd
        }

        _ = try await client.call(method: "workspace.create", params: params)
        return TermLoopVoiceAgentStartResult(agentName: agent.displayName)
      } catch {
        lastError = error
        client.close()
      }
    }

    throw lastError ?? TermLoopRPCError.noReachableHost
  }

  private static func validateAuthResult(_ value: Any) throws {
    guard
      let payload = value as? [String: Any],
      payload["authenticated"] as? Bool == true
    else {
      throw TermLoopRPCError.authFailed
    }
  }

  private static func loadCurrentProject(
    client: TermLoopRPCClient
  ) async throws -> (id: String?, path: String?) {
    let value = try await client.call(method: "project.current", params: nil)
    guard let project = value as? [String: Any] else {
      return (nil, nil)
    }
    let id = project["id"] as? String
    let path = (project["folder_path"] as? String) ?? (project["path"] as? String)
    return (id, path)
  }

  private static func loadAgent(
    client: TermLoopRPCClient
  ) async throws -> (id: String, displayName: String) {
    let value = try await client.call(method: "termloop.list_terminal_agents", params: nil)
    guard
      let payload = value as? [String: Any],
      let agents = payload["agents"] as? [[String: Any]],
      !agents.isEmpty
    else {
      throw TermLoopRPCError.noAgentAvailable
    }

    let selected = agents.first { agentMatchesCodex($0) } ?? agents[0]
    guard let id = selected["id"] as? String else {
      throw TermLoopRPCError.noAgentAvailable
    }
    let displayName = (selected["display_name"] as? String) ?? id
    return (id, displayName)
  }

  private static func agentMatchesCodex(_ agent: [String: Any]) -> Bool {
    let values = [
      agent["id"] as? String,
      agent["display_name"] as? String,
      agent["executable_name"] as? String
    ]
    return values.contains { value in
      value?.range(of: "codex", options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }
  }
}

enum TermLoopRPCError: Error, LocalizedError {
  case invalidPort
  case connectionFailed
  case connectionClosed
  case invalidResponse
  case rpcError(String)
  case authFailed
  case missingAuth
  case noAgentAvailable
  case noReachableHost

  var errorDescription: String? {
    switch self {
    case .invalidPort:
      return "Invalid TermLoop port."
    case .connectionFailed:
      return "Could not connect to TermLoop on your Mac."
    case .connectionClosed:
      return "TermLoop closed the connection."
    case .invalidResponse:
      return "TermLoop returned an invalid response."
    case .rpcError(let message):
      return message
    case .authFailed:
      return "TermLoop auth failed. Open TermLoop Mobile and reconnect before using the Watch shortcut."
    case .missingAuth:
      return "TermLoop Mobile has no saved auth for the Watch shortcut."
    case .noAgentAvailable:
      return "No terminal agents are available in TermLoop."
    case .noReachableHost:
      return "No saved TermLoop host was reachable."
    }
  }
}

final class TermLoopRPCClient {
  private let host: String
  private let port: UInt16
  private var connection: NWConnection?
  private var buffer = Data()
  private var nextId = 1

  init(host: String, port: UInt16) {
    self.host = host
    self.port = port
  }

  func connect(timeoutSeconds: UInt64) async throws {
    guard let nwPort = NWEndpoint.Port(rawValue: port) else {
      throw TermLoopRPCError.invalidPort
    }

    let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
    self.connection = connection

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      var resumed = false
      let lock = NSLock()
      let timeout = DispatchWorkItem {
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        resumed = true
        connection.cancel()
        continuation.resume(throwing: TermLoopRPCError.connectionFailed)
      }
      DispatchQueue.global(qos: .userInitiated).asyncAfter(
        deadline: .now() + .seconds(Int(timeoutSeconds)),
        execute: timeout
      )

      connection.stateUpdateHandler = { state in
        lock.lock()
        defer { lock.unlock() }
        guard !resumed else { return }
        switch state {
        case .ready:
          resumed = true
          timeout.cancel()
          continuation.resume()
        case .failed(let error):
          resumed = true
          timeout.cancel()
          continuation.resume(throwing: error)
        case .cancelled:
          resumed = true
          timeout.cancel()
          continuation.resume(throwing: TermLoopRPCError.connectionFailed)
        default:
          break
        }
      }
      connection.start(queue: .global(qos: .userInitiated))
    }
  }

  func close() {
    connection?.cancel()
    connection = nil
  }

  func call(method: String, params: [String: Any]?) async throws -> Any {
    let id = "watch-\(nextId)"
    nextId += 1

    var request: [String: Any] = ["id": id, "method": method]
    if let params {
      request["params"] = params
    }
    let data = try JSONSerialization.data(withJSONObject: request) + Data([0x0A])
    try await send(data)

    while true {
      let line = try await receiveLine()
      guard
        let object = try JSONSerialization.jsonObject(with: line) as? [String: Any],
        object["id"] as? String == id
      else {
        continue
      }

      if object["ok"] as? Bool == true {
        return object["result"] as Any
      }

      let error = object["error"] as? [String: Any]
      let message = (error?["message"] as? String) ?? "TermLoop RPC failed."
      throw TermLoopRPCError.rpcError(message)
    }
  }

  private func send(_ data: Data) async throws {
    guard let connection else { throw TermLoopRPCError.connectionClosed }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      connection.send(content: data, completion: .contentProcessed { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      })
    }
  }

  private func receiveLine() async throws -> Data {
    while true {
      if let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer[..<newline]
        buffer.removeSubrange(...newline)
        return Data(line)
      }

      let chunk = try await receiveChunk()
      guard !chunk.isEmpty else {
        throw TermLoopRPCError.connectionClosed
      }
      buffer.append(chunk)
    }
  }

  private func receiveChunk() async throws -> Data {
    guard let connection else { throw TermLoopRPCError.connectionClosed }
    return try await withCheckedThrowingContinuation { continuation in
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let data {
          continuation.resume(returning: data)
        } else if isComplete {
          continuation.resume(returning: Data())
        } else {
          continuation.resume(throwing: TermLoopRPCError.invalidResponse)
        }
      }
    }
  }
}
