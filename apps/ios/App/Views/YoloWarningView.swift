import NekkoKit
import NekkoProtocol
import SwiftUI

/// A switch to YOLO waiting on the warning: what to do when the user goes ahead.
struct YoloAsk: Identifiable {
    let id = UUID()
    let proceed: @MainActor () -> Void
}

@MainActor
extension Prefs {
    /// Moving a chat (or new chats) from `current` to `next`: runs `proceed` now
    /// and returns nil, or, when that turns YOLO on and the user wasn't told not
    /// to warn again, returns the warning to show (`yoloWarning(_:)`), which runs
    /// `proceed` only on "Turn on YOLO" (decision 0054).
    func gateYolo(from current: PcSettings.ChatMode?, to next: PcSettings.ChatMode,
                  _ proceed: @escaping @MainActor () -> Void) -> YoloAsk? {
        guard YoloWarning.needed(from: current, to: next, skipped: skipYoloWarning) else {
            proceed()
            return nil
        }
        return YoloAsk(proceed: proceed)
    }
}

extension View {
    /// Shows the YOLO warning while `ask` is set. Every place that can turn YOLO
    /// on uses this one sheet: the chat's tool policy (Expert's menu and Simple's
    /// picker), New chat's choice and the computer's default for new chats.
    @MainActor func yoloWarning(_ ask: Binding<YoloAsk?>) -> some View {
        sheet(item: ask) { a in
            YoloWarningSheet(proceed: {
                ask.wrappedValue = nil
                a.proceed()
            }, cancel: { ask.wrappedValue = nil })
        }
    }
}

/// "Turn on YOLO?": what YOLO means for data, with "Keep asking" as the safe choice.
/// The desktop's `YoloWarning.tsx`, word for word.
struct YoloWarningSheet: View {
    let proceed: @MainActor () -> Void
    let cancel: @MainActor () -> Void
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    @State private var dontWarn = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "exclamationmark.triangle.fill").font(.title).foregroundStyle(palette.warning)
                    .accessibilityHidden(true)
                Text("Turn on YOLO?").font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("yoloWarning.title")
                Text("The agent will run commands, edit files, fetch addresses and call tools without asking you first. A web page, search result or tool output it reads can carry instructions, and in YOLO nothing stops them from sending your files or data out of this computer. Your deny rules still block.")
                    .font(.subheadline).foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Guardrails asks only when it matters, and is the recommended mode.")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 4) {
                    Toggle("Don’t warn me again", isOn: $dontWarn)
                        .font(.subheadline).foregroundStyle(palette.ink).tint(palette.accent)
                        .accessibilityIdentifier("yoloWarning.dontWarn")
                    Text("You can turn the warning back on in Settings.")
                        .font(.caption).foregroundStyle(palette.inkSoft)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(spacing: 10) {
                    // The safe choice is the prominent one, and changes nothing.
                    Button { cancel() } label: {
                        Text("Keep asking").font(.body.weight(.semibold)).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(palette.onAccent)
                            .padding(.vertical, 10).frame(maxWidth: .infinity, minHeight: 50)
                            .background(palette.accent, in: RoundedRectangle(cornerRadius: 8))
                            .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("yoloWarning.cancel")
                    Button {
                        if dontWarn { prefs.skipYoloWarning = true }
                        proceed()
                    } label: {
                        Text("Turn on YOLO").font(.body.weight(.semibold)).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(palette.danger)
                            .padding(.vertical, 10).frame(maxWidth: .infinity, minHeight: 50)
                            .background(RoundedRectangle(cornerRadius: 8).stroke(palette.line))
                            .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("yoloWarning.confirm")
                }
                .padding(.top, 4)
            }
            .padding(20)
        }
        .background(palette.surface.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
