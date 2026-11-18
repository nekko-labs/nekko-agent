import NekkoKit
import NekkoProtocol
import SwiftUI

/// One quiet line under the model (#2923; nekko-designs/iphone-new-chat-design.html §3): a 3pt meter
/// and the tightest window's words, faint below 75%, the warning colour from 75%, danger when reached.
struct LimitLineView: View {
    let line: LimitLine
    /// At the limit, a link to pick another model.
    var switchModel: (() -> Void)?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Capsule().fill(palette.line).frame(width: 28, height: 3)
                .overlay(alignment: .leading) {
                    Capsule().fill(tint).frame(width: 28 * CGFloat(min(100, line.percent)) / 100, height: 3)
                }
                .accessibilityHidden(true)
            Text(words).font(.caption.monospacedDigit()).foregroundStyle(line.level == .quiet ? palette.inkSoft : tint).lineLimit(1)
            if line.level == .reached, let switchModel {
                Button("Switch model", action: switchModel).font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                    .accessibilityIdentifier("limitLine.switchModel")
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 24)
        .animation(.easeOut(duration: 0.26), value: line)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("limitLine")
    }

    private var tint: Color {
        switch line.level {
        case .quiet: palette.inkFaint
        case .near: palette.warning
        case .reached: palette.danger
        }
    }

    private var words: String {
        let label = line.window.label
        let main = line.level == .reached ? String(localized: "\(label) limit reached") : String(localized: "\(line.percent)% of \(label) limit")
        guard let reset = line.window.resetAt, reset > 0 else { return main }
        let time = Date(timeIntervalSince1970: Double(reset) / 1000).formatted(date: .omitted, time: .shortened)
        return String(localized: "\(main) · resets \(time)")
    }
}

/// The limit line for one of this iPhone's providers, from the rate-limit headers of its last answer
/// (kept in memory only). Rechecked every few seconds, so a budget past its reset reads as unused.
struct PhoneLimitLine: View {
    let providerId: String?
    var switchModel: (() -> Void)?
    @Environment(PhoneChats.self) private var phone

    var body: some View {
        if let providerId, let limits = phone.rateLimits[providerId] {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                if let line = LimitLine.tightest(limits.providerLimits(now: Int64(context.date.timeIntervalSince1970 * 1000))) {
                    LimitLineView(line: line, switchModel: switchModel)
                }
            }
            .transition(.opacity)
        }
    }
}

/// The limit line for a provider on the active computer: `limits:get`, asked again every 30 seconds
/// while it shows. Nothing until the computer reports a window.
struct ComputerLimitLine: View {
    let providerId: String?
    var switchModel: (() -> Void)?
    @Environment(ComputersStore.self) private var store
    @State private var limits: ProviderLimits?

    var body: some View {
        Group {
            if let line = LimitLine.tightest(limits) { LimitLineView(line: line, switchModel: switchModel).transition(.opacity) }
        }
        .animation(.easeOut(duration: 0.16), value: limits == nil)
        .task(id: "\(store.activeId ?? "")|\(providerId ?? "")|\(store.conn == .online)") { await watch() }
    }

    private func watch() async {
        limits = nil
        guard let providerId, store.conn == .online else { return }
        while !Task.isCancelled {
            if let remote = try? store.remote() {
                let value = try? await remote.call(Channels.limitsGet, [.string(providerId)])
                guard !Task.isCancelled else { return }
                limits = ProviderLimits.from(value)
            }
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
        }
    }
}
