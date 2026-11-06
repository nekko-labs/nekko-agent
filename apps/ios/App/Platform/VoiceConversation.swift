import AVFoundation
import Foundation
import NekkoKit
import NekkoProtocol
import Observation

/// Local system speech only; no TTS service, credentials, or network fallback.
@MainActor
final class ConversationSpeaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var activeUtterance: AVSpeechUtterance?
    private var completion: CheckedContinuation<Void, Never>?
    override init() { super.init(); synth.delegate = self }

    func speak(_ text: String) async throws {
        try Task.checkCancellation()
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audio.setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
        await withCheckedContinuation { continuation in
            completion = continuation
            activeUtterance = utterance
            synth.speak(utterance)
        }
        try Task.checkCancellation()
    }

    func stop() {
        guard activeUtterance != nil else { return }
        synth.stopSpeaking(at: .immediate)
        finish()
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.finish(id) }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let id = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.finish(id) }
    }
    private func finish(_ id: ObjectIdentifier? = nil) {
        if let id, activeUtterance.map(ObjectIdentifier.init) != id { return }
        guard activeUtterance != nil else { return }
        activeUtterance = nil
        let done = completion
        completion = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        done?.resume()
    }
}

/// Bound when the person starts: never re-resolves a chat or computer mid-session.
@MainActor
enum ConversationTarget {
    case computer(ChatModel, computerId: String)
    case phone(String)

    func respond(_ words: String, store: ComputersStore, phone: PhoneChats) async throws -> String {
        let deadline = Date().addingTimeInterval(300)
        switch self {
        case .computer(let chat, let computer):
            guard store.activeId == computer, store.conn == .online else { throw RelayError("Connect to the original computer to continue voice.") }
            guard !chat.running, !chat.sending, chat.waiting.isEmpty else { throw RelayError("This agent is busy. Wait for it to finish before starting voice.") }
            let before = Set(chat.session?.messages.map(\.id) ?? [])
            try await chat.send(words)
            while chat.sending || chat.running {
                try Task.checkCancellation()
                guard store.activeId == computer, store.conn == .online else { throw RelayError("The computer disconnected. Voice stopped; check the chat before continuing.") }
                if chat.turn.approval != nil || chat.turn.question != nil { throw RelayError("The agent needs your input. Answer in the chat, then start voice again.") }
                guard Date() < deadline else { throw RelayError("The agent is still working. Voice stopped; its work continues in the chat.") }
                try await Task.sleep(for: .milliseconds(100))
            }
            if let error = chat.error { throw RelayError(error) }
            guard chat.waiting.isEmpty else { throw RelayError("Your message is waiting to send. Voice stopped; check the chat.") }
            return chat.session?.messages.last(where: { $0.role == "assistant" && !before.contains($0.id) && !$0.content.isEmpty })?.content ?? ""
        case .phone(let id):
            guard !phone.running.contains(id), let chat = phone.chat(id) else { throw RelayError("This chat is busy or unavailable.") }
            let before = Set(chat.messages.map(\.id))
            phone.send(id, words)
            while phone.running.contains(id) {
                try Task.checkCancellation()
                guard Date() < deadline else { throw RelayError("The reply is still running. Voice stopped; check the chat.") }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard let message = phone.chat(id)?.messages.last(where: { $0.role == .assistant && !before.contains($0.id) }) else { return "" }
            if let error = message.error { throw RelayError(error) }
            return message.text
        }
    }
}
