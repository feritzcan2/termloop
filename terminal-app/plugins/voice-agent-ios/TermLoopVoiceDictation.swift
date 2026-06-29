import AVFoundation
import Foundation
import Speech

@objc(TermLoopVoiceDictation)
class TermLoopVoiceDictation: NSObject {
  private let audioEngine = AVAudioEngine()
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?
  private var latestTranscript = ""
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
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      let text = self.latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
      self.cleanup(cancelTask: false)
      resolve(["text": text])
    }
  }

  @objc(cancel:rejecter:)
  func cancel(
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
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
    latestTranscript = ""

    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
      throw VoiceDictationError.speechUnavailable
    }

    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    recognitionRequest = request

    let inputNode = audioEngine.inputNode
    let recordingFormat = inputNode.outputFormat(forBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
      request.append(buffer)
    }
    tapInstalled = true

    audioEngine.prepare()
    try audioEngine.start()
    recording = true

    recognitionTask = recognizer.recognitionTask(with: request) { result, error in
      if let result {
        self.latestTranscript = result.bestTranscription.formattedString
      }
      if error != nil || result?.isFinal == true {
        DispatchQueue.main.async {
          self.cleanup(cancelTask: false)
        }
      }
    }
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
    recording = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

enum VoiceDictationError: Error, LocalizedError {
  case speechUnavailable

  var errorDescription: String? {
    switch self {
    case .speechUnavailable:
      return "Speech recognition is not available on this device."
    }
  }
}
