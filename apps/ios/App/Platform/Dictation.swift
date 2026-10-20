import AVFoundation
import Foundation
import NekkoKit
import NekkoProtocol
import Observation
import Speech
import SwiftUI

/// Dictation into the message box; the text is inserted, never sent. Records
/// a mono 16 kHz 16-bit WAV (at most 30 s, so it fits one relay frame), then
/// transcribes it with Whisper on the computer (`voice:transcribe`) when Nekko
/// Voice is installed there, else with this iPhone's speech recognizer
/// (on-device when the phone supports it). Same split as Android's AN-15.
/// Tap to start and stop, or hold to talk (IO-28, *Settings → Dictation*).
@MainActor
@Observable
final class Dictation {
    static let maxSeconds: TimeInterval = 30

    private(set) var recording = false
    /// Recording stopped, the words are being worked out (on the computer or the phone).
    private(set) var transcribing = false
    private(set) var status = ""
    private(set) var error: String?
    /// A hint that isn't an error (hold-to-talk: the microphone was just allowed, a tap too short).
    private(set) var notice: String?
    /// The words, once per dictation: the composer inserts them. Set whether the
    /// user tapped stop or the 30-second limit ended the recording.
    private(set) var result: Words?

    struct Words: Equatable {
        let id = UUID()
        let text: String
    }
    var available: Bool { AVAudioApplication.shared.recordPermission != .denied }

    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var timer: Task<Void, Never>?
    private var hold = HoldToTalk()

    /// Hold to talk: the finger went down on the microphone.
    func press(store: ComputersStore) async {
        notice = nil
        let permission: HoldToTalk.Permission
        switch AVAudioApplication.shared.recordPermission {
        case .granted: permission = .granted
        case .denied: permission = .denied
        default: permission = .undetermined
        }
        switch hold.press(at: .now, permission: permission) {
        case .askPermission:
            if await AVAudioApplication.requestRecordPermission() {
                notice = "Microphone on. Hold the microphone while you speak."
            } else {
                error = "Microphone access is off. Allow it in Settings → Nekko Agent."
            }
        case .start:
            await start(store: store, holding: true)
            if recording {
                if hold.didStart(at: .now) == .discard { discard() }
            } else {
                hold.failedToStart()
            }
        default:
            break
        }
    }

    /// Hold to talk: the finger came up.
    func letGo(store: ComputersStore) async {
        switch hold.release(at: .now) {
        case .finish:
            await finish(store: store)
        case .discard:
            discard()
            notice = "Hold the microphone while you speak, then let go."
        default:
            break
        }
    }

    /// Stop without transcribing.
    func discard() {
        timer?.cancel()
        timer = nil
        recorder?.stop()
        recorder = nil
        recording = false
        status = ""
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
    }

    func start(store: ComputersStore, holding: Bool = false) async {
        error = nil
        notice = nil
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
            status = holding ? "Listening… let go when you’re done" : "Listening… tap stop when you’re done"
            AccessibilityNotification.Announcement("Listening").post()
            // The recorder stops itself at the limit; finish the dictation then
            // too, instead of leaving "Listening…" up with nothing recording.
            timer?.cancel()
            timer = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.maxSeconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.finish(store: store)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Stop and transcribe; the text arrives as `result` (or `error` is set).
    func finish(store: ComputersStore) async {
        guard let recorder, let url else { return }
        timer?.cancel()
        timer = nil
        recorder.stop()
        self.recorder = nil
        recording = false
        transcribing = true
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        defer {
            try? FileManager.default.removeItem(at: url)
            self.url = nil
            transcribing = false
            status = ""
        }
        var text: String?
        if await computerHasWhisper(store) { text = await transcribeOnComputer(url, store) }
        if text == nil { text = await transcribeOnPhone(url) }
        if let text {
            result = Words(text: text)
            AccessibilityNotification.Announcement("Dictation added to your message").post()
        }
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
