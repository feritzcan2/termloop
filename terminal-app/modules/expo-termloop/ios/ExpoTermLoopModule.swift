import ExpoModulesCore
import Foundation
import Network

public class ExpoTermLoopModule: Module {
  private var connections: [String: NWConnection] = [:]
  private var buffers: [String: Data] = [:]
  private let stateQueue = DispatchQueue(label: "expo.termloop.state")
  private let ioQueue = DispatchQueue(label: "expo.termloop.io", qos: .userInitiated)
  private static let newline: UInt8 = 0x0A

  public func definition() -> ModuleDefinition {
    Name("ExpoTermLoop")

    Events("onMessage", "onState", "onDisconnect")

    AsyncFunction("connect") { (host: String, port: Int) -> String in
      guard port > 0 && port <= 65535 else {
        throw TermLoopError.invalidArgument("port must be in 1..65535")
      }
      guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else {
        throw TermLoopError.invalidArgument("invalid port")
      }

      let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: nwPort)
      let parameters: NWParameters = .tcp
      let connection = NWConnection(to: endpoint, using: parameters)

      let sessionId = UUID().uuidString
      self.stateQueue.sync {
        self.connections[sessionId] = connection
        self.buffers[sessionId] = Data()
      }

      return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
        var hasResumed = false
        let resumeLock = NSLock()
        func resumeOnce(_ block: () -> Void) {
          resumeLock.lock(); defer { resumeLock.unlock() }
          if hasResumed { return }
          hasResumed = true
          block()
        }

        connection.stateUpdateHandler = { [weak self] newState in
          guard let self = self else { return }
          switch newState {
          case .ready:
            self.emitState(sessionId: sessionId, state: "ready", error: nil)
            resumeOnce { continuation.resume(returning: sessionId) }
            self.startReceive(sessionId: sessionId, connection: connection)
          case .failed(let err):
            self.emitState(sessionId: sessionId, state: "failed", error: err.localizedDescription)
            self.emitDisconnect(sessionId: sessionId, error: err.localizedDescription)
            self.cleanup(sessionId: sessionId)
            resumeOnce { continuation.resume(throwing: TermLoopError.connectionFailed(err.localizedDescription)) }
          case .cancelled:
            self.emitState(sessionId: sessionId, state: "cancelled", error: nil)
            self.emitDisconnect(sessionId: sessionId, error: nil)
            self.cleanup(sessionId: sessionId)
            resumeOnce { continuation.resume(throwing: TermLoopError.connectionFailed("cancelled before ready")) }
          case .waiting(let err):
            self.emitState(sessionId: sessionId, state: "failed", error: err.localizedDescription)
          default:
            break
          }
        }

        connection.start(queue: self.ioQueue)
      }
    }

    AsyncFunction("send") { (sessionId: String, line: String) in
      let connection: NWConnection? = self.stateQueue.sync { self.connections[sessionId] }
      guard let connection = connection else {
        throw TermLoopError.noSession("no session \(sessionId)")
      }
      var payload = Data(line.utf8)
      if payload.last != Self.newline {
        payload.append(Self.newline)
      }
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        connection.send(content: payload, completion: .contentProcessed { error in
          if let error = error {
            continuation.resume(throwing: TermLoopError.writeFailed(error.localizedDescription))
          } else {
            continuation.resume()
          }
        })
      }
    }

    AsyncFunction("disconnect") { (sessionId: String) in
      let connection: NWConnection? = self.stateQueue.sync { self.connections[sessionId] }
      connection?.cancel()
      self.cleanup(sessionId: sessionId)
    }
  }

  private func startReceive(sessionId: String, connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
      guard let self = self else { return }

      if let data = data, !data.isEmpty {
        self.appendAndEmit(sessionId: sessionId, chunk: data)
      }

      if let error = error {
        self.emitDisconnect(sessionId: sessionId, error: error.localizedDescription)
        self.cleanup(sessionId: sessionId)
        return
      }

      if isComplete {
        self.emitDisconnect(sessionId: sessionId, error: nil)
        self.cleanup(sessionId: sessionId)
        return
      }

      self.startReceive(sessionId: sessionId, connection: connection)
    }
  }

  private func appendAndEmit(sessionId: String, chunk: Data) {
    let lines: [String] = self.stateQueue.sync {
      guard var buffer = self.buffers[sessionId] else { return [] }
      buffer.append(chunk)
      var out: [String] = []
      while let nlIndex = buffer.firstIndex(of: Self.newline) {
        let lineData = buffer.subdata(in: buffer.startIndex..<nlIndex)
        buffer.removeSubrange(buffer.startIndex...nlIndex)
        if let text = String(data: lineData, encoding: .utf8), !text.isEmpty {
          out.append(text)
        }
      }
      self.buffers[sessionId] = buffer
      return out
    }
    for line in lines {
      self.emitMessage(sessionId: sessionId, line: line)
    }
  }

  private func cleanup(sessionId: String) {
    self.stateQueue.sync {
      self.connections.removeValue(forKey: sessionId)
      self.buffers.removeValue(forKey: sessionId)
    }
  }

  fileprivate func emitMessage(sessionId: String, line: String) {
    self.sendEvent("onMessage", [
      "sessionId": sessionId,
      "line": line,
    ])
  }

  fileprivate func emitState(sessionId: String, state: String, error: String?) {
    self.sendEvent("onState", [
      "sessionId": sessionId,
      "state": state,
      "error": error as Any,
    ])
  }

  fileprivate func emitDisconnect(sessionId: String, error: String?) {
    self.sendEvent("onDisconnect", [
      "sessionId": sessionId,
      "error": error as Any,
    ])
  }
}

enum TermLoopError: Error, CustomStringConvertible, LocalizedError {
  case invalidArgument(String)
  case connectionFailed(String)
  case writeFailed(String)
  case noSession(String)

  var description: String {
    switch self {
    case .invalidArgument(let msg),
         .connectionFailed(let msg),
         .writeFailed(let msg),
         .noSession(let msg):
      return msg
    }
  }

  var errorDescription: String? { description }
}
