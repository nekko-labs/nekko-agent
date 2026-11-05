import NekkoKit
import NekkoProtocol
import SwiftUI

/// The computer's chats, grouped like the desktop's sidebar (General, then
/// each project folder) or as the view menu says, with Working / Needs you
/// badges, search, swipe to complete / delete, and the computer switcher in the title.
struct ChatsView: View {
    @Binding var path: [Route]
    /// iPad (regular width): the split view's selected chat. Nil on iPhone, where rows push.
    var selection: Binding<Route?>? = nil
    /// In a pane: the chat open in the other pane, marked like a selection.
    var highlighted: String? = nil
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    /// Groups folded shut by a tap on their heading; every group starts open.
    @State private var collapsed: Set<String> = []
    /// Groups showing every chat, past the first few recent ones.
    @State private var expanded: Set<String> = []
    @State private var reorderingGroups = false
    @State private var sendingFeedback = false
    /// The heading a dragged group is over.
    @State private var dropTarget: String?
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var confirmDelete: SessionSummary?
    @State private var actionError: String?
    /// The computer's monitors: the pill's gauges, the Monitors row and the agent's details.
    @State private var monitor: HardwareMonitorModel?
    @State private var showPanel = false
    /// The search field shows under the title.
    @State private var searching = false
    /// The pill scrolled away.
    @State private var pillHidden = false
    @Environment(Prefs.self) private var prefs
    /// Pull to refresh, played by the toolbar mascot.
    @State private var pull = PawPull()

    var body: some View {
        Group {
            if let selection {
                List(selection: selection) { rows }
            } else {
                List { rows }
            }
        }
        // Flat rows straight on the coloured ground, hairline separated, as the
        // desktop's Agents panel (2026-10-24; the panels of 2026-10-26 went 2026-10-28).
        .listStyle(.plain)
        .animation(reduceMovement ? nil : .smooth(duration: 0.35), value: sections)
        .listRowSeparatorTint(palette.line)
        .appBackground()
        // Room for the floating pill under the large title, while it sits there.
        .contentMargins(.top, prefs.pillPlacement.isStandard && !searching ? AgentPillLayer.topMargin : 0, for: .scrollContent)
        .hidesPillOnScroll($pillHidden)
        .pawRefreshable(pull) {
            await store.refresh()
            await store.refreshFleet()
        }
        // The rows' PR states: looked up as chats name PRs or move on, and every few minutes.
        .task(id: rowPrsKey) { await store.loadRowPrs(listSummaries) }
        .navigationTitle("Chats")
        .toolbar {
            RootMascot(working: listActivity.values.contains(.running), pull: pull)
            ToolbarItem(placement: .topBarLeading) { ComputerMenu(path: $path, feedback: $sendingFeedback, search: { searching = true }) }
            ToolbarItem(placement: .topBarTrailing) { viewMenu }
            ToolbarItem(placement: .topBarTrailing) {
                // Offline too: a chat started now begins when the computer is back.
                Button { newChat() } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New chat")
            }
        }
        // Search (from the computer menu) under the title; the pill steps aside meanwhile.
        .safeAreaInset(edge: .top, spacing: 0) {
            if searching { SearchRow(query: $query) { query = ""; searching = false } }
        }
        // Simple or Expert, and the minimal monitor while the hardware shows, floating under the title.
        .agentPill(gauges: prefs.shows("hardware", localModelLoaded: monitor?.localModelLoaded ?? false) ? monitor : nil,
                   monitor: monitor, hidden: searching || pillHidden, expanded: $showPanel)
        .modifier(MonitorFollow(monitor: $monitor, ids: ["hardware", "ph-monitors"], panelOpen: showPanel))
        .overlay(alignment: .top) { if store.summariesLoading && listSummaries.isEmpty { ProgressView().padding(.top, 80) } }
        .modifier(dialogs)
        .sheet(isPresented: $reorderingGroups) {
            ReorderGroupsSheet(groups: sections.filter { $0.key != ChatGroup.general }.map { GroupName(key: $0.key, name: $0.name) }) { setGroupOrder($0) }
        }
        .sheet(isPresented: $sendingFeedback) { FeedbackSheet() }
    }

    private func open(_ r: Route) {
        if let selection { selection.wrappedValue = r } else { path.append(r) }
    }

    private var dialogs: ChatDialogs {
        ChatDialogs(renaming: $renaming, renameText: $renameText, confirmDelete: $confirmDelete, actionError: $actionError,
                    rename: { s in rename(s, to: renameText) },
                    delete: { s in delete(s) },
                    computer: confirmDelete.flatMap { s in place(of: s)?.name } ?? store.active?.name ?? "your computer")
    }

    @ViewBuilder private var rows: some View {
            if !store.computers.isEmpty && (filter == nil || filter == store.activeId) {
                ConnectionBanner().listRowSeparator(.hidden).listRowBackground(Color.clear)
                ProtocolBanner().listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            // The other computers in view that can't be reached now, each with Reconnect.
            if filter != PhoneProviders.computerId {
                FleetBanner(computer: filter).listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            if filter == nil || filter == store.activeId, let at = store.savedListAt {
                Label(SavedListNote.text(savedAt: at, computer: store.active?.name ?? "your computer"), systemImage: "clock.arrow.circlepath")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .accessibilityIdentifier("chats.savedList")
            }
            if listSummaries.isEmpty && store.summariesLoaded && !store.summariesLoading, filter == nil || filter == store.activeId, let e = store.lastError {
                // A list that failed to load is not an empty one.
                VStack(spacing: 10) {
                    Label("Couldn’t load the chats", systemImage: "exclamationmark.triangle")
                        .font(.headline).foregroundStyle(palette.ink)
                    Text(e).font(.subheadline).foregroundStyle(palette.inkSoft)
                    Button("Try again") { Task { await store.refresh() } }.buttonStyle(.bordered)
                }
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
                .listRowBackground(Color.clear)
            } else if listSummaries.isEmpty && scopeLoaded && !store.summariesLoading {
                // Not ContentUnavailableView: its fixed layout clips at large text sizes.
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(palette.inkSoft)
                        .accessibilityHidden(true)
                    Text("No chats yet").font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                    Text(placesInView.allSatisfy(\.phone) ? String(localized: "Start one here.") : String(localized: "Start one here, or on \(emptyListPlace)."))
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                    Button { newChat() } label: { Text("New chat").foregroundStyle(palette.onAccent) }
                        .buttonStyle(.borderedProminent).padding(.top, 4)
                }
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 32)
                .listRowBackground(Color.clear)
            }
            if !query.isEmpty && filtered.isEmpty {
                Text("No chats match “\(query)”.").font(.subheadline).foregroundStyle(palette.inkSoft)
                    .frame(maxWidth: .infinity).padding(.vertical, 24).listRowBackground(Color.clear)
            }
            if !store.outbox.pendingNewChats.isEmpty && query.isEmpty {
                Section {
                    ForEach(store.outbox.pendingNewChats) { item in PendingChatRow(item: item, path: $path).listRowBackground(Color.clear) }
                } header: {
                    Text("Waiting to send")
                }
            }
            // Status groups lead with their own Needs you group.
            if !needsYou.isEmpty && query.isEmpty && view.groupBy != .status {
                Section { ForEach(needsYou) { row($0) } } header: { GroupHeading("Needs you", count: "\(needsYou.count)") }
            }
            ForEach(query.isEmpty || !filtered.isEmpty ? sections : []) { g in
                Section {
                    if g.key == ChatGroup.general || !collapsed.contains(g.key) || !query.isEmpty { sectionRows(g) }
                } header: {
                    if g.key != ChatGroup.general { sectionHeading(g) }
                }
            }
            // The computer's Monitors (FD-5): hardware, running chats, what needs you, the next automations.
            if query.isEmpty && !store.computers.isEmpty && prefs.shows("ph-monitors", localModelLoaded: monitor?.localModelLoaded ?? false) {
                Section {
                    NavigationLink(value: Route.monitors) {
                        Label("Monitors", systemImage: "gauge.with.dots.needle.50percent").foregroundStyle(palette.ink)
                    }
                    .listRowBackground(Color.clear)
                    .accessibilityIdentifier("chats.monitors")
                }
            }
    }

    /// A group's chats: the recent few unless it was expanded or a search is on, then Show more / Show fewer.
    @ViewBuilder private func sectionRows(_ g: ChatSection) -> some View {
        let split = ChatSections.split(g, activity: listActivity, now: nowMs)
        let all = !query.isEmpty || expanded.contains(g.key)
        if g.chats.isEmpty {
            Text("No active agents").font(.footnote).foregroundStyle(palette.inkFaint).listRowBackground(Color.clear)
        }
        ForEach(all ? g.chats : split.shown) { row($0) }
        if query.isEmpty && split.hidden > 0 {
            Button {
                withAnimation { flip(&expanded, g.key) }
            } label: {
                Label(all ? String(localized: "Show fewer") : String(localized: "Show \(split.hidden) more"),
                      systemImage: all ? "chevron.up" : "chevron.down")
                    .font(.footnote.weight(.medium)).foregroundStyle(palette.inkSoft)
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .accessibilityIdentifier("chats.showMore")
        }
    }

    /// A group's heading: tap to fold it, and on project groups, drag it to a new place.
    @ViewBuilder private func sectionHeading(_ g: ChatSection) -> some View {
        let open = !collapsed.contains(g.key) || !query.isEmpty
        let heading = Button {
            withAnimation { flip(&collapsed, g.key) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(palette.inkFaint)
                    .rotationEffect(.degrees(open ? 90 : 0))
                // By computer: the place's mark in its colour, as on its rows.
                if let id = sourceId(g), let place = ChatPlace.of(id, store: store) {
                    PlaceMark(place: place, showIcon: view.showComputerIcons, size: 14)
                }
                VStack(alignment: .leading, spacing: 3) {
                    GroupHeading(groupTitle(g), count: counts(g))
                    if let path = listFolders.first(where: { $0.id == g.key })?.path {
                        Text(path).font(.caption).foregroundStyle(palette.inkSoft).textCase(nil)
                    }
                }
            }
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                // Where a dragged group lands: before this one.
                if dropTarget == g.key { Rectangle().fill(palette.accent).frame(height: 2) }
            }
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? String(localized: "Expanded") : String(localized: "Collapsed"))
        .accessibilityHint("Double-tap to fold or unfold the group.")
        if view.canReorderGroups && query.isEmpty {
            heading
                .draggable(g.key)
                .dropDestination(for: String.self) { keys, _ in
                    guard let key = keys.first, key != g.key, sections.contains(where: { $0.key == key }) else { return false }
                    setGroupOrder(ChatGroupOrder.move(sections.map(\.key), key, before: g.key))
                    return true
                } isTargeted: { over in
                    if over { dropTarget = g.key } else if dropTarget == g.key { dropTarget = nil }
                }
                .accessibilityAction(named: "Reorder groups") { reorderingGroups = true }
        } else {
            heading
        }
    }

    /// Group by, sort by, and what is shown: the desktop Agents panel's view menu.
    private var viewMenu: some View {
        Menu {
            Picker("Group by", selection: bind(\.groupBy)) {
                // By computer, as the desktop offers it, once chats come from more than one place.
                ForEach(ChatListView.GroupBy.allCases.filter { $0 != .computer || places.count > 1 }, id: \.self) {
                    Text(Self.groupName($0)).tag($0)
                }
            }
            .pickerStyle(.menu)
            Picker("Sort by", selection: Binding(get: { view.sortBy }, set: { app.prefs.chatListView = view.withSort($0) })) {
                ForEach(ChatListView.SortBy.allCases, id: \.self) { Text(Self.sortName($0)).tag($0) }
            }
            .pickerStyle(.menu)
            // Manual order has no direction: it is whatever was dragged on the computer.
            if view.sortBy != .manual {
                Picker("Order", selection: bind(\.ascending)) {
                    Text(view.sortBy == .name ? String(localized: "A to Z") : String(localized: "Oldest first")).tag(true)
                    Text(view.sortBy == .name ? String(localized: "Z to A") : String(localized: "Newest first")).tag(false)
                }
                .pickerStyle(.menu)
            }
            Menu("Show") {
                Toggle("Previews", isOn: bind(\.showPreviews))
                Toggle("Completed chats", isOn: bind(\.showCompleted))
                Toggle("Always show groups", isOn: bind(\.showEmptyGroups))
                if places.count > 1 {
                    Toggle("Computer", isOn: bind(\.showComputer))
                    Toggle("Computer icons", isOn: bind(\.showComputerIcons))
                }
            }
            if view.canReorderGroups {
                Button { reorderingGroups = true } label: { Label("Reorder groups…", systemImage: "arrow.up.arrow.down") }
            }
            Divider()
            Button("Reset to defaults") { app.prefs.chatListView = .standard }.disabled(view.isStandard)
        } label: {
            Image(systemName: view.isStandard ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("View options")
        .accessibilityIdentifier("chats.view")
    }

    private var view: ChatListView { app.prefs.chatListView }

    private func bind<T>(_ key: WritableKeyPath<ChatListView, T>) -> Binding<T> {
        Binding(get: { app.prefs.chatListView[keyPath: key] }, set: { app.prefs.chatListView[keyPath: key] = $0 })
    }

    static func groupName(_ g: ChatListView.GroupBy) -> String {
        switch g {
        case .project: String(localized: "Project")
        case .status: String(localized: "Status")
        case .date: String(localized: "Date")
        case .computer: String(localized: "Computer")
        case .none: String(localized: "None")
        }
    }

    static func sortName(_ s: ChatListView.SortBy) -> String {
        switch s {
        case .manual: String(localized: "Manual")
        case .updated: String(localized: "Last updated")
        case .name: String(localized: "Name")
        }
    }

    /// A folder's own name, or the list's built-in group names in the phone's language.
    private func groupTitle(_ g: ChatSection) -> String {
        if listFolders.contains(where: { $0.id == g.key }) || sourceId(g) != nil { return g.name }
        return String(localized: String.LocalizationValue(g.name))
    }

    /// The place a Group by → Computer heading stands for.
    private func sourceId(_ g: ChatSection) -> String? {
        g.key.hasPrefix("computer:") ? String(g.key.dropFirst("computer:".count)) : nil
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private var reduceMovement: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestReduceMotion") { return true }
        #endif
        return reduceMotion
    }

    private var sections: [ChatSection] {
        ChatSections.make(filtered, folders: listFolders, view: view, activity: listActivity,
                          groupOrder: app.prefs.groupOrder[groupOrderKey] ?? [],
                          sources: placesInView.map { ChatSource(id: $0.id, name: $0.name) },
                          sourceOf: { placeId(of: $0) }, now: nowMs)
    }

    private func flip(_ set: inout Set<String>, _ key: String) {
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
    }

    private func setGroupOrder(_ keys: [String]) {
        withAnimation { app.prefs.groupOrder[groupOrderKey] = keys }
        dropTarget = nil
    }

    /// Every word of the search, in the title, first prompt or last reply; completed chats too.
    private var filtered: [SessionSummary] { ChatSearch.matches(listSummaries, query) }

    // MARK: The computers in view (2026-11-04)

    /// Whose chats the list shows: one computer, or every paired computer (nil).
    /// A forgotten computer's filter falls back to every computer.
    private var filter: String? {
        prefs.chatsFilter.flatMap { id in places.contains { $0.id == id } ? id : nil }
    }

    /// Every place chats run: the paired computers, and this iPhone when it runs chats (decision 0050).
    private var places: [ChatPlace] { ChatPlace.all(store: store, phone: phone) }
    /// The places the list shows now: every one, or the one it is filtered to.
    private var placesInView: [ChatPlace] { filter.map { f in places.filter { $0.id == f } } ?? places }
    /// This iPhone's own chats are in the list.
    private var phoneInView: Bool { placesInView.contains(where: \.phone) }
    /// The one computer filtered to, or every computer (nil).
    private var computerFilter: String? { filter == PhoneProviders.computerId ? nil : filter }
    private var computersInView: Bool { filter != PhoneProviders.computerId && !store.computers.isEmpty }

    private var listSummaries: [SessionSummary] {
        (computersInView ? store.chats(on: computerFilter) : []) + (phoneInView ? phone.summaries : [])
    }
    private var listActivity: [String: Activity] {
        (computersInView ? store.activity(on: computerFilter) : [:]).merging(phoneInView ? phone.activity : [:]) { a, _ in a }
    }
    private var listFolders: [WorkspaceFolder] { computersInView ? store.folders(on: computerFilter) : [] }

    /// Rows say where a chat runs when they come from more than one place, unless the headings say it.
    private var showsComputer: Bool { placesInView.count > 1 && view.showComputer && view.groupBy != .computer }

    /// A computer in view has answered with its list, so an empty list is really empty.
    private var scopeLoaded: Bool {
        if phoneInView { return true }
        return (filter.map { [$0] } ?? store.computers.map(\.id)).contains { id in
            id == store.activeId
                ? store.conn == .online && store.summariesLoaded && store.savedListAt == nil
                : store.peers[id]?.loaded == true && store.peers[id]?.conn == .online
        }
    }

    /// Where an empty list suggests starting a chat.
    private var emptyListPlace: String {
        if placesInView.count == 1, let name = placesInView.first?.name { return name }
        return store.computers.count > 1 ? String(localized: "your computers") : store.active?.name ?? String(localized: "your computer")
    }

    /// The group order kept for this view: each computer's own, and one for every computer together.
    private var groupOrderKey: String { filter ?? (places.count > 1 ? Self.allComputersKey : store.activeId ?? "") }
    static let allComputersKey = "*"

    /// The computer a chat is on, from the lists the phone holds (nil: none holds it, so the active one).
    private func owner(_ s: SessionSummary) -> String? { store.computerId(ofChat: s.id) }

    /// Where a chat runs: this iPhone, the computer that listed it, else the active one.
    private func placeId(of s: SessionSummary) -> String? {
        PhoneProviders.isPhoneChat(s.id) ? PhoneProviders.computerId : owner(s) ?? store.activeId
    }

    private func place(of s: SessionSummary) -> ChatPlace? { ChatPlace.of(placeId(of: s), store: store) }

    /// New chat runs on the place in view; with every place in view, on the computer used last.
    private func newChat() {
        if let filter, filter != store.activeId, filter != PhoneProviders.computerId { store.connect(filter) }
        open(.newChat)
    }

    // A chat's actions, on the computer it runs on or on this iPhone.

    private func rename(_ s: SessionSummary, to title: String) {
        if PhoneProviders.isPhoneChat(s.id) { phone.rename(s.id, to: title) } else { act { try await store.renameChat(s.id, to: title, on: owner(s)) } }
    }

    private func delete(_ s: SessionSummary) {
        if PhoneProviders.isPhoneChat(s.id) { phone.delete(s.id) } else { act { try await store.deleteChat(s.id, on: owner(s)) } }
    }

    private func complete(_ s: SessionSummary) {
        if PhoneProviders.isPhoneChat(s.id) { phone.complete(s.id) } else { act { try await store.completeChat(s.id, on: owner(s)) } }
    }

    private func restore(_ s: SessionSummary) {
        if PhoneProviders.isPhoneChat(s.id) { phone.restore(s.id) } else { act { try await store.restoreChat(s.id, on: owner(s)) } }
    }

    private func pin(_ s: SessionSummary) {
        if PhoneProviders.isPhoneChat(s.id) { phone.setPinned(s.id, !s.pinned) } else { act { try await store.setPinned(s.id, !s.pinned, on: owner(s)) } }
    }

    /// "3 active · 12 done", as the desktop's group headings count.
    private func counts(_ g: ChatSection) -> String {
        var parts: [String] = []
        if g.activeCount > 0 { parts.append(g.activeCount == 1 ? String(localized: "1 active") : String(localized: "\(g.activeCount) active")) }
        if g.doneCount > 0 { parts.append(String(localized: "\(g.doneCount) done")) }
        return parts.joined(separator: " · ")
    }

    private var needsYou: [SessionSummary] { listSummaries.filter { listActivity[$0.id] == .needsYou } }

    /// Changes when a row's PRs may have: a chat naming PRs moved on, a computer came online, or the five-minute mark passed.
    private var rowPrsKey: String {
        let chats = listSummaries.filter { !$0.prUrls.isEmpty }.map { "\($0.id):\($0.updatedAt):\($0.prUrls.count)" }
        let tick = nowMs / ComputersStore.rowPrsFresh
        return chats.joined(separator: ",") + "|\(store.conn)|\(store.peers.values.filter { $0.conn == .online }.count)|\(tick)"
    }

    /// A chat on any computer in view. Opening one on another computer makes that
    /// computer active (`ChatView`), over the link the phone already holds to it.
    private func row(_ s: SessionSummary) -> some View {
        let on = owner(s)
        return NavigationLink(value: Route.chat(s.id)) {
            ChatRow(summary: s, activity: listActivity[s.id], waiting: on == store.activeId ? store.outbox.count(for: s.id) : 0,
                    showPreview: view.showPreviews, place: showsComputer ? place(of: s) : nil, showPlaceIcon: view.showComputerIcons,
                    prs: store.rowPrs[s.id] ?? [])
        }
        // Straight on the ground like the rest of the list, with the attention bar on a chat that needs you.
        .listRowBackground(RowBackground(needsYou: listActivity[s.id] == .needsYou,
                                         selected: selection.map { $0.wrappedValue == .chat(s.id) } ?? (highlighted == s.id)))
        .accessibilityIdentifier("chats.row")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if s.archived {
                Button { restore(s) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    .tint(palette.running)
            } else if store.pcSettings.effectiveAction == .delete && !PhoneProviders.isPhoneChat(s.id) {
                Button(role: .destructive) { askDelete(s) } label: { Label("Delete", systemImage: "trash") }
            } else {
                Button { complete(s) } label: { Label("Complete", systemImage: "checkmark.circle") }
                    .tint(palette.success)
            }
        }
        .swipeActions(edge: .leading) {
            Button { pin(s) } label: {
                Label(s.pinned ? "Unpin" : "Pin", systemImage: s.pinned ? "pin.slash" : "pin")
            }.tint(palette.warning)
        }
        .contextMenu {
            Button { renameText = s.title; renaming = s } label: { Label("Rename", systemImage: "pencil") }
            Button { pin(s) } label: { Label(s.pinned ? "Unpin" : "Pin", systemImage: "pin") }
            if s.archived {
                Button { restore(s) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
            } else {
                Button { complete(s) } label: { Label("Complete", systemImage: "checkmark.circle") }
            }
            Button(role: .destructive) { askDelete(s) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func askDelete(_ s: SessionSummary) {
        if store.pcSettings.confirmDelete || PhoneProviders.isPhoneChat(s.id) { confirmDelete = s } else { delete(s) }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do { try await body() } catch { actionError = error.localizedDescription }
        }
    }
}

struct ChatRow: View {
    let summary: SessionSummary
    let activity: Activity?
    /// Prompts for this chat waiting on the phone (the outbox).
    var waiting = 0
    var showPreview = true
    /// Where it runs, named when the list shows several places (a computer, or this iPhone).
    var place: ChatPlace? = nil
    /// ...with its icon (Show → Computer icons).
    var showPlaceIcon = true
    /// The pull requests the chat made, with their state (`pr:sessionList`).
    var prs: [PullRequest] = []
    @Environment(\.palette) private var palette

    var body: some View {
        // A glyph column says what the chat is doing before the title is read
        // (the desktop's StatusIcon); the facts sit under the preview as chips.
        HStack(alignment: .top, spacing: 10) {
            ChatStatusIcon(activity: activity, completed: summary.archived, waiting: waiting > 0, activeWatchCount: summary.activeWatchCount)
                .frame(width: 22, height: 22).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if summary.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(palette.warning).accessibilityLabel("Pinned") }
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(summary.archived ? palette.inkSoft : palette.ink).lineLimit(1)
                }
                if showPreview, let preview { Text(preview).font(.footnote).foregroundStyle(palette.inkFaint).lineLimit(2) }
                if activity != nil || waiting > 0 || place != nil || !prs.isEmpty {
                    HStack(spacing: 6) {
                        badge
                        if let place { PlaceChip(place: place, showIcon: showPlaceIcon) }
                        if !prs.isEmpty { RowPrLinks(prs: prs) }
                        if waiting > 0 {
                            Label("\(waiting) waiting", systemImage: "tray.and.arrow.up")
                                .font(.caption2).foregroundStyle(palette.inkSoft)
                                .accessibilityLabel(waiting == 1 ? "1 prompt waiting to send" : "\(waiting) prompts waiting to send")
                        }
                    }
                    .padding(.top, 2)
                }
            }
            Spacer(minLength: 6)
            // Re-rendered each minute, so "2m" doesn't stay "2m".
            TimelineView(.periodic(from: .now, by: 60)) { _ in
                Text(Date(timeIntervalSince1970: Double(summary.updatedAt) / 1000), format: .relative(presentation: .numeric, unitsStyle: .narrow))
                    .font(.caption2).foregroundStyle(palette.inkFaint).padding(.top, 3)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var title: String { summary.title.trimmingCharacters(in: .whitespaces).isEmpty ? "New chat" : summary.title }

    private var preview: String? {
        let t = (summary.lastReplyText ?? summary.firstUserText ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }

    @ViewBuilder private var badge: some View {
        switch activity {
        case .needsYou?: RowChip(text: String(localized: "Needs you"), tone: .warn)
        case .running?: RowChip(text: String(localized: "Working"), tone: .normal, accent: true)
        case .failed?: RowChip(text: String(localized: "Error"), tone: .warn)
        case nil: EmptyView()
        }
    }
}

/// The PRs a chat made, on its row as on the desktop's agent cards: one `#123`
/// per PR tinted by its state as on GitHub, up to three; past that a
/// pull-request glyph and the count. Opening the chat shows each one.
struct RowPrLinks: View {
    static let maxInline = 3
    let prs: [PullRequest]
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            if prs.count > Self.maxInline {
                Label("\(prs.count)", systemImage: "arrow.triangle.pull")
                    .labelStyle(.titleAndIcon).foregroundStyle(palette.inkSoft)
            } else {
                ForEach(prs) { pr in Text("#\(pr.number)").foregroundStyle(tone(pr)) }
            }
        }
        .font(.caption2.weight(.semibold).monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("chats.row.prs")
    }

    /// Merged in the merge hue, closed in danger, a draft faint, an open one green: the desktop's `prTone`.
    private func tone(_ pr: PullRequest) -> Color {
        switch pr.state {
        case .merged: return palette.accent
        case .closed: return palette.danger
        case .open: return pr.isDraft ? palette.inkFaint : palette.success
        }
    }

    private var label: String {
        prs.map { pr in
            let s: String = switch pr.state {
            case .merged: String(localized: "merged")
            case .closed: String(localized: "closed")
            case .open: pr.isDraft ? String(localized: "draft") : String(localized: "open")
            }
            return String(localized: "Pull request \(pr.number), \(s)")
        }.joined(separator: ", ")
    }
}

/// A chat row's ground: the list's paper, the selection on iPad, and for a chat
/// that needs you a warning bar down its leading edge (the desktop's attention colour).
struct RowBackground: View {
    let needsYou: Bool
    var selected = false
    @Environment(\.palette) private var palette

    var body: some View {
        ZStack(alignment: .leading) {
            Color.clear
            if selected { palette.accent.opacity(0.12) } else if needsYou { palette.warning.opacity(0.07) }
            if needsYou { Rectangle().fill(palette.warning).frame(width: 3).accessibilityHidden(true) }
        }
    }
}

struct GroupName: Identifiable {
    let key: String
    let name: String
    var id: String { key }
}

/// Project groups in the order this iPhone lists them, dragged by their handles.
struct ReorderGroupsSheet: View {
    @State var groups: [GroupName]
    var save: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette

    init(groups: [GroupName], save: @escaping ([String]) -> Void) {
        _groups = State(initialValue: groups)
        self.save = save
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(groups) { g in Text(g.name).foregroundStyle(palette.ink) }
                        .onMove { groups.move(fromOffsets: $0, toOffset: $1) }
                } footer: {
                    Text("The order is kept on this iPhone. Touch and hold a group’s heading in the list to drag it there too.")
                        .foregroundStyle(palette.inkSoft)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Reorder groups")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { save(groups.map(\.key)); dismiss() }.accessibilityIdentifier("groups.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A chat started while the computer was out of reach: its first prompt, and
/// Edit (back to New chat), Delete and Send now. It becomes a normal row once
/// the computer has created it.
struct PendingChatRow: View {
    let item: OutboxItem
    @Binding var path: [Route]
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        let sending = store.outbox.sendingId == item.id
        VStack(alignment: .leading, spacing: 4) {
            Text(item.preview).font(.body.weight(.medium)).foregroundStyle(palette.ink).lineLimit(2)
            HStack(spacing: 6) {
                if sending { ProgressView().controlSize(.mini) } else { Image(systemName: "clock").accessibilityHidden(true) }
                Text(sending ? "Starting…" : "New chat · waiting to send")
            }
            .font(.caption2).foregroundStyle(palette.inkSoft)
            if let e = item.lastError, !sending { Text(e).font(.caption2).foregroundStyle(palette.inkFaint) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chats.pending")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !sending {
                Button(role: .destructive) { _ = store.outbox.remove(item.id) } label: { Label("Delete", systemImage: "trash") }
            }
        }
        .contextMenu {
            if !sending {
                Button { edit() } label: { Label("Edit", systemImage: "pencil") }
                Button { sendNow() } label: { Label("Send now", systemImage: "paperplane") }
                Button(role: .destructive) { _ = store.outbox.remove(item.id) } label: { Label("Delete", systemImage: "trash") }
            }
        }
        .onTapGesture { if !sending { edit() } }
    }

    /// Back to New chat with its text, model, folder and tool policy.
    private func edit() {
        guard store.outbox.takeBack(item.id) != nil else { return }
        path.append(.newChat)
    }

    private func sendNow() {
        if store.conn == .online { store.flushOutbox() } else { store.reconnect() }
    }
}

/// Whose chats the list shows (every computer, or one), search the chats, open
/// settings, send feedback. Every paired computer stays connected on its own,
/// so there is nothing to connect here (2026-11-04); pairing another computer,
/// and forgetting one, are on the Computers page.
struct ComputerMenu: View {
    @Binding var path: [Route]
    /// Presents *Send feedback*; the sheet hangs on the chat list, not on the toolbar item.
    @Binding var feedback: Bool
    /// Shows the chat list's search field; nil where there is no list to search.
    var search: (() -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(PhoneChats.self) private var phone
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            if places.count > 1 {
                Picker("Show chats from", selection: Binding(get: { filter }, set: show)) {
                    Label("All computers", systemImage: "square.stack.3d.up").tag(String?.none)
                    ForEach(store.computers) { c in
                        // A menu reads the two texts as title and subtitle: the subtitle is its connection.
                        Label {
                            Text(c.name)
                            Text(stateName(store.state(of: c.id)))
                        } icon: {
                            if let icon = c.icon { Image("computer-\(icon)") } else { Image(systemName: "desktopcomputer") }
                        }
                        .tag(Optional(c.id))
                    }
                    if places.contains(where: \.phone) {
                        Label {
                            Text(ChatPlace.phoneName)
                            Text("Its own models")
                        } icon: { Image(systemName: "iphone") }
                        .tag(Optional(PhoneProviders.computerId))
                    }
                }
                .pickerStyle(.inline)
                .accessibilityIdentifier("chats.menu.filter")
            }
            Button { path.append(.computers) } label: { Label("Computers", systemImage: "desktopcomputer") }
            Divider()
            if let search {
                Button(action: search) { Label("Search chats", systemImage: "magnifyingglass") }
                    .accessibilityIdentifier("chats.menu.search")
            }
            Button { path.append(.automations) } label: { Label("Automations", systemImage: "bolt.badge.clock") }
            Button { path.append(.usage) } label: { Label("Usage and limits", systemImage: "gauge.with.dots.needle.33percent") }
            Button { path.append(.files) } label: { Label("Files", systemImage: "folder") }
                .accessibilityIdentifier("computer.files")
            Button { path.append(.logs) } label: { Label("Logs", systemImage: "doc.text.magnifyingglass") }
                .accessibilityIdentifier("computer.logs")
            Button { path.append(.settings) } label: { Label("Settings", systemImage: "gearshape") }
            Button { feedback = true } label: { Label("Send feedback", systemImage: "envelope") }
                .accessibilityIdentifier("computer.feedback")
            // The safety exits for the active computer (SK-8), a submenu away from any chat list.
            if store.active != nil {
                Divider()
                Menu {
                    SafetyExitItems()
                } label: { Label("Sign out or disconnect", systemImage: "hand.raised") }
                    .accessibilityIdentifier("chats.menu.safety")
            }
        } label: {
            // The computers in view are the title's companion: their state, the name, and a chevron into the menu.
            HStack(spacing: 6) {
                Circle().fill(dot).frame(width: 8, height: 8)
                if showsPhone {
                    Image(systemName: "iphone").font(.footnote).foregroundStyle(palette.inkSoft).accessibilityHidden(true)
                } else {
                    ComputerGlyph(icon: shown?.icon, size: 14).foregroundStyle(palette.inkSoft)
                }
                VStack(alignment: .leading, spacing: 0) {
                    // Every computer reads "Computers", not "All computers": the wider pill pushed
                    // Nekko off the centre of the title bar (ChatStatusTests, run 41844125733).
                    // The menu's Show chats from still says All computers.
                    Text(showsPhone ? ChatPlace.phoneName : shown?.name ?? String(localized: "Computers")).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                    if shown == nil, !showsPhone, let online = Self.online(states.filter { $0 == .online }.count, of: states.count) {
                        Text(online).font(.caption2).foregroundStyle(palette.inkSoft).lineLimit(1)
                    }
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
            }
            .modifier(PillChrome())
            // One element with one label: the name inside the pill must not be read
            // (or matched by the UI tests) as a second label beside the menu's own.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier("chats.menu")
    }

    /// The filter as the list applies it: a forgotten computer's falls back to every computer.
    private var filter: String? {
        app.prefs.chatsFilter.flatMap { id in places.contains { $0.id == id } ? id : nil }
    }

    /// The paired computers, and this iPhone when it runs chats.
    private var places: [ChatPlace] { ChatPlace.all(store: store, phone: phone) }

    /// The pill names this iPhone: the list is filtered to it, or it is the only place.
    private var showsPhone: Bool {
        filter == PhoneProviders.computerId || (filter == nil && store.computers.isEmpty && places.contains(where: \.phone))
    }

    /// Show one computer's chats (it becomes the active one, for the menu's other
    /// items and New chat), this iPhone's, or every place's (nil).
    private func show(_ id: String?) {
        app.prefs.chatsFilter = id
        if let id, id != store.activeId, id != PhoneProviders.computerId { store.connect(id) }
    }

    /// The one computer the pill names: the filtered one, or the only one paired; nil for every computer.
    private var shown: Computer? {
        if let filter { return store.computers.first { $0.id == filter } }
        // With this iPhone in the list too, the pill stands for every place.
        return store.computers.count == 1 && places.count == 1 ? store.computers.first : nil
    }

    /// The connection of every computer the pill stands for.
    private var states: [RelayState] {
        // This iPhone is always there: it counts as online.
        if showsPhone { return [.online] }
        return shown.map { [store.state(of: $0.id)] } ?? store.computers.map { store.state(of: $0.id) }
    }

    /// Ends with the state the pill shows, as the UI tests read it: one computer's,
    /// or for every computer how many are online.
    private var label: String {
        if showsPhone { return String(localized: "Computers and settings, \(ChatPlace.phoneName)") }
        if shown == nil, let online = Self.online(states.filter { $0 == .online }.count, of: states.count) {
            return String(localized: "Computers and settings, all computers, \(online)")
        }
        return String(localized: "Computers and settings, \(stateName(states.first ?? .idle))")
    }

    /// The pill's second line for every computer together: how many are reachable now.
    static func online(_ online: Int, of count: Int) -> String? {
        count >= 2 ? String(localized: "\(online) of \(count) online") : nil
    }

    /// The pill's dot: the worst state among the computers it stands for.
    private var state: RelayState {
        for s in [RelayState.denied, .offline, .connecting, .idle] where states.contains(s) { return s }
        return .online
    }

    private var dot: Color {
        switch state {
        case .online: return palette.success
        case .connecting: return palette.running
        case .offline: return palette.warning
        case .denied: return palette.danger
        case .idle: return palette.inkFaint
        }
    }
}

/// The chat list's search, under the title: every word of the
/// search, in the title, first prompt or last reply. Cancel clears it.
struct SearchRow: View {
    @Binding var query: String
    var cancel: () -> Void
    @Environment(\.palette) private var palette
    @Environment(\.displayScale) private var scale
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.footnote).foregroundStyle(palette.inkFaint).accessibilityHidden(true)
                    TextField("Search chats", text: $query)
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .submitLabel(.search)
                        .accessibilityIdentifier("chats.search")
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(palette.inkFaint) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, 10)
                .frame(minHeight: 34)
                .background(palette.surface2, in: Capsule())
                Button("Cancel", action: cancel).font(.subheadline).frame(minHeight: 44)
                    .accessibilityIdentifier("chats.search.cancel")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
            Rectangle().fill(palette.line).frame(height: 1 / scale).accessibilityHidden(true)
        }
        .background { RowGround() }
        .onAppear { focused = true }
    }
}

/// The computer pill's own capsule, before iOS 26. From iOS 26 the toolbar draws
/// a glass capsule around the item itself, and a second one inside it read as a double border.
struct PillChrome: ViewModifier {
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.padding(.horizontal, 4)
        } else {
            content.padding(.horizontal, 10).padding(.vertical, 5).background(palette.surface2, in: Capsule())
        }
    }
}

/// Rename / delete / error dialogs for the chat list.
struct ChatDialogs: ViewModifier {
    @Binding var renaming: SessionSummary?
    @Binding var renameText: String
    @Binding var confirmDelete: SessionSummary?
    @Binding var actionError: String?
    var rename: (SessionSummary) -> Void
    var delete: (SessionSummary) -> Void
    var computer: String

    func body(content: Content) -> some View {
        content
            .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Rename") { if let s = renaming { rename(s) } }
            }
            .confirmationDialog("Delete this chat on \(computer)?",
                                isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) { if let s = confirmDelete { delete(s) } }
            } message: {
                Text("It is removed from the computer for good.")
            }
            .alert("Couldn’t do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(actionError ?? "")
            }
    }
}

/// The line above a saved chat list, and above the composer of a saved chat:
/// when it was saved, and that it isn't live.
enum SavedListNote {
    static func text(savedAt ms: Int64, computer: String, now: Date = .now, calendar: Calendar = .current) -> String {
        "Saved list from \(when(ms, now: now, calendar: calendar)). It updates when \(computer) answers."
    }

    /// A chat read from the phone's saved copy (OF-5).
    static func copy(savedAt ms: Int64, computer: String, now: Date = .now, calendar: Calendar = .current) -> String {
        "Saved copy from \(when(ms, now: now, calendar: calendar)). It updates when \(computer) answers."
    }

    private static func when(_ ms: Int64, now: Date, calendar: Calendar) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        return calendar.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(date: .abbreviated, time: .shortened)
    }
}
