import NekkoKit
import SwiftUI
import UIKit

/// Dictation before a computer chat exists, and for chats running on this phone.
/// These surfaces only insert text: a spoken command never creates or sends a chat.
struct DraftVoiceInput: View {
    @Binding var text: String
    var onPhone = false
    var park: ((String) -> Void)?
    @Environment(ComputersStore.self) private var store
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    @Environment(\.scenePhase) private var phase
    @State private var dictation = Dictation()
    @State private var intro = VoiceIntroGate()
    @State private var permissionHelp = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if dictation.recording || dictation.transcribing {
                Text(dictation.status).font(.caption2).foregroundStyle(palette.inkSoft)
            } else if let notice = dictation.error ?? dictation.notice {
                Text(notice).font(.caption2).foregroundStyle(palette.inkSoft)
            }
            if dictation.starting || (dictation.transcribing && !dictation.recording) {
                ProgressView().frame(width: 44, height: 44).accessibilityLabel("Transcribing")
            } else if !dictation.available {
                Button { permissionHelp = true } label: {
                    Image(systemName: "mic.slash").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Enable microphone")
            } else if prefs.dictationHold {
                HoldToTalkButton(dictation: dictation, gate: intro)
            } else {
                Button {
                    if dictation.recording { dictation.stopListening() }
                    else if !intro.intercept(prefs) { start() }
                } label: {
                    Image(systemName: dictation.recording ? "stop.circle.fill" : "mic.fill")
                        .font(.title3).foregroundStyle(dictation.recording ? palette.danger : palette.inkSoft)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel(dictation.recording ? "Stop dictation" : "Dictate")
                .accessibilityHint("Adds speech to your message. Nothing is sent until you tap Send.")
                .accessibilityIdentifier("composer.dictate")
            }
        }
        .onAppear { configure() }
        .onChange(of: onPhone) { _, _ in resetDestination() }
        .onChange(of: store.activeId) { _, _ in resetDestination() }
        .onChange(of: phase) { _, p in
            if Dictation.leavesScreen(p, starting: dictation.starting) { dictation.abort() }
        }
        .onDisappear {
            dictation.sink = nil
            dictation.stopListening()
        }
        .sheet(isPresented: $intro.showing, onDismiss: {
            intro.closed(prefs) { if !prefs.dictationHold { start() } }
        }) { VoiceIntroView(onTurnOn: { intro.turnOn() }) }
        .alert("Microphone access is off", isPresented: $permissionHelp) {
            Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Allow microphone access in Settings → Nekko Agent, then return to dictate.") }
    }

    private func configure() {
        let computer = store.activeId
        dictation.allowComputer = !onPhone
        dictation.sink = { words in
            guard store.activeId == computer else { return }
            text += (text.isEmpty || text.last?.isWhitespace == true ? "" : " ") + words.text
        }
        dictation.park = { words in
            guard store.activeId == computer else { return }
            park?(words)
        }
    }

    private func resetDestination() {
        dictation.sink = nil
        dictation.park = nil
        dictation.discard()
        dictation = Dictation()
        configure()
    }

    private func start() { Task { await dictation.startListening(store: store) } }
}
