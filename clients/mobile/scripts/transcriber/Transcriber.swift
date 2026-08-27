import Foundation
import Speech

// Transcribes one recorded audio file with the Mac's own speech recognition and
// prints {"text": "..."} on stdout. On-device recognition is attempted first.
// Some installed Turkish models accept Watch AAC but return an empty final; in
// that exact case one network-capable Speech attempt keeps wrist dictation usable.
//
// Runs from inside a minimal signed .app bundle: speech recognition is a TCC
// permission and the bundle gives it a stable identity to grant.

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail(64, "usage: transcriber <audio-file> [locale]")
}
let audioURL = URL(fileURLWithPath: arguments[1])
let localeIdentifier = arguments.count >= 3 ? arguments[2] : "tr-TR"

guard FileManager.default.fileExists(atPath: audioURL.path) else {
    fail(66, "audio file not found: \(audioURL.path)")
}

func finish(text: String, onDevice: Bool) -> Never {
    let payload = (try? JSONSerialization.data(withJSONObject: [
        "text": text,
        "onDevice": onDevice,
    ])) ?? Data("{\"text\":\"\"}".utf8)
    FileHandle.standardOutput.write(payload)
    exit(0)
}

let authorizationSemaphore = DispatchSemaphore(value: 0)
var authorization = SFSpeechRecognizerAuthorizationStatus.notDetermined
SFSpeechRecognizer.requestAuthorization { status in
    authorization = status
    authorizationSemaphore.signal()
}
guard authorizationSemaphore.wait(timeout: .now() + 8) == .success else {
    fail(77, "speech recognition permission timed out")
}

guard authorization == .authorized else {
    fail(77, "speech recognition not authorized (status \(authorization.rawValue))")
}

struct RecognitionAttempt {
    let text: String
    let error: String?
}

/// Speech callbacks are delivered through the main run loop. Each attempt owns
/// a bounded loop so an empty on-device final can immediately fall through to
/// the network-capable recognizer without racing a process-wide watchdog.
func recognize(requiresOnDevice: Bool, timeout: TimeInterval) -> RecognitionAttempt {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
        return RecognitionAttempt(text: "", error: "no recognizer for locale \(localeIdentifier)")
    }
    guard recognizer.isAvailable else {
        return RecognitionAttempt(text: "", error: "recognizer unavailable for locale \(localeIdentifier)")
    }
    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = requiresOnDevice
    request.taskHint = .dictation

    var bestTranscript = ""
    var recognitionError: String?
    var finished = false
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result {
            bestTranscript = result.bestTranscription.formattedString
            if result.isFinal { finished = true }
        }
        if let error {
            recognitionError = error.localizedDescription
            finished = true
        }
    }
    let deadline = Date().addingTimeInterval(timeout)
    while !finished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    if !finished { task.cancel() }
    let text = bestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
    return RecognitionAttempt(
        text: text,
        error: finished ? recognitionError : "timed out"
    )
}

let capabilityProbe = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
if capabilityProbe?.supportsOnDeviceRecognition == true {
    let local = recognize(requiresOnDevice: true, timeout: 8)
    if !local.text.isEmpty { finish(text: local.text, onDevice: true) }
}

// `false` permits Apple's Speech service to select its working path. Report the
// result conservatively as non-on-device because the framework does not expose
// which path it ultimately selected.
let fallback = recognize(requiresOnDevice: false, timeout: 12)
if !fallback.text.isEmpty { finish(text: fallback.text, onDevice: false) }
if let error = fallback.error { fail(70, "transcription failed: \(error)") }
finish(text: "", onDevice: false)
