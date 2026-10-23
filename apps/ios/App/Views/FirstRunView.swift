import NekkoKit
import NekkoProtocol
import SwiftUI

/// First run (IO-31), three steps shown once: what the app does (this view),
/// pairing (`WelcomeView`, step 2), and notifications with a preview of what
/// they look like (`NotificationStepView`, after the first pairing, because
/// permission is asked only once a computer is paired). Skip ends it.
struct FirstRunIntroView: View {
    var next: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StepLabel(step: 1)
                BrandTile().frame(width: 64, height: 64)
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
            Button(action: next) {
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

/// "Step 2 of 3" over each first-run screen.
struct StepLabel: View {
    let step: Int
    @Environment(\.palette) private var palette

    var body: some View {
        Text("Step \(step) of 3").font(.footnote.weight(.semibold)).foregroundStyle(palette.inkSoft)
    }
}

/// Step 3: what notifications look like, then iOS's own question (asked only
/// now, after pairing). *Not now* leaves them off; Settings can turn them on.
struct NotificationStepView: View {
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var asking = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    StepLabel(step: 3)
                    Text("Know when your computer needs you").font(.title.weight(.bold)).foregroundStyle(palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text("A notification when a tool waits for your approval, when the agent asks a question, and when a reply finishes or fails. Choose which in Settings.")
                        .foregroundStyle(palette.inkSoft)
                    VStack(spacing: 10) {
                        NotificationPreview(title: "Nekko needs you", text: "Approve? Run npm test", actions: true)
                        NotificationPreview(title: store.active?.name ?? "Your computer", text: "Finished on \(store.active?.name ?? "your computer").",
                                            actions: false)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Preview: an approval with Allow and Deny, and a finished reply.")
                    Text("Pushed notifications say only what happened, never what your chats say. With the app lock on, the ones the app shows say less too.")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                }
                .padding(20)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button {
                        asking = true
                        Task { await app.finishOnboarding(allowNotifications: true) }
                    } label: {
                        Text("Allow notifications").frame(maxWidth: .infinity).padding(.vertical, 6).foregroundStyle(palette.onAccent)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(asking)
                    .accessibilityIdentifier("firstRun.allowNotifications")
                    Button("Not now") { Task { await app.finishOnboarding(allowNotifications: false) } }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("firstRun.notNow")
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(.bar)
            }
            .background(palette.paper)
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
