import AVKit
import SwiftUI

/// When the first-open video for always-on dictation shows (IO-28): the first tap of the
/// microphone, and "Watch how voice works" in Settings. The Composer and Settings each hold
/// one and present `VoiceIntroView` from `showing`.
@MainActor
@Observable
final class VoiceIntroGate {
    var showing = false
    /// "Turn on" was tapped: the sheet is going away and listening starts once it has.
    private var turnedOn = false

    /// The mic was tapped: true when the video took the tap, so nothing listens yet.
    func intercept(_ prefs: Prefs) -> Bool {
        guard !prefs.voiceIntroSeen else { return false }
        showing = true
        return true
    }

    func replay() { showing = true }

    func turnOn() { turnedOn = true }

    /// The sheet closed, by a button or by swiping it away: it was seen either way.
    /// Only Turn on starts listening.
    func closed(_ prefs: Prefs, listen: () -> Void) {
        prefs.voiceIntroSeen = true
        showing = false
        guard turnedOn else { return }
        turnedOn = false
        listen()
    }
}

/// The first-open video, rendered from the desktop's `VoiceIntroVideo` in a light and a dark
/// cut (apps/desktop/scripts/render-voice-intro.mjs). It plays once, no loop. With `onTurnOn`
/// (the first tap on the mic) it ends in Turn on / Not now; replayed from Settings it ends in Done.
struct VoiceIntroView: View {
    /// What the video says, for VoiceOver: its captions are its text alternative.
    static let summary = "How voice works. Tap the mic once and it stays on. Talk and your words appear in the chat you are looking at; nothing is sent until you say so. Say Nekko to give a command, like erase that, send it or new chat. On iPhone, listening stops when you lock the phone. Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours."

    var onTurnOn: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let player {
                    VideoPlayer(player: player)
                        .aspectRatio(16.0 / 9.0, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Self.summary)
                        .accessibilityIdentifier("voiceIntro.video")
                } else {
                    Text(Self.summary).foregroundStyle(palette.inkSoft)
                }
                Spacer(minLength: 0)
                if let onTurnOn {
                    Button { onTurnOn(); dismiss() } label: { Text("Turn on").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .accessibilityIdentifier("voiceIntro.turnOn")
                    Button("Not now") { dismiss() }
                        .accessibilityIdentifier("voiceIntro.notNow")
                } else {
                    Button { dismiss() } label: { Text("Done").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .accessibilityIdentifier("voiceIntro.done")
                }
            }
            .padding()
            .appBackground()
            .navigationTitle("How voice works")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear(perform: load)
        .onDisappear { player?.pause() }
    }

    private func load() {
        guard player == nil, let url = Bundle.main.url(forResource: "voice-intro-\(scheme == .dark ? "dark" : "light")", withExtension: "mp4") else { return }
        let p = AVPlayer(url: url)
        player = p
        // With Reduce Motion the video waits for the play button.
        if !UIAccessibility.isReduceMotionEnabled { p.play() }
    }
}
