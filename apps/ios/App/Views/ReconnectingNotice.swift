import SwiftUI

/// The dots occupy their final width throughout the cycle. Only their opacity changes.
struct ReconnectingNotice: View {
    let name: String
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("\(name) is reconnecting")
                TimelineView(.animation(minimumInterval: 0.4, paused: reduceMotion || phase != .active)) { timeline in
                    let visible = reduceMotion ? 3 : Int(timeline.date.timeIntervalSinceReferenceDate / 0.4) % 3 + 1
                    HStack(spacing: 0) {
                        ForEach(0..<3, id: \.self) { i in Text(".").opacity(i < visible ? 1 : 0) }
                    }
                }
                .accessibilityHidden(true)
            }
            .font(.footnote.weight(.medium))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name) is reconnecting...")
            .accessibilityIdentifier("reconnect.title")
            Text("Draft your message now and it will send when \(name) reconnects")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        // Keep child labels and identifiers distinct from the parent notice identifier.
        .accessibilityElement(children: .contain)
        .foregroundStyle(palette.inkSoft)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
