import AVFoundation
import NekkoProtocol
import SwiftUI
import UIKit

/// "Send your first prompt": the desktop's first-chat intro (spec/chat/first-prompt-intro.md) on iPhone and iPad.
/// Three short looping demos drawn on this app's new-chat screen
/// (apps/desktop/scripts/first-prompt-intro-render, rendered by render-first-prompt-intro.mjs), each
/// with its words underneath. It opens once, over someone's first ever new chat, and closing it any way marks it seen.
struct FirstPromptIntroView: View {
    struct Step { let id, title, body: String }
    static let steps = [
        Step(id: "start", title: String(localized: "Start with a question"),
             body: String(localized: "Type what you want done, the way you’d ask a colleague. You can also tap the mic and say it.")),
        Step(id: "add", title: String(localized: "Add photos and a folder"),
             body: String(localized: "Tap + to add photos or paste an image. Pick a folder so Nekko works in the right place on your computer.")),
        Step(id: "send", title: String(localized: "Tap Start, and Nekko gets to work"),
             body: String(localized: "Nekko works on your computer and replies here. Before it runs a command or changes anything, it asks you first.")),
    ]

    /// Whether the new-chat screen opens it: not seen yet, a chat for a computer (a chat on this iPhone
    /// has no photos or folders), the computer's list read, and no chat anywhere with an exchange yet.
    /// A chat whose count is unknown (an older computer) counts as used, so people who already chatted never see it.
    static func shouldShow(seen: Bool, onPhone: Bool, listLoaded: Bool, chats: [SessionSummary]) -> Bool {
        guard !seen, !onPhone, listLoaded else { return false }
        return chats.allSatisfy { $0.exchangeCount == 0 }
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.palette) private var palette
    @State private var step = 0

    var body: some View {
        let current = Self.steps[step]
        let last = step == Self.steps.count - 1
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                LoopingVideo(name: "first-prompt-\(current.id)-\(scheme == .dark ? "dark" : "light")")
                    .id(step)
                    .aspectRatio(360.0 / 400.0, contentMode: .fit)
                    .frame(maxWidth: 420)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(palette.line))
                    .frame(maxWidth: .infinity)
                    // The words below say what the demo shows.
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(current.title).font(.headline)
                    Text(current.body).font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("firstPromptIntro.step")
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    ForEach(Self.steps.indices, id: \.self) { i in
                        Button { step = i } label: {
                            Capsule().fill(i == step ? palette.accent : palette.line).frame(width: i == step ? 18 : 7, height: 7)
                                .frame(minWidth: 24, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Step \(i + 1): \(Self.steps[i].title)")
                        .accessibilityAddTraits(i == step ? .isSelected : [])
                    }
                    Spacer(minLength: 0)
                    if step > 0 { Button("Back") { step -= 1 }.accessibilityIdentifier("firstPromptIntro.back") }
                    Button { if last { dismiss() } else { step += 1 } } label: {
                        Text(last ? "Get started" : "Next").padding(.horizontal, 6).foregroundStyle(palette.onAccent)
                    }
                    .buttonStyle(.borderedProminent).tint(palette.accent)
                    .accessibilityIdentifier(last ? "firstPromptIntro.done" : "firstPromptIntro.next")
                }
                .animation(.snappy(duration: 0.2), value: step)
            }
            .padding()
            .appBackground()
            .navigationTitle("Send your first prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // It opens on its own, so leaving it is always one tap (as is swiping the sheet away).
                if !last {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Skip") { dismiss() }.accessibilityIdentifier("firstPromptIntro.skip")
                    }
                }
            }
        }
    }
}

/// A muted demo that loops, with no controls (the desktop's Player has none either).
/// With Reduce Motion it holds one telling frame, still.
private struct LoopingVideo: UIViewRepresentable {
    let name: String

    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
        var looper: AVPlayerLooper?
    }

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.videoGravity = .resizeAspect
        guard let url = Bundle.main.url(forResource: name, withExtension: "mp4") else { return view }
        let item = AVPlayerItem(url: url)
        let player = AVQueuePlayer()
        player.isMuted = true
        // Never take the audio session from music the person is playing.
        player.preventsDisplaySleepDuringVideoPlayback = false
        view.looper = AVPlayerLooper(player: player, templateItem: item)
        view.playerLayer.player = player
        if UIAccessibility.isReduceMotionEnabled {
            player.seek(to: CMTime(seconds: 3.3, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        } else {
            player.play()
        }
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {}

    static func dismantleUIView(_ view: PlayerView, coordinator: ()) {
        view.playerLayer.player?.pause()
        view.looper?.disableLooping()
    }
}

#if DEBUG
/// The intro over an empty screen (`-uiTestFirstPromptIntro`), for its UI test and screenshots.
struct FirstPromptIntroFixture: View {
    @State private var showing = true
    var body: some View {
        Color.clear.appBackground().sheet(isPresented: $showing) { FirstPromptIntroView() }
    }
}
#endif
