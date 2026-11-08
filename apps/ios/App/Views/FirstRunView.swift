import AVKit
import NekkoKit
import NekkoProtocol
import SwiftUI

/// First run (IO-31), three steps shown once: what the app does (this view),
/// pairing (`WelcomeView`, step 2), and a permission checklist explaining what
/// each feature uses (`NotificationStepView`, after the first pairing, because
/// permission is asked only once a computer is paired). Skip ends it.
struct FirstRunIntroView: View {
    var next: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var customizing = false

    var body: some View {
        if customizing {
            FirstRunExperienceView(next: next)
        } else {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StepLabel(step: 1)
                BrandMark().frame(width: 64, height: 64)
                Text("Your agent, in your pocket").font(.largeTitle.weight(.bold)).foregroundStyle(palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Nekko Agent runs on your computer. This app lets you drive it from anywhere.")
                    .foregroundStyle(palette.inkSoft)
                VStack(alignment: .leading, spacing: 16) {
                    point("text.bubble", "Follow chats as they stream", "Watch your computer work, and start new chats from here.")
                    point("checkmark.shield", "Approve tools and answer questions", "When the agent needs you, you decide, even from the Lock Screen.")
                    point("lock", "Private by design", "Everything is end-to-end encrypted between this iPhone and your computer.")
                }
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            Button { customizing = true } label: {
                Text("Continue").frame(maxWidth: .infinity).padding(.vertical, 6).foregroundStyle(palette.onAccent)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("firstRun.continue")
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.bar)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Skip") { app.prefs.onboarded = true }.accessibilityIdentifier("firstRun.skip")
            }
        }
        .background(palette.paper)
        }
    }

    private func point(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.title3).foregroundStyle(palette.accent).frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(palette.ink)
                Text(text).font(.subheadline).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Customize the presentation before pairing; the demo is a shared Remotion render.
private struct FirstRunExperienceView: View {
    var next: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var player: AVPlayer?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Customize your experience").font(.largeTitle.weight(.bold))
                Text("A focused summary or the working details—you choose. Both modes have the same capabilities.")
                    .foregroundStyle(palette.inkSoft)
                if let player {
                    VideoPlayer(player: player)
                        .aspectRatio(640.0 / 380.0, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .accessibilityLabel("Simple and Detailed output example")
                        .accessibilityHint("An illustrative keyboard-button fix. Simple folds the three working steps. Detailed shows reading, editing code and a passing test. Both end with the same result.")
                        .accessibilityIdentifier("experience.video")
                }
                ExperienceModePicker()
                Text("You can change this any time in View options → Customize. Find visual preferences, monitors, connectors and skills there. This choice stays on this iPhone and does not change tool permissions.")
                    .font(.subheadline).foregroundStyle(palette.inkSoft)
            }
            .padding(20)
        }
        .safeAreaInset(edge: .bottom) {
            Button(action: next) { Text("Continue").frame(maxWidth: .infinity).padding(.vertical, 6) }
                .buttonStyle(.borderedProminent).padding(20)
                .accessibilityIdentifier("experience.continue")
        }
        .background(palette.paper)
        .onAppear {
            guard player == nil, let url = Bundle.main.url(forResource: "experience-intro", withExtension: "mp4") else { return }
            let video = AVPlayer(url: url)
            player = video
            if !reduceMotion { video.play() }
        }
        .onDisappear { player?.pause() }
    }
}

/// The pairing and notification milestones; customization is part of the introduction.
struct StepLabel: View {
    let step: Int
    @Environment(\.palette) private var palette

    var body: some View {
        Text("Step \(step) of 3").font(.footnote.weight(.semibold)).foregroundStyle(palette.inkSoft)
    }
}

/// Step 3: review each system permission after pairing. Optional tools can wait.
struct NotificationStepView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            PermissionChecklistView {
                Task { await app.finishOnboarding(allowNotifications: false) }
            }
        }
    }
}

/// A drawing of a Lock Screen notification, so step 3 shows what to expect.
struct NotificationPreview: View {
    let title: String
    let text: String
    let actions: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                CatMark().frame(width: 22, height: 22).padding(6).foregroundStyle(palette.onAccent)
                    .background(palette.accent, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                        Spacer()
                        Text("now").font(.caption).foregroundStyle(palette.inkSoft)
                    }
                    Text(text).font(.subheadline).foregroundStyle(palette.ink)
                }
            }
            if actions {
                HStack(spacing: 8) {
                    Text("Allow").frame(maxWidth: .infinity).padding(.vertical, 8)
                        .background(palette.surface2, in: RoundedRectangle(cornerRadius: 10))
                    Text("Deny").foregroundStyle(palette.danger).frame(maxWidth: .infinity).padding(.vertical, 8)
                        .background(palette.surface2, in: RoundedRectangle(cornerRadius: 10))
                }
                .font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
            }
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(palette.line))
    }
}
