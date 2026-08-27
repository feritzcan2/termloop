import AVFoundation
import SwiftUI
import WatchKit

// Records straight from the wrist mic instead of going through the system
// dictation sheet: one tap starts listening, falling silent ends it, and the
// recording is transcribed by the paired Mac's own on-device speech
// recognition. That removes the sheet and its confirm button from the path —
// tap, speak, done.
@MainActor
final class VoiceRecorder: NSObject, ObservableObject {
    enum Phase: Equatable {
        case idle
        case listening
        case transcribing
        case denied
    }

    @Published private(set) var phase = Phase.idle
    /// Smoothed 0…1 mic level driving the listening ring.
    @Published private(set) var level = 0.0

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var fileURL: URL?
    private var completion: ((URL?) -> Void)?
    private var elapsedTicks = 0
    private var silentTicks = 0
    private var heardSpeech = false

    private let tick = 0.1
    private let speechThresholdDb: Float = -32
    private let silenceTicksToStop = 20   // 2s of quiet ends and sends the take
    private let maximumTicks = 600        // 60s ceiling

    var isBusy: Bool { phase == .listening || phase == .transcribing }

    func begin(_ completion: @escaping (URL?) -> Void) {
        guard phase == .idle || phase == .denied else { return }
        self.completion = completion
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    self.phase = .denied
                    self.completion?(nil)
                    self.completion = nil
                    return
                }
                self.startRecording()
            }
        }
    }

    /// Manual stop: the same finish path the silence detector takes.
    func finish() {
        guard phase == .listening else { return }
        stopRecording(deliver: heardSpeech)
    }

    func cancel() {
        stopRecording(deliver: false)
        phase = .idle
    }

    func markTranscribed() {
        phase = .idle
        level = 0
    }

    private func startRecording() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
        } catch {
            phase = .idle
            completion?(nil)
            completion = nil
            return
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("stew-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        guard let recorder = try? AVAudioRecorder(url: url, settings: settings) else {
            phase = .idle
            completion?(nil)
            completion = nil
            return
        }
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            phase = .idle
            completion?(nil)
            completion = nil
            return
        }
        self.recorder = recorder
        fileURL = url
        elapsedTicks = 0
        silentTicks = 0
        heardSpeech = false
        level = 0
        phase = .listening
        WKInterfaceDevice.current().play(.start)
        meterTimer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleMeter() }
        }
    }

    private func sampleMeter() {
        guard phase == .listening, let recorder else { return }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0)
        // -50 dB reads as silence, 0 dB as full scale; the ring wants 0…1.
        level = Double(max(0, min(1, (power + 50) / 50)))
        elapsedTicks += 1
        if power > speechThresholdDb {
            heardSpeech = true
            silentTicks = 0
        } else if heardSpeech {
            silentTicks += 1
        }
        if elapsedTicks >= maximumTicks || (heardSpeech && silentTicks >= silenceTicksToStop) {
            stopRecording(deliver: heardSpeech)
        }
    }

    private func stopRecording(deliver: Bool) {
        meterTimer?.invalidate()
        meterTimer = nil
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        level = 0
        let url = fileURL
        fileURL = nil
        let handler = completion
        completion = nil
        if deliver, let url {
            phase = .transcribing
            WKInterfaceDevice.current().play(.stop)
            handler?(url)
        } else {
            phase = .idle
            if let url { try? FileManager.default.removeItem(at: url) }
            handler?(nil)
        }
    }
}

// The one voice surface both wrist flows share: a single large circle that is
// the entire control, with one title and one caption underneath. Listening
// breathes with the mic, sending pulses, success is green, failure is amber
// and tappable to retry — every state legible in a glance, operable with one
// thumb.
struct VoiceStageView: View {
    enum Stage: Equatable {
        case listening
        case sending
        case success
        case failure
    }

    let stage: Stage
    var level: Double = 0
    let title: String
    var caption: String?
    /// The spoken content itself (a transcript), shown as a terminal line so
    /// the user can read exactly what is being sent.
    var detail: String?
    var onTap: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Button { onTap?() } label: { circle }
                .buttonStyle(.plain)
                .disabled(onTap == nil)
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(titleColor)
                .multilineTextAlignment(.center)
                .lineLimit(2)
            if let caption {
                Text(caption)
                    .font(.mono(10))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let detail {
                Text("❯ \(detail)")
                    .font(.mono(10))
                    .foregroundStyle(Theme.stew)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var titleColor: Color {
        switch stage {
        case .success: return Theme.phosphor
        case .failure: return Theme.amber
        default: return .primary
        }
    }

    private var circle: some View {
        ZStack {
            switch stage {
            case .listening:
                Circle().stroke(Theme.stew.opacity(0.25), lineWidth: 3)
                Circle()
                    .stroke(Theme.stew, lineWidth: 3)
                    .scaleEffect(1 + level * 0.18)
                    .animation(.easeOut(duration: 0.12), value: level)
                Image(systemName: "stop.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.stew)
            case .sending:
                Circle().stroke(Theme.stew.opacity(0.35), lineWidth: 3)
                Image(systemName: "waveform")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Theme.stew)
                    .symbolEffect(.variableColor.iterative, isActive: true)
            case .success:
                Circle().fill(Theme.phosphor)
                Image(systemName: "checkmark")
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(.black)
            case .failure:
                Circle().stroke(Theme.amber, lineWidth: 3)
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Theme.amber)
            }
        }
        .frame(width: 72, height: 72)
    }
}

// The listening state: a cyan ring that breathes with the mic level, so it is
// obvious the watch is hearing you and equally obvious when it stops.
struct ListeningRing: View {
    let level: Double
    let transcribing: Bool

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.stew.opacity(0.25), lineWidth: 2)
            Circle()
                .stroke(Theme.stew, lineWidth: 2)
                .scaleEffect(transcribing ? 1 : 1 + level * 0.22)
                .opacity(transcribing ? 0.4 : 1)
                .animation(.easeOut(duration: 0.12), value: level)
            Image(systemName: transcribing ? "waveform" : "stop.fill")
                .font(.system(size: transcribing ? 18 : 15, weight: .semibold))
                .foregroundStyle(Theme.stew)
                .symbolEffect(.variableColor.iterative, isActive: transcribing)
        }
        .frame(width: 42, height: 42)
    }
}
