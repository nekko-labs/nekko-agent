import NekkoKit
import SwiftUI

/// Right after a pairing works: the phone and the computer link up, the cat
/// pops in cheering, and confetti bursts out from behind it. Shown over
/// everything (RootView) because the first pairing swaps Welcome for the chat
/// list underneath. It goes after a few seconds or a tap; with VoiceOver on it
/// waits for *Let's go*. The first run's notification step waits for it.
struct PairSuccessView: View {
    let computerId: String
    var dismiss: () -> Void
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    /// The dotted line from the phone to the computer is drawn.
    @State private var linked = false
    /// The cat has popped in, with its check badge.
    @State private var cheering = false
    @State private var burstAt: Date?

    /// The computer's own name once its hello has arrived (it often has by now).
    private var name: String? {
        guard let n = store.computers.first(where: { $0.id == computerId })?.name, n != defaultComputerName else { return nil }
        return n
    }

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            palette.paper.opacity(0.72).ignoresSafeArea()
            if let burstAt, !reduceMotion {
                ConfettiBurst(start: burstAt, colors: [palette.accent, palette.success, palette.warning, palette.running, palette.danger])
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            VStack(spacing: 28) {
                PairLinkIllustration(linked: linked, cheering: cheering, reduceMotion: reduceMotion)
                VStack(spacing: 10) {
                    Text("You’re connected!")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Group {
                        if let name {
                            Text("\(name) is paired. Its chats are on their way.")
                        } else {
                            Text("Your computer is paired. Its chats are on their way.")
                        }
                    }
                    .font(.body)
                    .foregroundStyle(palette.inkSoft)
                }
                .multilineTextAlignment(.center)
                Button(action: dismiss) {
                    Text("Let’s go").frame(maxWidth: 280).padding(.vertical, 6).foregroundStyle(palette.onAccent)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("pairSuccess.done")
            }
            .padding(24)
            .frame(maxWidth: 520)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: dismiss)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("pairSuccess")
        .task { await play() }
    }

    private func play() async {
        Haptics.done()
        if reduceMotion {
            linked = true
            cheering = true
        } else {
            withAnimation(.easeInOut(duration: 0.55)) { linked = true }
            try? await Task.sleep(for: .milliseconds(420))
            withAnimation(.spring(response: 0.42, dampingFraction: 0.5)) { cheering = true }
            burstAt = .now
            Haptics.tap()
        }
        // VoiceOver users leave with the button, after hearing it all.
        guard !voiceOver else { return }
        try? await Task.sleep(for: .seconds(3.4))
        guard !Task.isCancelled else { return }
        dismiss()
    }
}

/// The computer and the phone, a dotted line drawing between them, and the
/// pixel cat on the line with a check badge once they are linked.
struct PairLinkIllustration: View {
    var linked: Bool
    var cheering: Bool
    var reduceMotion: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 0) {
            device("laptopcomputer")
            ZStack {
                Line()
                    .trim(from: 0, to: linked ? 1 : 0)
                    .stroke(palette.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 8]))
                    .frame(height: 3)
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || !cheering)) { timeline in
                    // A small happy hop, twice a second, while the screen is up.
                    let t = timeline.date.timeIntervalSinceReferenceDate
                    let hop = reduceMotion || !cheering ? 0 : -abs(sin(t * .pi * 2)) * 6
                    PixelCat(happy: true)
                        .frame(width: 72, height: 72)
                        .overlay(alignment: .bottomTrailing) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 24, weight: .bold))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, palette.success)
                                .background(Circle().fill(palette.paper).padding(-2))
                                .offset(x: 6, y: 4)
                                .scaleEffect(cheering ? 1 : 0.01)
                        }
                        .offset(y: hop)
                }
                .scaleEffect(cheering ? 1 : 0.2)
                .opacity(cheering ? 1 : 0)
                .rotationEffect(.degrees(cheering || reduceMotion ? 0 : -25))
            }
            .frame(width: 128, height: 96)
            device("iphone")
        }
        .accessibilityElement()
        .accessibilityLabel("Your computer and this device are linked")
    }

    private func device(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 34, weight: .regular))
            .foregroundStyle(palette.ink)
            .frame(width: 72, height: 72)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(linked ? palette.accent : palette.line, lineWidth: linked ? 2 : 1))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            p.move(to: CGPoint(x: rect.minX + 6, y: rect.midY))
            p.addLine(to: CGPoint(x: rect.maxX - 6, y: rect.midY))
            return p
        }
    }
}

/// One burst of confetti from just above the middle of the screen, falling
/// away in about three seconds. Drawn, not views: dozens of pieces stay cheap.
struct ConfettiBurst: View {
    let start: Date
    let colors: [Color]
    /// The burst is done; the timeline stops redrawing.
    @State private var done = false

    var body: some View {
        TimelineView(.animation(paused: done)) { timeline in
            let t = timeline.date.timeIntervalSince(start)
            Canvas { context, size in
                let origin = CGPoint(x: size.width / 2, y: size.height * 0.36)
                for piece in ConfettiPiece.burst {
                    let pt = t - piece.delay
                    guard pt > 0 else { continue }
                    // Thrown up and out, then gravity, with a little air drag on the sideways speed.
                    let x = origin.x + piece.vx * pt * (1 - min(pt, 2.5) * 0.18) + sin(pt * piece.wobble) * 10
                    let y = origin.y + piece.vy * pt + 0.5 * 980 * pt * pt
                    let fade = max(0, min(1, (ConfettiPiece.life - pt) / 0.6))
                    guard fade > 0, y < size.height + 20 else { continue }
                    var c = context
                    c.opacity = fade
                    c.translateBy(x: x, y: y)
                    c.rotate(by: .radians(piece.spin * pt))
                    // Spinning paper: its width swings as it turns over.
                    c.scaleBy(x: cos(pt * piece.flip), y: 1)
                    let color = colors[piece.color % colors.count]
                    if piece.round {
                        c.fill(Path(ellipseIn: CGRect(x: -piece.size / 2, y: -piece.size / 2, width: piece.size, height: piece.size)), with: .color(color))
                    } else {
                        c.fill(Path(CGRect(x: -piece.size / 2, y: -piece.size / 4, width: piece.size, height: piece.size / 2)), with: .color(color))
                    }
                }
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(ConfettiPiece.life + 0.6))
            done = true
        }
        .accessibilityHidden(true)
    }
}

/// One piece of confetti's throw, fixed per launch so every burst looks the same.
struct ConfettiPiece {
    var vx, vy, delay, spin, flip, wobble, size: Double
    var color: Int
    var round: Bool

    /// Seconds a piece is on screen before it has faded out.
    static let life = 2.8

    static let burst: [ConfettiPiece] = {
        // A fixed seed: the same burst every time, and no Random in a render pass.
        var seed: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> Double {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(seed >> 11) / Double(1 << 53)
        }
        return (0..<56).map { i in
            let angle = (-90 + (next() - 0.5) * 130) * .pi / 180
            let speed = 420 + next() * 380
            return ConfettiPiece(vx: cos(angle) * speed, vy: sin(angle) * speed, delay: next() * 0.12,
                                 spin: (next() - 0.5) * 14, flip: 4 + next() * 8, wobble: 3 + next() * 4,
                                 size: 7 + next() * 6, color: i, round: next() < 0.25)
        }
    }()
}
