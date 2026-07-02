import AVFoundation
import Foundation
import Speech

@objc(TermLoopVoiceDictation)
class TermLoopVoiceDictation: NSObject {
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var committedTranscript = ""
  private var latestPartialTranscript = ""
  private var recording = false
  private var tapInstalled = false

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  @objc(start:rejecter:)
  func start(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      if self.recording {
        resolve(true)
        return
      }

      self.requestPermissions { allowed in
        DispatchQueue.main.async {
          guard allowed else {
            reject("voice_dictation_permission_denied", "Microphone and speech recognition permission are required.", nil)
            return
          }

          do {
            try self.startRecording()
            resolve(true)
          } catch {
            self.cleanup(cancelTask: true)
            reject("voice_dictation_start_failed", error.localizedDescription, error)
          }
        }
      }
    }
  }

  @objc(stop:rejecter:)
  func stop(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let text = self.currentTranscript()
      self.cleanup(cancelTask: false)
      resolve(["text": text])
    }
  }

  @objc(cancel:rejecter:)
  func cancel(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      self.cleanup(cancelTask: true)
      resolve(true)
    }
  }

  private func requestPermissions(_ completion: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
      guard speechStatus == .authorized else {
        completion(false)
        return
      }

      AVAudioSession.sharedInstance().requestRecordPermission { micAllowed in
        completion(micAllowed)
      }
    }
  }

  private func startRecording() throws {
    cleanup(cancelTask: true)
    committedTranscript = ""
    latestPartialTranscript = ""

    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    try startRecognitionTask()
    audioEngine.prepare()
    try audioEngine.start()
    recording = true
  }

  private func startRecognitionTask() throws {
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
      throw VoiceDictationError.speechUnavailable
    }

    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest?.endAudio()
    recognitionRequest = nil

    if tapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }

    latestPartialTranscript = ""
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if #available(iOS 16.0, *) {
      request.addsPunctuation = true
    }
    if #available(iOS 13.0, *), recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }
    recognitionRequest = request

    let inputNode = audioEngine.inputNode
    let recordingFormat = inputNode.outputFormat(forBus: 0)
    guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
      throw VoiceDictationError.invalidInputFormat
    }
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true

    recognitionTask = recognizer.recognitionTask(with: request) { result, _ in
      DispatchQueue.main.async {
        if let result {
          self.latestPartialTranscript = result.bestTranscription.formattedString
          if result.isFinal {
            self.commitLatestPartial()
          }
        }
      }
    }
  }

  private func commitLatestPartial() {
    let partial = latestPartialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !partial.isEmpty else { return }
    if committedTranscript.isEmpty {
      committedTranscript = partial
    } else if !committedTranscript.hasSuffix(partial) {
      committedTranscript += "\n" + partial
    }
    latestPartialTranscript = ""
  }

  private func currentTranscript() -> String {
    let partial = latestPartialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    if committedTranscript.isEmpty {
      return partial
    }
    if partial.isEmpty || committedTranscript.hasSuffix(partial) {
      return committedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return "\(committedTranscript)\n\(partial)".trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func cleanup(cancelTask: Bool) {
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    if tapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    recognitionRequest?.endAudio()
    if cancelTask {
      recognitionTask?.cancel()
    }
    recognitionTask = nil
    recognitionRequest = nil
    latestPartialTranscript = ""
    recording = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
enum VoiceDictationError: Error, LocalizedError {
  case speechUnavailable
  case invalidInputFormat

  var errorDescription: String? {
    switch self {
    case .speechUnavailable:
      return "Speech recognition is not available on this device."
    case .invalidInputFormat:
      return "Microphone input is not available."
    }
  }
}
