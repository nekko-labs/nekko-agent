import NekkoKit
import SwiftUI

/// The in-chat GitHub star ask under a finished reply (spec/platform/github-star-ask.md),
/// the desktop's `GitHubStarAsk.tsx`. The phone has no GitHub connector star, so
/// Star on GitHub opens the repository in the browser; nothing is starred here.
struct GitHubStarAsk: View {
    /// Star on GitHub or Don't ask again: never asked again.
    var stop: () -> Void
    /// The card goes (Not now, or Close after the thank-you).
    var close: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.openURL) private var openURL
    @State private var opened = false
    @State private var openFailed = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: opened ? "star.fill" : "star")
                .font(.body.weight(.semibold)).foregroundStyle(palette.accent)
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(opened ? LocalizedStringKey("Thank you! Nekko is happy you’re here.") : "Nekko Agent is open source")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("starAsk.title")
                Text(opened ? LocalizedStringKey("GitHub opened in your browser. Starring there takes one click.") : "If it helps you, a star on GitHub helps more people find it.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                if openFailed {
                    Text("Couldn’t open GitHub. Visit \(StarAsk.repository.absoluteString) in your browser.")
                        .font(.footnote).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if !opened {
                    // One row while it fits; stacked at large text sizes or in a narrow pane.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 4) { buttons }
                        VStack(alignment: .leading, spacing: 0) { buttons }
                    }
                    .padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if opened {
                Button(action: close) {
                    Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkSoft)
                        .frame(width: 32, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityIdentifier("starAsk.close")
            }
        }
        .padding(14)
        // The surface the chat's other inline notes use, so it reads as part of the transcript.
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Star Nekko Agent on GitHub")
        .accessibilityIdentifier("starAsk.card")
        .animation(.easeOut(duration: 0.2), value: opened)
    }

    @ViewBuilder private var buttons: some View {
        // Drawn rather than .borderedProminent, as the approval card's Allow, so its label never clips.
        Button(action: star) {
            Label("Star on GitHub", systemImage: "star.fill")
                .font(.subheadline.weight(.semibold)).foregroundStyle(palette.onAccent)
                .padding(.horizontal, 14).frame(minHeight: 44)
                .background(palette.accent, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityIdentifier("starAsk.star")
        Button(action: close) {
            Text("Not now").font(.subheadline.weight(.semibold)).foregroundStyle(palette.inkSoft)
                .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityIdentifier("starAsk.later")
        Button {
            stop()
            close()
        } label: {
            Text("Don’t ask again").font(.subheadline).foregroundStyle(palette.inkSoft)
                .padding(.horizontal, 10).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityIdentifier("starAsk.never")
    }

    /// Opens the repository and thanks them; asking ends here either way. Opening GitHub
    /// does not claim a star was made.
    private func star() {
        stop()
        openFailed = false
        openURL(StarAsk.repository) { accepted in
            if accepted { opened = true } else { openFailed = true }
        }
    }
}
