package expo.modules.ssh

import com.jcraft.jsch.ChannelShell
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.Properties

class ExpoSshModule : Module() {
  private val sessions = mutableMapOf<String, Session>()
  private val channels = mutableMapOf<String, ChannelShell>()
  private val outputStreams = mutableMapOf<String, OutputStream>()
  private val readThreads = mutableMapOf<String, Thread>()

  override fun definition() = ModuleDefinition {
    Name("ExpoSsh")

    Events("onShellData", "onDisconnect")

    AsyncFunction("connect") {
        host: String, port: Int, username: String, password: String, privateKey: String ->

      val jsch = JSch()

      if (privateKey.isNotEmpty()) {
        jsch.addIdentity("key", privateKey.toByteArray(), null,
          if (password.isNotEmpty()) password.toByteArray() else null)
      }

      val session = jsch.getSession(username, host, port)

      if (privateKey.isEmpty() && password.isNotEmpty()) {
        session.setPassword(password)
      }

      val config = Properties()
      config["StrictHostKeyChecking"] = "no"
      session.setConfig(config)
      session.timeout = 10000
      session.connect()

      val sessionId = UUID.randomUUID().toString()
      sessions[sessionId] = session
      sessionId
    }

    AsyncFunction("startShell") { sessionId: String, termType: String, cols: Int, rows: Int ->
      val session = sessions[sessionId]
        ?: throw CodedException("SSH_ERROR", "No session with id $sessionId", null)

      val channel = session.openChannel("shell") as ChannelShell
      channel.setPtyType(termType, cols, rows, 0, 0)
      channel.connect()

      channels[sessionId] = channel
      outputStreams[sessionId] = channel.outputStream

      val inputStream = channel.inputStream
      val thread = Thread {
        readLoop(sessionId, inputStream)
      }
      thread.name = "ssh-read-$sessionId"
      readThreads[sessionId] = thread
      thread.start()
    }

    AsyncFunction("writeToShell") { sessionId: String, data: String ->
      val os = outputStreams[sessionId]
        ?: throw CodedException("SSH_ERROR", "No shell for session $sessionId", null)
      os.write(data.toByteArray())
      os.flush()
    }

    AsyncFunction("resizeShell") { sessionId: String, cols: Int, rows: Int ->
      val channel = channels[sessionId]
        ?: throw CodedException("SSH_ERROR", "No shell for session $sessionId", null)
      channel.setPtySize(cols, rows, 0, 0)
    }

    AsyncFunction("closeShell") { sessionId: String ->
      readThreads[sessionId]?.interrupt()
      readThreads.remove(sessionId)
      channels[sessionId]?.disconnect()
      channels.remove(sessionId)
      outputStreams.remove(sessionId)
    }

    AsyncFunction("disconnect") { sessionId: String ->
      readThreads[sessionId]?.interrupt()
      readThreads.remove(sessionId)
      channels[sessionId]?.disconnect()
      channels.remove(sessionId)
      outputStreams.remove(sessionId)
      sessions[sessionId]?.disconnect()
      sessions.remove(sessionId)
    }
  }

  private fun readLoop(sessionId: String, inputStream: InputStream) {
    val buffer = ByteArray(4096)
    try {
      while (!Thread.currentThread().isInterrupted) {
        val available = inputStream.available()
        if (available > 0) {
          val bytesRead = inputStream.read(buffer, 0, minOf(available, buffer.size))
          if (bytesRead > 0) {
            val data = String(buffer, 0, bytesRead)
            sendEvent("onShellData", mapOf(
              "sessionId" to sessionId,
              "data" to data
            ))
          }
        } else {
          Thread.sleep(10)
        }
      }
    } catch (e: InterruptedException) {
      // Thread interrupted, exit cleanly
    } catch (e: Exception) {
      sendEvent("onDisconnect", mapOf(
        "sessionId" to sessionId,
        "error" to (e.message ?: "Unknown error")
      ))
    }
  }
}
