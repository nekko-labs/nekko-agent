import CoreTransferable
import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The note shown with the folding-phone layout (owner's words, kept exactly).
/// "let us know" opens the public issue tracker.
enum FoldableNote {
    static let text = "The Devs don’t have a foldable phone to test this one, so we tried our best without one! If you see any issues, please let us know 🙏"
    static let issues = URL(string: "https://github.com/nekko-labs/nekko-agent/issues/new")!

    /// The note with "let us know" as a link.
    static var attributed: AttributedString {
        var a = AttributedString(text)
        if let r = a.range(of: "let us know") {
            a[r].link = issues
            a[r].underlineStyle = .single
        }
        return a
    }
}

// MARK: - Environment

private struct PaneHingeKey: EnvironmentKey {
    static let defaultValue: CGRect? = nil
}

private struct InPanesKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Tabletop: the hinge, in window points, for the pane in flex layout (ChatView puts the composer below it).
    var paneHinge: CGRect? {
        get { self[PaneHingeKey.self] }
        set { self[PaneHingeKey.self] = newValue }
    }

    /// Inside the two-pane host: messages can be dragged to the other pane.
    var inPanes: Bool {
        get { self[InPanesKey.self] }
        set { self[InPanesKey.self] = newValue }
    }
}

// MARK: - The panes' state

/// The two panes on a regular-width screen (folding phone open, iPad): the
/// layout remembered per computer in `Prefs`, each pane's own navigation, and
/// the one-time *Chat + Chat* tip. RootView owns it, so a chat opened from a
/// notification, a link or a fork lands in the right pane.
@MainActor
@Observable
final class PaneHost {
    private(set) var layout: PaneLayout = .standard
    /// What each pane pushed inside itself (Settings, Files, a computer's page).
    private(set) var paths: [String: [Route]] = [:]
    /// The *Chat + Chat* tip on screen: the layout it switches to.
    private(set) var tip: PaneLayout?
    private(set) var computerId: String?
    private var prefs: Prefs?
    private var loaded = false

    /// Read the layout last used with this computer (once per computer).
    func sync(computer id: String?, prefs: Prefs) {
        self.prefs = prefs
        guard !loaded || id != computerId else { return }
        loaded = true
        computerId = id
        layout = prefs.paneLayout(id)
        paths = [:]
        tip = nil
    }

    func update(_ change: (inout PaneLayout) -> Void) {
        var l = layout
        change(&l)
        guard l != layout else { return }
        layout = l
        prefs?.setPaneLayout(l, for: computerId)
    }

    func focus(_ id: String) {
        guard layout.focusedId != id else { return }
        update { $0.focus(id) }
    }

    /// Show `content` (from pane `source`, or from outside). The first time a
    /// second chat opens while the one on screen is working, offer *Chat + Chat*.
    func open(_ content: PaneContent, from source: String? = nil, running: Set<String> = []) {
        let before = layout
        var landed = layout.focusedId
        update { landed = $0.open(content, from: source) }
        paths[landed] = []
        if case .chat(let id) = content, let prefs, !prefs.paneTipShown, before.offersChatChat(opening: id, running: running) {
            var both = before
            both.takeChatChat(adding: id)
            tip = both
            prefs.paneTipShown = true
        }
    }

    /// Push a route inside the focused pane (Settings, Files… from outside the panes).
    func push(_ route: Route) {
        paths[layout.focusedId, default: []].append(route)
    }

    func takeTip() {
        if let t = tip { update { $0 = t } }
        tip = nil
    }

    func dismissTip() { tip = nil }

    // MARK: Each pane's navigation

    /// Pane `id`'s navigation path as `display` shows it. With the list behind
    /// the pane (open, tall), the list is the root and the pane's chat is pushed on it.
    func path(_ id: String, _ display: PaneDisplay) -> [Route] {
        guard let pane = layout.pane(id), let shown = display.panes.first(where: { $0.id == id }) else { return [] }
        let stored = paths[id] ?? []
        if display.listBehindId == id {
            return (Self.route(pane.content).map { [$0] } ?? []) + stored
        }
        return shown.content == pane.content ? stored : []
    }

    /// The pane's navigation changed (a row tapped, Back).
    func setPath(_ new: [Route], _ id: String, _ display: PaneDisplay, running: Set<String>) {
        guard let pane = layout.pane(id), let shown = display.panes.first(where: { $0.id == id }) else { return }
        if display.listBehindId == id {
            if let first = new.first, let c = Self.content(first) {
                // Monitors is already the other pane here.
                guard c != .monitors else { return }
                if c != pane.content { update { $0.replace(id, with: c) } }
                paths[id] = Array(new.dropFirst())
            } else {
                // Back to the list: the pane has no chat until one is picked.
                if pane.content != .empty { update { $0.replace(id, with: .empty) } }
                paths[id] = new
            }
            return
        }
        guard shown.content == pane.content else { return }
        // A chat, New chat or Monitors picked in the list opens in the other pane.
        if pane.content == .chats, new.count > (paths[id] ?? []).count, let last = new.last, let c = Self.content(last) {
            focus(id)
            open(c, from: id, running: running)
            return
        }
        paths[id] = new
    }

    nonisolated static func content(_ route: Route) -> PaneContent? {
        switch route {
        case .chat(let id): return .chat(id)
        case .newChat: return .newChat
        case .monitors: return .monitors
        default: return nil
        }
    }

    nonisolated static func route(_ content: PaneContent) -> Route? {
        switch content {
        case .chat(let id): return .chat(id)
        case .newChat: return .newChat
        case .monitors: return .monitors
        case .chats, .empty: return nil
        }
    }
}

// MARK: - The host

/// `RootView`'s regular-width branch (FD-3): two panes side by side or
/// stacked by posture, a divider on the hinge or dragged between 35 and 65 %,
/// tabletop flex layout, Focus with the other pane as an edge tab.
struct PanesView: View {
    let host: PaneHost
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.horizontalSizeClass) private var hClass
    @Environment(\.verticalSizeClass) private var vClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The whole window, safe areas and keyboard included: what the posture is read from.
    @State private var window: CGSize = .zero
    /// The split when a divider drag began.
    @State private var dragFrom: Double?

    private var posture: Posture {
        Posture.current(horizontal: hClass == .compact ? .compact : .regular,
                               vertical: vClass == .compact ? .compact : .regular, size: window)
    }

    var body: some View {
        let posture = self.posture
        let display = host.layout.display(posture)
        GeometryReader { g in
            let frame = g.frame(in: .global)
            let hinge = Posture.hingeSource()?.rect
            let local = hinge?.offsetBy(dx: -frame.minX, dy: -frame.minY)
            let geo = PaneGeometry(display: display, size: g.size, hinge: local, split: host.layout.split)
            PanesLayout(frames: host.layout.panes.map { geo.rect($0.id) }) {
                ForEach(host.layout.panes) { pane in
                    let shown = display.panes.first { $0.id == pane.id } ?? pane
                    let visible = geo.visible(pane.id)
                    PaneColumn(host: host, id: pane.id, content: shown.content, display: display, visible: visible)
                        .environment(\.paneHinge, display.flex && visible ? hinge : nil)
                        .opacity(visible ? 1 : 0)
                        .allowsHitTesting(visible)
                        .accessibilityHidden(!visible)
                        .zIndex(visible ? 1 : 0)
                }
            }
            .overlay { if display.isSplit { divider(geo, display) } }
            .overlay(alignment: geo.tabEdge) { if !display.isSplit { edgeTab(display, posture) } }
        }
        .environment(\.inPanes, true)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: display)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: host.layout.split)
        .background(palette.paper.ignoresSafeArea())
        .background {
            GeometryReader { g in
                Color.clear.onChange(of: g.size, initial: true) { _, s in
                    Hinge.windowSize = s
                    window = s
                }
            }
            .ignoresSafeArea()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer(display, posture) }
        .onAppear { host.sync(computer: store.activeId, prefs: app.prefs) }
        // Rotating with two chats open: the pane that was focused becomes the primary one.
        .onChange(of: posture) { old, new in
            let flat: Set<Posture> = [.openWide, .openTall, .book]
            if flat.contains(old), flat.contains(new), (old == .openTall) != (new == .openTall) {
                host.update { $0.promoteFocused() }
            }
        }
    }

    // MARK: Divider

    @ViewBuilder private func divider(_ geo: PaneGeometry, _ display: PaneDisplay) -> some View {
        let across = display.mode == .stacked
        if let gap = geo.hingeGap {
            // On the hinge: fixed, nothing drawn over the fold.
            Rectangle().fill(palette.line.opacity(0.5))
                .frame(width: gap.width, height: gap.height)
                .position(x: gap.midX, y: gap.midY)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        } else {
            let at = geo.dividerAt
            ZStack {
                Rectangle().fill(palette.line).frame(width: across ? nil : 1, height: across ? 1 : nil)
                Capsule().fill(palette.inkFaint.opacity(0.6))
                    .frame(width: across ? 36 : 5, height: across ? 5 : 36)
            }
            .frame(width: across ? geo.size.width : 24, height: across ? 24 : geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 2, coordinateSpace: .global)
                    .onChanged { v in
                        let from = dragFrom ?? host.layout.split
                        if dragFrom == nil { dragFrom = from }
                        let length = across ? geo.size.height : geo.size.width
                        guard length > 0 else { return }
                        let moved = Double((across ? v.translation.height : v.translation.width) / length)
                        var t = Transaction()
                        t.disablesAnimations = true
                        withTransaction(t) { host.update { $0.setSplit(from + moved) } }
                    }
                    .onEnded { _ in dragFrom = nil }
            )
            .accessibilityElement()
            .accessibilityLabel("Divider")
            .accessibilityValue("\(Int((host.layout.split * 100).rounded())) percent")
            .accessibilityHint("Swipe up or down to give one pane more room.")
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: host.update { $0.setSplit($0.split + 0.05) }
                case .decrement: host.update { $0.setSplit($0.split - 0.05) }
                @unknown default: break
                }
            }
            .accessibilityIdentifier("panes.divider")
            .position(x: across ? geo.size.width / 2 : at, y: across ? at : geo.size.height / 2)
        }
    }

    // MARK: Edge tab

    /// The pane that is not on screen (Focus, tabletop), as a tab on the edge.
    @ViewBuilder private func edgeTab(_ display: PaneDisplay, _ posture: Posture) -> some View {
        if let hidden = display.panes.first(where: { $0.id != display.shownId }) {
            Button {
                if host.layout.maximizedId != nil && posture != .tabletop && posture != .closed {
                    host.update { $0.restoreBoth() }
                } else {
                    host.update { $0.focus(hidden.id) }
                }
            } label: {
                VStack(spacing: 6) {
                    PaneStatusDot(content: hidden.content, focused: false)
                    Image(systemName: "chevron.compact.left").font(.title3.weight(.semibold))
                }
                .foregroundStyle(palette.inkSoft)
                .padding(.vertical, 14).padding(.horizontal, 6)
                .frame(minWidth: 44, minHeight: 72)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show \(PaneTitle.of(hidden.content, store: store))")
            .accessibilityIdentifier("panes.edgeTab")
        }
    }

    // MARK: Footer: the tip and the note

    @ViewBuilder private func footer(_ display: PaneDisplay, _ posture: Posture) -> some View {
        let note = (display.isSplit || posture == .tabletop) && !app.prefs.foldNoteDismissed
        if host.tip != nil || note {
            VStack(spacing: 6) {
                if let tip = host.tip { tipRow(tip) }
                if note { noteRow }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(.bar)
        }
    }

    private func tipRow(_ tip: PaneLayout) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "rectangle.split.2x1").foregroundStyle(palette.accent).accessibilityHidden(true)
            Text("Watch both? Show the two chats side by side.").font(.footnote).foregroundStyle(palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Not now") { host.dismissTip() }.font(.footnote)
            Button("Chat + Chat") { host.takeTip() }.font(.footnote.weight(.semibold)).buttonStyle(.borderedProminent)
                .accessibilityIdentifier("panes.tip.take")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("panes.tip")
    }

    /// Small, under the panes, dismissable (remembered on this device).
    private var noteRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").font(.caption).foregroundStyle(palette.inkFaint).accessibilityHidden(true)
            Text(FoldableNote.attributed).font(.caption2).foregroundStyle(palette.inkSoft).tint(palette.accent)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { app.prefs.foldNoteDismissed = true } label: {
                Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
                    .frame(width: 44, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss note")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("panes.foldNote")
    }
}

// MARK: - Geometry

/// Where each pane goes for one display, in the host's points.
struct PaneGeometry {
    let size: CGSize
    private var rects: [String: CGRect] = [:]
    private var shown: Set<String> = []
    /// The draggable divider's position along the split axis.
    private(set) var dividerAt: CGFloat = 0
    /// The hinge's gap when the divider sits on it.
    private(set) var hingeGap: CGRect?
    /// Which edge the edge tab sits on: the side the hidden pane is on.
    private(set) var tabEdge: Alignment = .trailing

    init(display: PaneDisplay, size: CGSize, hinge: CGRect?, split: Double) {
        self.size = size
        let full = CGRect(origin: .zero, size: size)
        let ids = display.panes.map(\.id)
        guard ids.count == 2 else { return }
        switch display.mode {
        case .single:
            for id in ids { rects[id] = full }
            shown = [display.shownId]
            tabEdge = ids.first == display.shownId ? .trailing : .leading
        case .sideBySide:
            if let h = hinge, h.height >= h.width, h.minX > 0, h.maxX < size.width {
                rects[ids[0]] = CGRect(x: 0, y: 0, width: h.minX, height: size.height)
                rects[ids[1]] = CGRect(x: h.maxX, y: 0, width: size.width - h.maxX, height: size.height)
                hingeGap = CGRect(x: h.minX, y: 0, width: h.width, height: size.height)
            } else {
                let x = (size.width * CGFloat(split)).rounded()
                rects[ids[0]] = CGRect(x: 0, y: 0, width: x, height: size.height)
                rects[ids[1]] = CGRect(x: x, y: 0, width: size.width - x, height: size.height)
                dividerAt = x
            }
            shown = Set(ids)
        case .stacked:
            if let h = hinge, h.width > h.height, h.minY > 0, h.maxY < size.height {
                rects[ids[0]] = CGRect(x: 0, y: 0, width: size.width, height: h.minY)
                rects[ids[1]] = CGRect(x: 0, y: h.maxY, width: size.width, height: size.height - h.maxY)
                hingeGap = CGRect(x: 0, y: h.minY, width: size.width, height: h.height)
            } else {
                let y = (size.height * CGFloat(split)).rounded()
                rects[ids[0]] = CGRect(x: 0, y: 0, width: size.width, height: y)
                rects[ids[1]] = CGRect(x: 0, y: y, width: size.width, height: size.height - y)
                dividerAt = y
            }
            shown = Set(ids)
        }
    }

    func rect(_ id: String) -> CGRect { rects[id] ?? CGRect(origin: .zero, size: size) }
    func visible(_ id: String) -> Bool { shown.contains(id) }
}

/// Places the panes at the rects worked out for them, in the order given
/// (the panes' own order, so a swap moves views rather than rebuilding them).
struct PanesLayout: Layout {
    let frames: [CGRect]

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, view) in subviews.enumerated() {
            let f = i < frames.count ? frames[i] : CGRect(origin: .zero, size: bounds.size)
            view.place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), anchor: .topLeading,
                       proposal: ProposedViewSize(width: f.width, height: f.height))
        }
    }
}

// MARK: - One pane

/// One pane: its own navigation, the pane menu in its header, focus on touch.
struct PaneColumn: View {
    let host: PaneHost
    let id: String
    let content: PaneContent
    let display: PaneDisplay
    let visible: Bool
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    private var focused: Bool { host.layout.focusedId == id }
    private var listBehind: Bool { display.listBehindId == id }

    var body: some View {
        NavigationStack(path: pathBinding) {
            Group {
                if listBehind {
                    ChatsView(path: pathBinding, highlighted: host.layout.pane(id)?.content.chatId)
                } else {
                    root
                }
            }
            .id(listBehind ? "list" : content.encoded)
            .toolbar { menuItem }
            .navigationDestination(for: Route.self) { r in
                RouteView(route: r, path: pathBinding, openChat: { chatId in openChat(chatId) })
                    .toolbar { menuItem }
            }
        }
        // Touching a pane gives it the focus (its composer takes the keyboard).
        .simultaneousGesture(TapGesture().onEnded { host.focus(id) })
        .overlay {
            if display.isSplit && focused {
                Rectangle().strokeBorder(palette.accent.opacity(0.55), lineWidth: 2)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        // A container the UI tests can find each pane by (`pane.a`, `pane.b`).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pane.\(id)")
    }

    private var running: Set<String> {
        Set(store.activity.compactMap { $0.value == .running || $0.value == .needsYou ? $0.key : nil })
    }

    private var pathBinding: Binding<[Route]> {
        Binding(get: { host.path(id, display) }, set: { host.setPath($0, id, display, running: running) })
    }

    /// A chat picked from inside this pane (Monitors' Running, New chat).
    private func openChat(_ chatId: String) {
        switch content {
        case .newChat: host.update { $0.replace(id, with: .chat(chatId)) }
        default: host.open(.chat(chatId), from: id, running: running)
        }
    }

    @ViewBuilder private var root: some View {
        switch content {
        case .chats:
            ChatsView(path: pathBinding, highlighted: host.layout.other(id).content.chatId)
        case .chat(let chatId):
            ChatView(sessionId: chatId)
        case .newChat:
            NewChatView(path: pathBinding, opened: { chatId in openChat(chatId) })
        case .monitors:
            MonitorsView(active: visible, open: { chatId in host.open(.chat(chatId), from: id, running: running) })
        case .empty:
            ContentUnavailableView("Pick a chat", systemImage: "bubble.left.and.text.bubble.right",
                                   description: Text("Or start a new one on \(store.active?.name ?? "your computer")."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(palette.paper)
        }
    }

    private var menuItem: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            PaneMenu(host: host, id: id, content: content, display: display)
        }
    }
}

/// A pane's header menu: Swap, Focus, Replace with…, the arrangements.
struct PaneMenu: View {
    let host: PaneHost
    let id: String
    let content: PaneContent
    let display: PaneDisplay
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            if display.isSplit {
                Button { host.update { $0.swap() } } label: {
                    Label("Swap", systemImage: display.mode == .stacked ? "arrow.up.arrow.down" : "arrow.left.arrow.right")
                }
                .accessibilityIdentifier("pane.swap")
            }
            if display.isSplit || host.layout.maximizedId == id {
                Button { host.update { $0.toggleMaximized(id) } } label: {
                    host.layout.maximizedId == id
                        ? Label("Show both panes", systemImage: "rectangle.split.2x1")
                        : Label("Focus", systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .accessibilityIdentifier("pane.focus")
            }
            Menu {
                Button { replace(.monitors) } label: { Label("Monitors", systemImage: "gauge.with.dots.needle.50percent") }
                    .accessibilityIdentifier("pane.replace.monitors")
                Button { replace(.chats) } label: { Label("Chats", systemImage: "list.bullet") }
                Button { replace(.newChat) } label: { Label("New chat", systemImage: "square.and.pencil") }
                let recent = recentChats
                if !recent.isEmpty {
                    Section("Another chat") {
                        ForEach(recent) { s in
                            Button { replace(.chat(s.id)) } label: { Text(s.title.isEmpty ? String(localized: "Chat") : s.title) }
                        }
                    }
                }
            } label: { Label("Replace with…", systemImage: "rectangle.2.swap") }
            .accessibilityIdentifier("pane.replace")
            Menu {
                ForEach(PaneArrangement.allCases, id: \.self) { a in
                    Button { host.update { $0.apply(a, recent: recentChats.map(\.id)) } } label: {
                        if host.layout.arrangement == a { Label(Self.name(a), systemImage: "checkmark") } else { Text(Self.name(a)) }
                    }
                }
            } label: { Label("Arrangement", systemImage: "rectangle.split.2x1") }
            .accessibilityIdentifier("pane.arrangement")
            if app.prefs.foldNoteDismissed {
                Section {
                    // Brings the note about testing without a foldable back under the panes.
                    Button { app.prefs.foldNoteDismissed = false } label: { Label("About two panes", systemImage: "info.circle") }
                }
            }
        } label: {
            HStack(spacing: 6) {
                PaneStatusDot(content: content, focused: host.layout.focusedId == id)
                Image(systemName: display.mode == .stacked ? "rectangle.split.1x2" : "rectangle.split.2x1")
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Pane: \(PaneTitle.of(content, store: store))\(PaneStatusDot.stateWords(content, store: store))")
        .accessibilityIdentifier("pane.menu")
    }

    private func replace(_ c: PaneContent) { host.update { $0.replace(id, with: c) } }

    /// The chats to offer, most recent first, without the ones already on screen.
    private var recentChats: [SessionSummary] {
        let shown = Set(host.layout.panes.compactMap(\.content.chatId))
        return store.summaries.filter { !$0.archived && !shown.contains($0.id) }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(8).map { $0 }
    }

    static func name(_ a: PaneArrangement) -> String {
        switch a {
        case .chatChat: String(localized: "Chat + Chat")
        case .chatMonitors: String(localized: "Chat + Monitors")
        case .chatsChat: String(localized: "Chats + Chat")
        case .monitorsChats: String(localized: "Monitors + Chats")
        }
    }
}

/// A pane's state at a glance: working, needs you (pulsing while that pane
/// is not the focused one), or quiet.
struct PaneStatusDot: View {
    let content: PaneContent
    let focused: Bool
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let activity = content.chatId.flatMap { store.activity[$0] }
        Image(systemName: "circle.fill")
            .font(.system(size: 8))
            .foregroundStyle(activity == .needsYou ? palette.warning : activity == .running ? palette.running : palette.inkFaint)
            .symbolEffect(.pulse, options: .repeating, isActive: activity == .needsYou && !focused && !reduceMotion)
            .accessibilityHidden(true)
    }

    static func stateWords(_ content: PaneContent, store: ComputersStore) -> String {
        switch content.chatId.flatMap({ store.activity[$0] }) {
        case .needsYou?: return String(localized: ", needs you")
        case .running?: return String(localized: ", working")
        default: return ""
        }
    }
}

enum PaneTitle {
    @MainActor
    static func of(_ content: PaneContent, store: ComputersStore) -> String {
        switch content {
        case .chats: return String(localized: "Chats")
        case .monitors: return String(localized: "Monitors")
        case .newChat: return String(localized: "New chat")
        case .empty: return String(localized: "No chat")
        case .chat(let id):
            let t = store.summaries.first { $0.id == id }?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return t.isEmpty ? String(localized: "Chat") : t
        }
    }
}

// MARK: - Drag between panes (FD-4)

/// What can be dropped on a chat: text (a message, a file's path) or an image.
/// Either lands in the composer; a drop never sends.
enum PaneDrop: Transferable, Sendable {
    case text(String)
    case image(Data)

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { data in PaneDrop.image(data) }
        ProxyRepresentation(exporting: { (d: PaneDrop) -> String in d.textValue }, importing: { (s: String) in PaneDrop.text(s) })
    }

    private var textValue: String {
        if case .text(let s) = self { return s }
        return ""
    }

    /// Put what was dropped into the chat's message box. True when anything was taken.
    @MainActor
    static func accept(_ items: [PaneDrop], into chat: ChatModel) -> Bool {
        var texts: [String] = []
        var images: [String] = []
        for item in items {
            switch item {
            case .text(let s):
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { texts.append(t) }
            case .image(let data):
                if let ui = UIImage(data: data), let url = ImageAttachments.encode(ui) { images.append(url) }
            }
        }
        if !texts.isEmpty { chat.quote(texts.joined(separator: "\n\n")) }
        if !images.isEmpty { chat.attach(images: images) }
        return !texts.isEmpty || !images.isEmpty
    }
}

/// A message row that can be dragged (as its text) when `text` is set.
struct PaneDraggable: ViewModifier {
    let text: String?

    func body(content: Content) -> some View {
        if let text, !text.isEmpty {
            content.draggable(text)
        } else {
            content
        }
    }
}
