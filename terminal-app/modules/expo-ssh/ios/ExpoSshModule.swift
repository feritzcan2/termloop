import ExpoModulesCore
import Citadel
import NIO
import NIOCore
@preconcurrency import NIOSSH
import NIOTransportServices
import Crypto
import Foundation

public class ExpoSshModule: Module {
  private var clients: [String: SSHClient] = [:]
  private var channels: [String: Channel] = [:]
  private var writers: [String: TTYStdinWriter] = [:]
  private var shellTasks: [String: Task<Void, Never>] = [:]
  private let stateQueue = DispatchQueue(label: "expo.ssh.state")
  private let nioGroup = NIOTSEventLoopGroup(loopCount: 1)

  public func definition() -> ModuleDefinition {
    Name("ExpoSsh")

    Events("onShellData", "onDisconnect")

    AsyncFunction("connect") {
      (host: String, port: Int, username: String, password: String, privateKey: String) -> String in

      let authMethod: SSHAuthenticationMethod
      if !privateKey.isEmpty {
        do {
          let rsa = try Insecure.RSA.PrivateKey(sshRsa: privateKey)
          authMethod = .rsa(username: username, privateKey: rsa)
        } catch {
          throw SshError.authFailed("Failed to parse private key: \(error.localizedDescription)")
        }
      } else {
        authMethod = .passwordBased(username: username, password: password)
      }

      let client: SSHClient
      let connectedChannel: Channel
      do {
        let bootstrap = NIOTSConnectionBootstrap(group: self.nioGroup)
          .connectTimeout(.seconds(30))
        connectedChannel = try await bootstrap.connect(host: host, port: port).get()

        var settings = SSHClientSettings(
          host: host,
          port: port,
          authenticationMethod: { authMethod },
          hostKeyValidator: .acceptAnything()
        )
        settings.group = self.nioGroup
        settings.connectTimeout = .seconds(30)
        client = try await SSHClient.connect(on: connectedChannel, settings: settings)
      } catch {
        throw SshError.connectionFailed("Could not connect to \(host):\(port) — \(error.localizedDescription)")
      }

      let sessionId = UUID().uuidString
      self.stateQueue.sync {
        self.clients[sessionId] = client
        self.channels[sessionId] = connectedChannel
      }
      return sessionId
    }

    AsyncFunction("startShell") { (sessionId: String, termType: String, cols: Int, rows: Int) in
      let client: SSHClient? = self.stateQueue.sync { self.clients[sessionId] }
      guard let client = client else {
        throw SshError.noSession("No session with id \(sessionId)")
      }

      let (writerStream, writerContinuation) = AsyncStream<TTYStdinWriter>.makeStream()

      let task = Task<Void, Never> { [weak self] in
        do {
          try await client.withPTY(
            SSHChannelRequestEvent.PseudoTerminalRequest(
              wantReply: true,
              term: termType,
              terminalCharacterWidth: cols,
              terminalRowHeight: rows,
              terminalPixelWidth: 0,
              terminalPixelHeight: 0,
              terminalModes: SSHTerminalModes([.ECHO: 1])
            )
          ) { inbound, outbound in
            writerContinuation.yield(outbound)
            writerContinuation.finish()

            for try await event in inbound {
              guard let self = self else { break }
              switch event {
              case .stdout(var buffer), .stderr(var buffer):
                if let bytes = buffer.readBytes(length: buffer.readableBytes) {
                  let text = String(decoding: bytes, as: UTF8.self)
                  self.emitShellData(sessionId: sessionId, data: text)
                }
              }
            }
          }
          self?.emitDisconnect(sessionId: sessionId, error: nil)
        } catch {
          writerContinuation.finish()
          self?.emitDisconnect(sessionId: sessionId, error: error.localizedDescription)
        }
      }

      self.stateQueue.sync { self.shellTasks[sessionId] = task }

      var iterator = writerStream.makeAsyncIterator()
      guard let writer = await iterator.next() else {
        throw SshError.connectionFailed("Shell closed before writer became available")
      }
      self.stateQueue.sync { self.writers[sessionId] = writer }
    }

    AsyncFunction("writeToShell") { (sessionId: String, data: String) in
      let writer: TTYStdinWriter? = self.stateQueue.sync { self.writers[sessionId] }
      guard let writer = writer else {
        throw SshError.noSession("No shell for session \(sessionId)")
      }
      var buffer = ByteBufferAllocator().buffer(capacity: data.utf8.count)
      buffer.writeString(data)
      try await writer.write(buffer)
    }

    AsyncFunction("resizeShell") { (sessionId: String, cols: Int, rows: Int) in
      let writer: TTYStdinWriter? = self.stateQueue.sync { self.writers[sessionId] }
      guard let writer = writer else { return }
      try await writer.changeSize(cols: cols, rows: rows, pixelWidth: 0, pixelHeight: 0)
    }

    AsyncFunction("closeShell") { (sessionId: String) in
      let task: Task<Void, Never>? = self.stateQueue.sync {
        let t = self.shellTasks[sessionId]
        self.shellTasks.removeValue(forKey: sessionId)
        self.writers.removeValue(forKey: sessionId)
        return t
      }
      task?.cancel()
    }

    AsyncFunction("disconnect") { (sessionId: String) in
      // Close the underlying channel rather than calling SSHClient.close().
      // SSHClient.close() can shut down the shared NIOTSEventLoopGroup, which trips a
      // NIO precondition (EXC_BREAKPOINT) and crashes the app. Closing the channel
      // tears down the SSH session at the transport level; ARC releases the SSHClient.
      let (task, channel): (Task<Void, Never>?, Channel?) = self.stateQueue.sync {
        let t = self.shellTasks[sessionId]
        let ch = self.channels[sessionId]
        self.shellTasks.removeValue(forKey: sessionId)
        self.writers.removeValue(forKey: sessionId)
        self.clients.removeValue(forKey: sessionId)
        self.channels.removeValue(forKey: sessionId)
        return (t, ch)
      }
      task?.cancel()
      if let channel = channel {
        // NIOTS channel methods must be invoked on the channel's event loop.
        // Hop explicitly to avoid `preconditionInEventLoop` traps.
        try? await channel.eventLoop.flatSubmit { channel.close() }.get()
      }
    }
  }

  fileprivate func emitShellData(sessionId: String, data: String) {
    self.sendEvent("onShellData", [
      "sessionId": sessionId,
      "data": data,
    ])
  }

  fileprivate func emitDisconnect(sessionId: String, error: String?) {
    self.sendEvent("onDisconnect", [
      "sessionId": sessionId,
      "error": error as Any,
    ])
  }
}

enum SshError: Error, CustomStringConvertible, LocalizedError {
  case connectionFailed(String)
  case authFailed(String)
  case noSession(String)

  var description: String {
    switch self {
    case .connectionFailed(let msg), .authFailed(let msg), .noSession(let msg):
      return msg
    }
  }

  var errorDescription: String? { description }
}
