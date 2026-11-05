import Foundation
import NekkoProtocol
import Observation

/// Half-duplex by design: the mic is closed while the agent works or the phone
/// speaks. Audio operations are injected so lifecycle tests never open a mic.
@MainActor @Observable
public final class VoiceConversation {
    public enum Phase: String { case ready = "Ready", listening = "Listening", waiting = "Thinking", speaking = "Speaking", stopped = "Stopped" }
    public private(set) var phase: Phase = .ready
    public private(set) var heard = ""
    public private(set) var reply = ""
    public private(set) var error: String?
    public var active: Bool { task != nil }
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var stopAudio: (() -> Void)?

    public init() {}

    public func start(capture: @escaping () async throws -> String,
               respond: @escaping (String) async throws -> String,
               speak: @escaping (String) async throws -> Void,
               stopAudio: @escaping () -> Void) {
        guard task == nil else { return }
        generation += 1
        let run = generation
        self.stopAudio = stopAudio
        error = nil
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if generation == run {
                    stopAudio()
                    self.stopAudio = nil
                    task = nil
                    phase = .stopped
                }
            }
            do {
                while !Task.isCancelled, generation == run {
                    phase = .listening
                    let words = try await capture().trimmingCharacters(in: .whitespacesAndNewlines)
                    try Task.checkCancellation()
                    guard generation == run else { return }
                    guard !words.isEmpty else { throw RelayError("No speech was heard. Tap Start to try again.") }
                    heard = words
                    phase = .waiting
                    let answer = try await respond(words)
                    try Task.checkCancellation()
                    guard generation == run else { return }
                    reply = MarkdownParser.plainText(answer).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !reply.isEmpty else { throw RelayError("There is no spoken reply. Check the chat before continuing.") }
                    phase = .speaking
                    try await speak(reply)
                    try Task.checkCancellation()
                }
            } catch is CancellationError { /* Stop is intentional, not an error. */ }
            catch {
                if generation == run, !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }

    public func stop() {
        generation += 1
        task?.cancel()
        task = nil
        stopAudio?()
        stopAudio = nil
        phase = .stopped
    }
}

