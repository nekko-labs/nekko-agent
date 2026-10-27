import AVFoundation
import Foundation
import NekkoKit
import NekkoProtocol
import Observation
import Speech
import SwiftUI

enum DictationError: Error, Equatable, LocalizedError {
    /// The phone has no on-device recognizer for its language, and speech never goes to a server.
    case noOnDevice(language: String)

    var errorDescription: String? {
        switch self {
        case .noOnDevice(let language):
            return "This phone can't turn speech into text on the phone for \(language), so dictation is off. Turn on Nekko Voice on your computer to dictate."
        }
    }
}

/// The phone's speech recognizer, as the one thing the phone path needs from it (tests stand in for it).
protocol SpeechRecognizing: AnyObject {
    var supportsOnDeviceRecognition: Bool { get }
    var locale: Locale { get }
    /// The final transcript, or nil when the recognizer heard no words.
    func text(for request: SFSpeechURLRecognitionRequest) async -> String?
}

extension SFSpeechRecognizer: SpeechRecognizing {
    func text(for request: SFSpeechURLRecognitionRequest) async -> String? {
        await withCheckedContinuation { c in
            let once = Once()
            recognitionTask(with: request) { result, err in
                if let result, result.isFinal {
                    if once.claim() { c.resume(returning: result.bestTranscription.formattedString) }
                } else if err != nil {
                    // shortcut: every recognizer error reads as "no words" (it reports silence as an error), split them if a real failure needs saying.
                    if once.claim() { c.resume(returning: nil) }
                }
            }
        }
    }
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

/// Dictation into the message box (IO-28). Tap mode keeps the microphone open
/// and cuts what is said into segments at each pause (`VoiceSegmenter`, at most
/// 30 s each so one fits a relay frame); hold mode records one segment per hold.
/// Each segment is a mono 16 kHz 16-bit WAV, transcribed one at a time, in order,
/// with Whisper on the computer (`voice:transcribe`) when Nekko Voice is installed
/// there, else with this iPhone's on-device speech recognizer, never a server.
/// The words arrive in `heard`; the Composer's `VoiceRunner` types them or runs
/// the "Nekko, ..." commands in them.
@MainActor
@Observable
final class Dictation {
    static let maxSeconds: TimeInterval = 30
    nonisolated static let sampleRate = 16_000.0
    /// The desktop's defaults: 1.2 s of quiet ends a segment, and its sensitivity 60.
    static let silenceSeconds = 1.2
    static let threshold: Float = 0.023

    /// The microphone is open.
    private(set) var recording = false
    /// A segment is being turned into words (on the computer or the phone).
    var transcribing: Bool { queued > 0 }
    private(set) var error: String?
    /// A hint that isn't an error (hold-to-talk: the microphone was just allowed, a tap too short).
    private(set) var notice: String?
    /// Every segment's words, in spoken order. Append-only: the composer applies each once.
    private(set) var heard: [Words] = []

    struct Words: Equatable {
        let id = UUID()
        let text: String
    }
    var available: Bool { AVAudioApplication.shared.recordPermission != .denied }

    var status: String {
        if recording { return holding ? "Listening… let go when you’re done" : "Listening… tap stop when you’re done" }
        if let transcribingOn { return "Transcribing on \(transcribingOn)…" }
        return transcribing ? "Transcribing…" : ""
    }

    /// Stands in for the computer and the phone in tests.
    var transcribe: ((Data) async throws -> String?)?

    private weak var store: ComputersStore?
    private var engine: AVAudioEngine?
    private var configChange: NSObjectProtocol?
    private var holding = false
    private var segmenter = Dictation.newSegmenter()
    /// Hold mode: everything said while the finger is down.
    private var held: [Float] = []
    private var chain: Task<Void, Never>?
    private var queued = 0
    private var transcribingOn: String?
    /// A failed transcription is said once per failing run, not on every pause.
    private var failing = false
    private var hold = HoldToTalk()
    /// The background time iOS gives to transcribe the last words after the app leaves the screen.
    private var grace = UIBackgroundTaskIdentifier.invalid

    private static func newSegmenter() -> VoiceSegmenter {
        VoiceSegmenter(sampleRate: sampleRate, silenceSeconds: silenceSeconds, maxSeconds: maxSeconds, threshold: threshold)
    }

    /// Tap mode: listen until `stopListening`, the chat closing, or the app leaving the screen.
    func startListening(store: ComputersStore) async { await start(store: store, holding: false) }

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
            stopListening()
        case .discard:
            discard()
            notice = "Hold the microphone while you speak, then let go."
        default:
            break
        }
    }

    func start(store: ComputersStore, holding: Bool) async {
        guard !recording else { return }
        error = nil
        notice = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            error = "Microphone access is off. Allow it in Settings → Nekko Agent."
            return
        }
        self.store = store
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let engine = AVAudioEngine()
            try Self.tap(engine.inputNode, into: self)
            engine.prepare()
            try engine.start()
            self.engine = engine
            // A route change (headphones out, a call) stops the engine: stop listening with it, keeping what was said.
            configChange = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.stopListening() }
            }
            segmenter = Self.newSegmenter()
            held = []
            self.holding = holding
            failing = false
            recording = true
            AccessibilityNotification.Announcement("Listening").post()
        } catch {
            self.error = error.localizedDescription
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    /// Stop listening; the words said up to now still count.
    func stopListening() {
        guard recording else { return }
        close().forEach(enqueue)
    }

    /// The app left the screen: stop, and transcribe the last words only if iOS gives the time to.
    func abort() {
        guard recording else { return }
        let tail = close()
        guard !tail.isEmpty else { return }
        endGrace()
        grace = UIApplication.shared.beginBackgroundTask { [weak self] in MainActor.assumeIsolated { self?.endGrace() } }
        guard grace != .invalid else { return }
        tail.forEach(enqueue)
        Task {
            await drain()
            endGrace()
        }
    }

    private func endGrace() {
        guard grace != .invalid else { return }
        UIApplication.shared.endBackgroundTask(grace)
        grace = .invalid
    }

    /// Stop without transcribing.
    func discard() {
        guard recording else { return }
        _ = close()
    }

    /// Closes the microphone and returns what was said and not yet cut into a segment.
    private func close() -> [[Float]] {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        if let configChange { NotificationCenter.default.removeObserver(configChange) }
        configChange = nil
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        var tail: [[Float]] = []
        if holding {
            if !held.isEmpty { tail.append(held) }
            held = []
        } else {
            while let segment = segmenter.flush() { tail.append(segment) }
        }
        return tail
    }

    /// The input tap, 16 kHz mono float. Static, so its block (run on the audio thread) is not main-actor code.
    private nonisolated static func tap(_ input: AVAudioInputNode, into dictation: Dictation) throws {
        let from = input.outputFormat(forBus: 0)
        guard from.sampleRate > 0, from.channelCount > 0,
              let to = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: from, to: to) else { throw RelayError("Couldn’t start recording.") }
        input.installTap(onBus: 0, bufferSize: 4096, format: from) { [weak dictation] buffer, _ in
            guard let samples = convert(buffer, converter, to) else { return }
            // The main queue keeps the buffers in order.
            DispatchQueue.main.async { MainActor.assumeIsolated { dictation?.consume(samples) } }
        }
    }

    private nonisolated static func convert(_ buffer: AVAudioPCMBuffer, _ converter: AVAudioConverter, _ to: AVAudioFormat) -> [Float]? {
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * to.sampleRate / buffer.format.sampleRate) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: capacity) else { return nil }
        var given = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, let channel = out.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    }

    private func consume(_ samples: [Float]) {
        guard recording else { return }
        if holding {
            held += samples
            if Double(held.count) >= Self.maxSeconds * Self.sampleRate { stopListening() }
        } else if let segment = segmenter.feed(samples) {
            enqueue(segment)
        }
    }

    /// Transcribes after every earlier segment: the computer refuses a second transcription while one runs.
    func enqueue(_ samples: [Float]) {
        let previous = chain
        queued += 1
        chain = Task {
            await previous?.value
            await transcribeSegment(samples)
            queued -= 1
        }
    }

    /// Waits until every queued segment is transcribed.
    func drain() async {
        while let current = chain {
            await current.value
            if chain == current { return }
        }
    }

    // Whisper writes non-speech as bracketed or parenthesized tags ("[BLANK_AUDIO]", "(keyboard clicking)").
    private static let annotation = try! NSRegularExpression(pattern: #"\[[^\]\n]{1,40}]|\([^)\n]{1,40}\)"#)

    private func transcribeSegment(_ samples: [Float]) async {
        let wav = Self.wav(samples)
        do {
            let text: String?
            if let transcribe { text = try await transcribe(wav) } else { text = try await onEngines(wav) }
            failing = false
            let words = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let range = NSRange(words.startIndex..., in: words)
            guard !Self.annotation.stringByReplacingMatches(in: words, range: range, withTemplate: "")
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            heard.append(Words(text: words))
        } catch let e as DictationError {
            // Dictation is off: nothing more is recorded.
            error = e.localizedDescription
            if recording { _ = close() }
        } catch {
            if !failing { self.error = "Couldn’t turn speech into text: \(error.localizedDescription)" }
            failing = true
        }
    }

    private func onEngines(_ wav: Data) async throws -> String? {
        guard let store else { return nil }
        if await computerHasWhisper(store), let text = await transcribeOnComputer(wav, store) { return text }
        return try await onPhone(wav)
    }

    private func computerHasWhisper(_ store: ComputersStore) async -> Bool {
        guard AppModel.shared.prefs.dictationOnComputer, store.conn == .online, store.pcSettings.voiceEnabled,
              let r = try? store.remote(), let v = try? await r.call(Channels.voiceStatus) else { return false }
        return VoiceInstall.from(v).installed
    }

    /// The words ("" when none), or nil when the computer couldn't transcribe (the phone tries then).
    private func transcribeOnComputer(_ wav: Data, _ store: ComputersStore) async -> String? {
        guard let r = try? store.remote() else { return nil }
        transcribingOn = store.active?.name ?? "your computer"
        defer { transcribingOn = nil }
        guard let v = try? await r.call(Channels.voiceTranscribe, [wavArg(wav)], timeout: 60) else { return nil }
        return v.string ?? v.str("text") ?? ""
    }

    private func onPhone(_ wav: Data) async throws -> String? {
        let auth = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
        guard auth == .authorized, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw RelayError("Speech recognition isn’t available. Allow it in Settings → Nekko Agent.")
        }
        return try await Self.transcribeOnPhone(wav, with: recognizer)
    }

    /// On this phone or not at all: without an on-device recognizer the audio would go to a server, so it is refused.
    static func transcribeOnPhone(_ wav: Data, with recognizer: SpeechRecognizing) async throws -> String? {
        guard recognizer.supportsOnDeviceRecognition else {
            let language = Locale(identifier: "en").localizedString(forIdentifier: recognizer.locale.identifier) ?? recognizer.locale.identifier
            throw DictationError.noOnDevice(language: language)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).wav")
        try wav.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = true
        return await recognizer.text(for: request)
    }

    /// Samples as a mono 16 kHz 16-bit PCM WAV file.
    static func wav(_ samples: [Float]) -> Data {
        var d = Data()
        d.reserveCapacity(44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        let rate = UInt32(sampleRate)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        d.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in samples { u16(UInt16(bitPattern: Int16(max(-1, min(1, s)) * 32_767))) }
        return d
    }
}
