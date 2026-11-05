import AVFoundation
import NekkoKit
import SwiftUI
import UIKit

struct VoiceConversationButton: View {
    var makeTarget: () async throws -> ConversationTarget
    var finished: ((ConversationTarget) -> Void)?
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            Image(systemName: "waveform.circle").font(.title3)
                .foregroundStyle(palette.accent).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Voice conversation")
        .accessibilityHint("Talk hands-free and hear replies. Opens controls before listening.")
        .accessibilityIdentifier("composer.voiceConversation")
        .sheet(isPresented: $open) { VoiceConversationView(makeTarget: makeTarget, finished: finished) }
    }
}

@MainActor
struct VoiceConversationView: View {
    var makeTarget: () async throws -> ConversationTarget
    var finished: ((ConversationTarget) -> Void)?
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var scene
    @Environment(\.dismiss) private var dismiss
    @State private var voice: VoiceConversation
    @State private var dictation = Dictation()
    @State private var speaker = ConversationSpeaker()
    @State private var target: ConversationTarget?
    @State private var preparation: Task<Void, Never>?
    @State private var preparing = false
    @State private var preparationGeneration = 0
    @State private var failure: String?

    init(makeTarget: @escaping () async throws -> ConversationTarget,
         finished: ((ConversationTarget) -> Void)? = nil, state: VoiceConversation = VoiceConversation()) {
        self.makeTarget = makeTarget
        self.finished = finished
        _voice = State(initialValue: state)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Image(systemName: voice.phase == .speaking ? "speaker.wave.2.fill" : "waveform.circle.fill")
                        .font(.system(size: 64)).foregroundStyle(palette.accent)
                        .frame(maxWidth: .infinity).accessibilityHidden(true)
                    Text(preparing ? "Preparing" : voice.phase.rawValue)
                        .font(.title2.bold()).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("voiceConversation.state")
                    Text("After you tap Start, each spoken turn is sent automatically to this chat. Nekko speaks the reply, then listens again. The microphone is off while it thinks or speaks.")
                    Text("Speech playback stays on this iPhone. Recognition uses this iPhone or your selected computer’s configured speech engine—not a new cloud speech service. The transcribed message goes to the chat’s selected model.")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                    if !voice.heard.isEmpty {
                        Text("You said").font(.headline)
                        Text(voice.heard).textSelection(.enabled)
                    }
                    if !voice.reply.isEmpty {
                        Text("Nekko replied").font(.headline)
                        Text(voice.reply).textSelection(.enabled)
                    }
                    if let error = failure ?? voice.error {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(palette.danger)
                    }
                    Text("End, leaving this screen, locking the phone, or an audio interruption stops listening and playback. An agent task already sent may continue in the chat. Approvals still need your explicit answer there.")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }.padding(24).frame(maxWidth: 560)
            }
            .background(palette.paper).foregroundStyle(palette.ink)
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    if !dictation.available {
                        Button("Open microphone settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    if voice.active || preparing {
                        Button("End voice conversation", role: .destructive) { stop() }
                            .buttonStyle(.borderedProminent).accessibilityIdentifier("voiceConversation.stop")
                    } else {
                        Button("Start voice conversation") { start() }
                            .buttonStyle(.borderedProminent).accessibilityIdentifier("voiceConversation.start")
                    }
                }
                .frame(maxWidth: .infinity).padding(16).background(palette.paper)
            }
            .navigationTitle("Voice conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { stop(); dismiss() } } }
        }
        .onChange(of: scene) { _, phase in if Dictation.leavesScreen(phase, starting: dictation.starting || preparing) { stop() } }
        .onChange(of: store.activeId) { _, _ in stop() }
        .onChange(of: store.conn) { _, state in
            if case .computer = target, state != .online { stop(); failure = "The computer disconnected. Reconnect, then start voice again." }
        }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in stop() }
        .onDisappear {
            stop()
            if let target { finished?(target) }
        }
    }

    private func start() {
        guard !preparing, !voice.active else { return }
        guard dictation.available else {
            failure = "Microphone access is off. Allow it in Settings → Nekko Agent."
            return
        }
        failure = nil
        preparing = true
        preparationGeneration += 1
        let generation = preparationGeneration
        preparation = Task { @MainActor in
            defer { if preparationGeneration == generation { preparing = false } }
            do {
                let selected: ConversationTarget
                if let target { selected = target } else { selected = try await makeTarget() }
                guard !Task.isCancelled, preparationGeneration == generation else {
                    // New-chat factories own a temporary subscription; existing chat controls do not.
                    if finished != nil, case .computer(let chat, _) = selected { chat.stop() }
                    throw CancellationError()
                }
                target = selected
                let capture = Dictation()
                let playback = ConversationSpeaker()
                dictation = capture
                speaker = playback
                if case .phone = selected { capture.allowComputer = false }
                voice.start(capture: { try await capture.captureOnce(store: store) },
                            respond: { try await selected.respond($0, store: store, phone: phone) },
                            speak: { try await playback.speak($0) },
                            stopAudio: { capture.discard(); playback.stop() })
            } catch is CancellationError { }
            catch { if preparationGeneration == generation, !Task.isCancelled { failure = error.localizedDescription } }
        }
    }

    private func stop() {
        preparationGeneration += 1
        preparation?.cancel()
        preparation = nil
        preparing = false
        voice.stop()
        dictation.discard()
        speaker.stop()
    }
}
