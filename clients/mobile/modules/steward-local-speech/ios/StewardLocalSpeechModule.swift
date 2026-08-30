import AVFoundation
import ExpoModulesCore
import Foundation

public final class StewardLocalSpeechModule: Module {
  private var speaker: StewardLocalSpeaker?

  public func definition() -> ModuleDefinition {
    Name("StewardLocalSpeech")

    AsyncFunction("speak") { (text: String, promise: Promise) in
      Task { @MainActor in
        let speaker = self.speaker ?? StewardLocalSpeaker()
        self.speaker = speaker
        speaker.speak(text: text, promise: promise)
      }
    }

    Function("stop") {
      Task { @MainActor in
        self.speaker?.stop()
      }
    }
  }
}

@MainActor
private final class StewardLocalSpeaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var completion: Promise?
  private var currentUtterance: AVSpeechUtterance?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func speak(text: String, promise: Promise) {
    let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_500))
    guard !trimmed.isEmpty else {
      promise.resolve(false)
      return
    }
    stop()
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
      try session.setActive(true)
      completion = promise
      let utterance = AVSpeechUtterance(string: trimmed)
      utterance.voice = AVSpeechSynthesisVoice(language: "tr-TR")
      utterance.rate = 0.47
      utterance.pitchMultiplier = 0.98
      currentUtterance = utterance
      synthesizer.speak(utterance)
    } catch {
      promise.reject(error)
    }
  }

  func stop() {
    let waiting = completion
    completion = nil
    currentUtterance = nil
    if synthesizer.isSpeaking {
      synthesizer.stopSpeaking(at: .immediate)
    }
    waiting?.resolve(false)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finish(utterance: utterance, spoken: true) }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finish(utterance: utterance, spoken: false) }
  }

  private func finish(utterance: AVSpeechUtterance, spoken: Bool) {
    guard currentUtterance === utterance, let completion else { return }
    self.completion = nil
    currentUtterance = nil
    completion.resolve(spoken)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
