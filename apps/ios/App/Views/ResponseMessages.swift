import NekkoKit
import SwiftUI

/// A response remains a message while the computer is unreachable, not a failed form submission.
struct ResponseMessageRow: View {
    let message: ResponseMessage
    var retry: () -> Void
    var cancel: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var status: String {
        switch message.status {
        case "sending": return String(localized: "Sending…")
        case "sent": return String(localized: "Sent")
        case "stale": return String(localized: "No longer pending")
        case "failed": return String(localized: "Couldn't send response")
        default: return String(localized: "Pending · sends when connected")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 8) {
                Text(message.text).foregroundStyle(palette.ink).textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
                HStack(spacing: 8) {
                    if message.status == "sending" { ProgressView().controlSize(.mini) }
                    Text(status)
                }
                .font(.caption).foregroundStyle(palette.inkSoft)
                Text(message.pendingId).font(.caption2.monospaced()).foregroundStyle(palette.inkFaint)
                    .lineLimit(1).truncationMode(.middle)
                    .accessibilityLabel("Request identifier: \(message.pendingId)")
                if let error = message.error {
                    Text(error).font(.caption).foregroundStyle(palette.inkSoft).multilineTextAlignment(.trailing)
                }
                if message.unsent && message.status != "sending" {
                    HStack(spacing: 16) {
                        Button("Retry", action: retry).accessibilityIdentifier("response.retry")
                        Button("Cancel", role: .destructive, action: cancel).accessibilityIdentifier("response.cancel")
                    }
                    .buttonStyle(.plain).font(.footnote)
                    .frame(minHeight: 44).foregroundStyle(palette.inkSoft)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.response")
        .animation(.easeOut(duration: reduceMotion ? 0.12 : 0.2), value: message.status)
        .transition(.opacity)
    }
}
