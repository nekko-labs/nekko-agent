import NekkoKit
import SwiftUI

// MARK: - Placement

/// Where the floating pill sits (option B, 2026-10-28): across the screen
/// (centred; at the top just under the bar by default), or stacked against
/// the left or right edge. Saved on this device, shared by every chat and Chats.
/// At a side or under the bar it can also be tucked away into a slim arrow tab.
struct PillPlacement: Equatable {
    enum Dock: String { case across, leading, trailing }

    var dock: Dock = .across
    /// 0 at the top of the space the pill may use, 1 at its bottom.
    var y: Double = 0
    /// Swiped into its edge: only the slim tab shows.
    var tucked = false

    static let standard = PillPlacement()

    /// Just under the bar, where content leaves room for it.
    var isStandard: Bool { dock == .across && y == 0 && !tucked }

    /// It sits against an edge it can be swiped into: a side, or the bar.
    var canTuck: Bool { dock != .across || y == 0 }

    /// Whether a swipe by `t` (or flung towards `predicted`) goes into the pill's edge.
    func swipesIn(_ t: CGSize, predicted: CGSize) -> Bool {
        guard canTuck else { return false }
        switch dock {
        case .across: return abs(t.height) > abs(t.width) && (t.height < -24 || predicted.height < -90)
        case .leading: return abs(t.width) > abs(t.height) && (t.width < -24 || predicted.width < -90)
        case .trailing: return abs(t.width) > abs(t.height) && (t.width > 24 || predicted.width > 90)
        }
    }

    /// Where a pill let go of with its centre at `center` settles: against an
    /// edge within 22% of the width of it, else across, snapping back under the
    /// bar within `snap` points of there. `minY`...`maxY` is the centre's travel.
    static func drop(center: CGPoint, width: CGFloat, minY: CGFloat, maxY: CGFloat, snap: CGFloat = 72) -> PillPlacement {
        let y = Double(min(1, max(0, (center.y - minY) / max(1, maxY - minY))))
        if width > 0 && center.x < width * 0.22 { return PillPlacement(dock: .leading, y: y) }
        if width > 0 && center.x > width * 0.78 { return PillPlacement(dock: .trailing, y: y) }
        return center.y - minY < snap ? .standard : PillPlacement(dock: .across, y: y)
    }

    var encoded: String { "\(dock.rawValue):\(y)" + (tucked ? ":tucked" : "") }

    static func parse(_ s: String?) -> PillPlacement {
        let parts = (s ?? "").split(separator: ":")
        guard parts.count == 2 || (parts.count == 3 && parts[2] == "tucked"),
              let dock = Dock(rawValue: String(parts[0])), let y = Double(parts[1]), y.isFinite else { return .standard }
        var place = PillPlacement(dock: dock, y: min(1, max(0, y)))
        place.tucked = parts.count == 3 && place.canTuck
        return place
    }
}

// MARK: - The pill

/// The minimal monitor in a glass capsule floating over the screen (option B),
/// while the hardware shows. Tap the gauges and it opens into the agent's
/// details; touch and hold to move it, or to dock it at a side; swipe it into
/// its edge to tuck it away as a slim arrow tab, which a tap brings back. Simple
/// and Detailed moved out of it into the menus (`ModeMenuPicker`, 2026-11-05),
/// so with no gauges there is no pill.
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
    /// When a finger last travelled across the pill. The gauges' tap still fires when a
    /// short swipe ends on the pill, and opening the details would take the pill (and
    /// its tuck) away before the swipe ends, so a tap this soon after is the swipe's.
    @State private var swipedAt: Date = .distantPast

    static let gap: CGFloat = 8
    /// The room a screen's scrolling content leaves above itself for the pill under the bar.
    static let topMargin: CGFloat = 52

    /// That room for a screen whose pill shows `gauges`: none with no pill, or with it elsewhere.
    static func room(_ place: PillPlacement, gauges: HardwareMonitorModel?) -> CGFloat {
        gauges != nil && place.isStandard ? topMargin : 0
    }

    private var morph: Animation? { reduceMotion ? nil : .spring(duration: 0.45, bounce: 0.24) }

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geo in
                    ZStack(alignment: .topLeading) {
                        if !expanded, let gauges {
                            if prefs.pillPlacement.tucked { tab(in: geo.size) } else { pill(gauges, in: geo.size) }
                        }
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

    @ViewBuilder private func pill(_ gauges: HardwareMonitorModel, in area: CGSize) -> some View {
        let place = prefs.pillPlacement
        let vertical = place.dock != .across
        let center = finger.map { CGPoint(x: $0.x - grab.width, y: $0.y - grab.height) } ?? Self.center(place, pill: size, area: area)
        MiniMonitor(monitor: gauges, open: open, vertical: vertical)
            .padding(.horizontal, vertical ? 4 : 10).padding(.vertical, vertical ? 10 : 4)
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
            .position(center)
            .offset(hidden && !lifted ? Self.away(place.dock, pill: size) : .zero)
            .opacity(hidden && !lifted ? 0 : 1)
            .allowsHitTesting(!hidden)
            .simultaneousGesture(move(area))
            .simultaneousGesture(tuck)
            .transition(.opacity)
            .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: hidden)
            .animation(reduceMotion ? nil : .spring(duration: 0.4, bounce: 0.2), value: place)
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: "Move to the top") { prefs.pillPlacement = .standard }
            .accessibilityAction(named: "Dock on the left") { prefs.pillPlacement = PillPlacement(dock: .leading, y: 0) }
            .accessibilityAction(named: "Dock on the right") { prefs.pillPlacement = PillPlacement(dock: .trailing, y: 0) }
            .accessibilityAction(named: "Tuck away") { setTucked(true) }
            .accessibilityIdentifier("chat.pill")
    }

    /// A quick swipe into the pill's edge tucks it away. A held pill is moving, not swiping.
    private var tuck: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { _ in swipedAt = .now }
            .onEnded { v in
                if !lifted && prefs.pillPlacement.swipesIn(v.translation, predicted: v.predictedEndTranslation) { setTucked(true) }
            }
    }

    private func setTucked(_ tucked: Bool) {
        guard prefs.pillPlacement.canTuck else { return }
        Haptics.tap()
        withAnimation(morph) { prefs.pillPlacement.tucked = tucked }
    }

    /// The tucked pill: a slim tab against its edge, its arrow pointing the way the pill comes back.
    @ViewBuilder private func tab(in area: CGSize) -> some View {
        let place = prefs.pillPlacement
        let across = place.dock == .across
        let shape = UnevenRoundedRectangle(cornerRadii: Self.tabCorners(place.dock), style: .continuous)
        let size = across ? CGSize(width: 56, height: 18) : CGSize(width: 18, height: 56)
        TabArrow(dock: place.dock)
            .stroke(palette.inkSoft, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            .frame(width: across ? 14 : 5, height: across ? 5 : 14)
            .frame(width: size.width, height: size.height)
            .background {
                shape.fill(.ultraThinMaterial)
                    .overlay(shape.fill(palette.surface.opacity(0.55)))
                    .overlay(shape.strokeBorder(palette.line, lineWidth: 0.5))
                    .matchedGeometryEffect(id: "pill", in: space)
                    .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
            }
            // A finger-sized target around the slim tab.
            .padding(across ? .horizontal : .vertical, 4)
            .frame(width: across ? nil : 44, height: across ? 44 : nil,
                   alignment: across ? .top : place.dock == .leading ? .leading : .trailing)
            .contentShape(Rectangle())
            .position(Self.tabCenter(place, area: area))
            .offset(hidden ? Self.away(place.dock, pill: CGSize(width: 44, height: 44)) : .zero)
            .opacity(hidden ? 0 : 1)
            .allowsHitTesting(!hidden)
            .onTapGesture { setTucked(false) }
            .gesture(DragGesture(minimumDistance: 12).onEnded { v in
                // Swiping it back out of its edge brings the pill back too.
                let out = PillPlacement(dock: place.dock, y: place.y)
                if !out.swipesIn(CGSize(width: -v.translation.width, height: -v.translation.height),
                                 predicted: CGSize(width: -v.predictedEndTranslation.width, height: -v.predictedEndTranslation.height)) { return }
                setTucked(false)
            })
            .transition(.opacity)
            .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: hidden)
            .accessibilityElement()
            .accessibilityLabel("Show the hardware monitor")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { setTucked(false) }
            .accessibilityIdentifier("chat.pill.tab")
    }

    /// Flush against its edge, so only the inner corners round.
    static func tabCorners(_ dock: PillPlacement.Dock) -> RectangleCornerRadii {
        switch dock {
        case .across: return RectangleCornerRadii(bottomLeading: 9, bottomTrailing: 9)
        case .leading: return RectangleCornerRadii(bottomTrailing: 9, topTrailing: 9)
        case .trailing: return RectangleCornerRadii(topLeading: 9, bottomLeading: 9)
        }
    }

    /// The tab's 44-point target's centre: hanging from the bar, or against its side at the pill's height.
    static func tabCenter(_ place: PillPlacement, area: CGSize) -> CGPoint {
        switch place.dock {
        case .across: return CGPoint(x: area.width / 2, y: 22)
        case .leading: return CGPoint(x: 22, y: center(place, pill: CGSize(width: 44, height: 112), area: area).y)
        case .trailing: return CGPoint(x: area.width - 22, y: center(place, pill: CGSize(width: 44, height: 112), area: area).y)
        }
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
        guard monitor != nil, !lifted, Date.now.timeIntervalSince(swipedAt) > 0.4 else { return }
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

/// The tab's flat arrow, pointing out of the edge the way the pill comes back.
struct TabArrow: Shape {
    var dock: PillPlacement.Dock

    func path(in r: CGRect) -> Path {
        Path { p in
            switch dock {
            case .across: p.addLines([CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.midX, y: r.maxY), CGPoint(x: r.maxX, y: r.minY)])
            case .leading: p.addLines([CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.midY), CGPoint(x: r.minX, y: r.maxY)])
            case .trailing: p.addLines([CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.minX, y: r.midY), CGPoint(x: r.maxX, y: r.maxY)])
            }
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
