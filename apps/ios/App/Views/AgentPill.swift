import NekkoKit
import SwiftUI

// MARK: - Placement

/// Where the floating pill sits (option B, 2026-10-28): across the screen
/// (centred; at the top just under the bar by default), or stacked against
/// the left or right edge. Saved on this device, shared by every chat and Chats.
struct PillPlacement: Equatable {
    enum Dock: String { case across, leading, trailing }

    var dock: Dock = .across
    /// 0 at the top of the space the pill may use, 1 at its bottom.
    var y: Double = 0

    static let standard = PillPlacement()

    /// Just under the bar, where content leaves room for it.
    var isStandard: Bool { dock == .across && y == 0 }

    /// Where a pill let go of with its centre at `center` settles: against an
    /// edge within 22% of the width of it, else across, snapping back under the
    /// bar within `snap` points of there. `minY`...`maxY` is the centre's travel.
    static func drop(center: CGPoint, width: CGFloat, minY: CGFloat, maxY: CGFloat, snap: CGFloat = 72) -> PillPlacement {
        let y = Double(min(1, max(0, (center.y - minY) / max(1, maxY - minY))))
        if width > 0 && center.x < width * 0.22 { return PillPlacement(dock: .leading, y: y) }
        if width > 0 && center.x > width * 0.78 { return PillPlacement(dock: .trailing, y: y) }
        return center.y - minY < snap ? .standard : PillPlacement(dock: .across, y: y)
    }

    var encoded: String { "\(dock.rawValue):\(y)" }

    static func parse(_ s: String?) -> PillPlacement {
        let parts = (s ?? "").split(separator: ":")
        guard parts.count == 2, let dock = Dock(rawValue: String(parts[0])), let y = Double(parts[1]), y.isFinite else { return .standard }
        return PillPlacement(dock: dock, y: min(1, max(0, y)))
    }
}

private struct PillMovingKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// The pill is lifted and moving; its switch ignores the touch.
    var pillMoving: Bool {
        get { self[PillMovingKey.self] }
        set { self[PillMovingKey.self] = newValue }
    }
}

// MARK: - The pill

/// The Simple and Expert switch and the minimal monitor in a glass capsule
/// floating over the screen (option B). Tap the gauges and it opens into the
/// agent's details; touch and hold to move it, or to dock it at a side.
struct AgentPillLayer: ViewModifier {
    /// The minimal monitor's readings, while the gauges show.
    var gauges: HardwareMonitorModel?
    /// What the details card shows: the computer's monitor and this chat.
    var monitor: HardwareMonitorModel?
    var chat: ChatModel?
    /// Scrolled away, or the search row is showing.
    var hidden = false
    @Binding var expanded: Bool
    @Environment(Prefs.self) private var prefs
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var space
    @State private var size: CGSize = .zero
    /// While lifted: the finger, and where it took the pill from its centre.
    @State private var finger: CGPoint?
    @State private var grab: CGSize = .zero
    @State private var lifted = false
    @State private var swipe: CGFloat = 0

    static let gap: CGFloat = 8
    /// The room a screen's scrolling content leaves above itself for the pill under the bar.
    static let topMargin: CGFloat = 52

    private var morph: Animation? { reduceMotion ? nil : .spring(duration: 0.45, bounce: 0.24) }

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geo in
                    ZStack(alignment: .topLeading) {
                        if !expanded { pill(in: geo.size) }
                    }
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                }
                .coordinateSpace(.named("pillArea"))
            }
            .overlay(alignment: .top) {
                if expanded, let monitor { card(monitor) }
            }
    }

    // MARK: Collapsed

    @ViewBuilder private func pill(in area: CGSize) -> some View {
        let place = prefs.pillPlacement
        let vertical = place.dock != .across
        let center = finger.map { CGPoint(x: $0.x - grab.width, y: $0.y - grab.height) } ?? Self.center(place, pill: size, area: area)
        body(vertical: vertical)
            .padding(4)
            .background {
                Capsule().fill(.ultraThinMaterial)
                    .overlay(Capsule().fill(palette.surface.opacity(0.55)))
                    .overlay(Capsule().strokeBorder(palette.line, lineWidth: 0.5))
                    .matchedGeometryEffect(id: "pill", in: space)
                    .shadow(color: .black.opacity(lifted ? 0.22 : 0.12), radius: lifted ? 16 : 8, y: lifted ? 8 : 3)
            }
            .fixedSize()
            .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
            .scaleEffect(lifted ? 1.06 : 1)
            .environment(\.pillMoving, lifted)
            .position(center)
            .offset(hidden && !lifted ? Self.away(place.dock, pill: size) : .zero)
            .opacity(hidden && !lifted ? 0 : 1)
            .allowsHitTesting(!hidden)
            .simultaneousGesture(move(area))
            .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: hidden)
            .animation(reduceMotion ? nil : .spring(duration: 0.4, bounce: 0.2), value: place)
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: "Move to the top") { prefs.pillPlacement = .standard }
            .accessibilityAction(named: "Dock on the left") { prefs.pillPlacement = PillPlacement(dock: .leading, y: 0) }
            .accessibilityAction(named: "Dock on the right") { prefs.pillPlacement = PillPlacement(dock: .trailing, y: 0) }
            .accessibilityIdentifier("chat.pill")
    }

    @ViewBuilder private func body(vertical: Bool) -> some View {
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            ModeToggle(vertical: vertical)
            if let gauges {
                Rectangle().fill(palette.line).frame(width: vertical ? 24 : 0.5, height: vertical ? 0.5 : 20)
                    .accessibilityHidden(true)
                MiniMonitor(monitor: gauges, open: open, vertical: vertical)
                    .padding(vertical ? .vertical : .trailing, 6)
                    .transition(.opacity.combined(with: .scale(0.8)))
            }
        }
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: gauges != nil)
    }

    /// Touch and hold lifts the pill; it follows the finger and settles where it is let go.
    private func move(_ area: CGSize) -> some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("pillArea")))
            .onChanged { value in
                guard case .second(true, let drag) = value else { return }
                if !lifted {
                    Haptics.tap()
                    withAnimation(.spring(duration: 0.25)) { lifted = true }
                }
                guard let drag else { return }
                if finger == nil {
                    let c = Self.center(prefs.pillPlacement, pill: size, area: area)
                    grab = CGSize(width: drag.startLocation.x - c.x, height: drag.startLocation.y - c.y)
                }
                finger = drag.location
            }
            .onEnded { value in
                if case .second(true, let drag?) = value {
                    let c = CGPoint(x: drag.location.x - grab.width, y: drag.location.y - grab.height)
                    let next = PillPlacement.drop(center: c, width: area.width, minY: Self.minY(pill: size), maxY: Self.maxY(pill: size, area: area))
                    withAnimation(.spring(duration: 0.4, bounce: 0.2)) {
                        prefs.pillPlacement = next
                        finger = nil
                    }
                    Haptics.tap()
                } else {
                    finger = nil
                }
                // A tick later, so the switch under the finger still sees the pill as moving.
                DispatchQueue.main.async { withAnimation(.spring(duration: 0.25)) { lifted = false } }
            }
    }

    private func open() {
        guard monitor != nil else { return }
        withAnimation(morph) { expanded = true }
    }

    private func close() {
        withAnimation(morph) { expanded = false }
    }

    static func minY(pill: CGSize) -> CGFloat { gap + pill.height / 2 }
    static func maxY(pill: CGSize, area: CGSize) -> CGFloat { max(minY(pill: pill), area.height - gap - pill.height / 2) }

    /// The pill's centre for `place` in `area`.
    static func center(_ place: PillPlacement, pill: CGSize, area: CGSize) -> CGPoint {
        let y = minY(pill: pill) + CGFloat(place.y) * (maxY(pill: pill, area: area) - minY(pill: pill))
        switch place.dock {
        case .across: return CGPoint(x: area.width / 2, y: y)
        case .leading: return CGPoint(x: 12 + pill.width / 2, y: y)
        case .trailing: return CGPoint(x: area.width - 12 - pill.width / 2, y: y)
        }
    }

    /// Where a scrolled-away pill goes: up out of sight, or out past its edge.
    static func away(_ dock: PillPlacement.Dock, pill: CGSize) -> CGSize {
        switch dock {
        case .across: return CGSize(width: 0, height: -(pill.height + 24))
        case .leading: return CGSize(width: -(pill.width + 24), height: 0)
        case .trailing: return CGSize(width: pill.width + 24, height: 0)
        }
    }

    // MARK: Expanded

    /// The pill opened into a card under the bar, morphing from wherever it sat.
    private func card(_ monitor: HardwareMonitorModel) -> some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.25)
                .ignoresSafeArea()
                .onTapGesture { close() }
                .accessibilityLabel("Close")
                .accessibilityAddTraits(.isButton)
                .transition(.opacity)
            VStack(spacing: 0) {
                AgentPanel(monitor: monitor, chat: chat, close: close)
                    .transition(.opacity.combined(with: .scale(0.94, anchor: .top)).animation(.easeOut(duration: 0.25).delay(0.08)))
                Capsule().fill(palette.inkFaint.opacity(0.5)).frame(width: 36, height: 5)
                    .frame(maxWidth: .infinity, minHeight: 20)
                    .accessibilityHidden(true)
            }
            .background {
                RoundedRectangle(cornerRadius: 28, style: .continuous).fill(palette.paper)
                    .matchedGeometryEffect(id: "pill", in: space)
                    .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
            }
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.top, Self.gap)
            .offset(y: min(0, swipe))
            .simultaneousGesture(DragGesture(minimumDistance: 12)
                .onChanged { v in if v.translation.height < 0 { swipe = v.translation.height } }
                .onEnded { v in
                    if v.translation.height < -60 || v.predictedEndTranslation.height < -160 { close() }
                    withAnimation(.snappy) { swipe = 0 }
                })
            .accessibilityAction(.escape) { close() }
        }
    }
}

extension View {
    /// The floating pill over this screen; see `AgentPillLayer`. The screen's scroll view
    /// leaves `AgentPillLayer.topMargin` above its content while the pill is in its standard place.
    func agentPill(gauges: HardwareMonitorModel?, monitor: HardwareMonitorModel?, chat: ChatModel? = nil,
                   hidden: Bool = false, expanded: Binding<Bool>) -> some View {
        modifier(AgentPillLayer(gauges: gauges, monitor: monitor, chat: chat, hidden: hidden, expanded: expanded))
    }

    /// Sets `hidden` as the reader scrolls on, and clears it on the way back or at the top.
    /// Only for the person's own scrolling (from iOS 18); before that the pill stays put.
    func hidesPillOnScroll(_ hidden: Binding<Bool>) -> some View {
        modifier(PillScrollHide(hidden: hidden))
    }
}

struct PillScrollHide: ViewModifier {
    @Binding var hidden: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) { content.modifier(Tracker(hidden: $hidden)) } else { content }
    }

    @available(iOS 18.0, *)
    private struct Tracker: ViewModifier {
        @Binding var hidden: Bool
        @State private var phase: ScrollPhase = .idle

        func body(content: Content) -> some View {
            content
                .onScrollPhaseChange { _, p in phase = p }
                .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { old, new in
                    if let next = PillScrollHide.next(hidden: hidden, from: old, to: new, scrolling: phase != .idle), next != hidden { hidden = next }
                }
        }
    }

    /// At the top it shows; a scroll by the person on through the content hides it, back shows it.
    static func next(hidden: Bool, from old: CGFloat, to new: CGFloat, scrolling: Bool) -> Bool? {
        if new <= 4 { return false }
        guard scrolling else { return nil }
        if new - old > 6 { return true }
        if new - old < -6 { return false }
        return nil
    }
}
