import AVFoundation
import Foundation
import NekkoKit
import NekkoProtocol
import Observation
import Speech

/// Dictation into the message box; the text is inserted, never sent. Records
/// a mono 16 kHz 16-bit WAV (at most 30 s, so it fits one relay frame), then
/// transcribes it with Whisper on the computer (`voice:transcribe`) when Nekko
/// Voice is installed there, else with this iPhone's speech recognizer
/// (on-device when the phone supports it). Same split as Android's AN-15.
@MainActor
@Observable
final class Dictation {
    static let maxSeconds: TimeInterval = 30

    private(set) var recording = false
    private(set) var status = ""
    private(set) var error: String?
    var available: Bool { AVAudioApplication.shared.recordPermission != .denied }

    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var timer: Task<Void, Never>?

    func start(store: ComputersStore) async {
        error = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            error = "Microphone access is off. Allow it in Settings → Nekko Agent."
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).wav")
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                                           AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
            let r = try AVAudioRecorder(url: file, settings: settings)
            guard r.record(forDuration: Self.maxSeconds) else { throw RelayError("Couldn’t start recording.") }
            recorder = r
            url = file
            recording = true
            status = "Listening… tap stop when you’re done"
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Stop and transcribe. Returns the text, or nil (with `error` set).
    func stop(store: ComputersStore) async -> String? {
        guard let recorder, let url else { return nil }
        recorder.stop()
        self.recorder = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer {
            try? FileManager.default.removeItem(at: url)
            self.url = nil
            status = ""
        }
        if await computerHasWhisper(store), let text = await transcribeOnComputer(url, store) { return text }
        return await transcribeOnPhone(url)
    }

    private func computerHasWhisper(_ store: ComputersStore) async -> Bool {
        guard AppModel.shared.prefs.dictationOnComputer, store.conn == .online, store.pcSettings.voiceEnabled,
              let r = try? store.remote(), let v = try? await r.call(Channels.voiceStatus) else { return false }
        return VoiceInstall.from(v).installed
    }

    private func transcribeOnComputer(_ url: URL, _ store: ComputersStore) async -> String? {
        guard let data = try? Data(contentsOf: url), let r = try? store.remote() else { return nil }
        status = "Transcribing on \(store.active?.name ?? "your computer")…"
        guard let v = try? await r.call(Channels.voiceTranscribe, [wavArg(data)], timeout: 60) else { return nil }
        let text = (v.string ?? v.str("text") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    /// The recognizer may report more than once; resume the continuation once.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }

    private func transcribeOnPhone(_ url: URL) async -> String? {
        status = "Transcribing…"
        let auth = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard auth == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            error = "Speech recognition isn’t available. Allow it in Settings → Nekko Agent."
            return nil
        }
        let req = SFSpeechURLRecognitionRequest(url: url)
        req.shouldReportPartialResults = false
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        let text: String? = await withCheckedContinuation { c in
            let once = Once()
            recognizer.recognitionTask(with: req) { result, err in
                if let result, result.isFinal {
                    if once.claim() { c.resume(returning: result.bestTranscription.formattedString) }
                } else if err != nil {
                    if once.claim() { c.resume(returning: nil) }
                }
            }
        }
        if text == nil { error = "Couldn’t make out any words." }
        return text
    }
}
