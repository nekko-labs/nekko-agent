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
    /// Read the shared preference directly so recreated lists and iPad panes agree.
    private var opened: Set<String> { prefs.openedChatGroups }
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
                List { rows.listRowSeparator(.hidden).listSectionSeparator(.hidden) }
            }
        }
        // Flat rows straight on the coloured ground, hairline separated, as the
        // desktop's Agents panel (2026-10-24; the panels of 2026-10-26 went 2026-10-28).
        .listStyle(.plain)
        .animation(reduceMovement ? nil : .smooth(duration: 0.35), value: sections)
        .listRowSeparatorTint(palette.line)
        .appBackground()
        // Room for the floating pill under the large title, while it sits there.
        .contentMargins(.top, searching ? 0 : AgentPillLayer.room(prefs.pillPlacement, gauges: gauges), for: .scrollContent)
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
        // The minimal monitor while the hardware shows, floating under the title.
        .agentPill(gauges: gauges, monitor: monitor, hidden: searching || pillHidden, expanded: $showPanel)
        .modifier(MonitorFollow(monitor: $monitor, ids: ["hardware", "ph-monitors"], panelOpen: showPanel))
        .overlay(alignment: .top) { if store.summariesLoading && listSummaries.isEmpty { ProgressView().padding(.top, 80) } }
        .modifier(dialogs)
        .sheet(isPresented: $reorderingGroups) {
            ReorderGroupsSheet(groups: sections.filter { $0.key != ChatGroup.general }.map { GroupName(key: $0.key, name: $0.name) }) { setGroupOrder($0) }
        }
        .sheet(isPresented: $sendingFeedback) { FeedbackSheet() }
    }

    /// The readings the floating pill shows, while the hardware shows; no pill otherwise.
    private var gauges: HardwareMonitorModel? {
        prefs.shows("hardware", localModelLoaded: monitor?.localModelLoaded ?? false) ? monitor : nil
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
            if computersInView {
                // Every paired computer and its connection, in one slim row; a problem opens to its fix.
                ConnectionStrip(details: { open(.connection) })
                    .listRowSeparator(.hidden).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
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
                    if g.isOpen(opened: opened, searching: !query.isEmpty) { sectionRows(g) }
                } header: {
                    if g.key != ChatGroup.general && g.key != "all" { sectionHeading(g) }
                }.listSectionSeparator(.hidden)
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
        let open = g.isOpen(opened: opened, searching: !query.isEmpty)
        let live = g.key == "status:watching" ? g.watchingCount > 0 : ["status:building", "status:verifying"].contains(g.key) && g.headerActivity(listActivity) == .running
        let heading = Button {
            // Search reveals matching rows temporarily, without changing the saved choice.
            guard query.isEmpty else { return }
            withAnimation { flip(&prefs.openedChatGroups, g.key) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(palette.inkSoft)
                    .rotationEffect(.degrees(open ? 90 : 0))
                // By computer: the place's mark in its colour, as on its rows.
                if let id = sourceId(g), let place = ChatPlace.of(id, store: store) {
                    PlaceMark(place: place, showIcon: view.showComputerIcons, size: 14)
                }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(groupTitle(g)).font(.subheadline.weight(.medium)).foregroundStyle(palette.accent).lineLimit(1)
                        if live { ChatGroupActivity(kind: g.key) }
                        Spacer(minLength: 4)
                        if live || !open {
                            Text("\(g.chats.count)")
                                .font(.caption2.weight(live ? .semibold : .regular).monospacedDigit())
                                .foregroundStyle(live ? palette.success : palette.inkFaint)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background((live ? palette.success : palette.inkFaint).opacity(0.12), in: Capsule())
                        }
                    }.textCase(nil)
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
        .accessibilityIdentifier("chats.group.\(g.key)")
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
    /// One native menu (#2449): each row names a setting and shows its value, Card
    /// details and Show open the system's own submenus, a tap outside closes it, and
    /// Reset appears only when the view differs from the defaults.
    private var viewMenu: some View {
        Menu {
            // The quick Simple / Detailed switch atop the menu (#2055), as one compact row.
            Picker("Agent output", selection: Binding(get: { prefs.expertMode }, set: { prefs.expertMode = $0 })) {
                Text("Simple").tag(false)
                Text("Detailed").tag(true)
            }
            .pickerStyle(.palette)
            .accessibilityIdentifier("chats.view.mode")
            // Each row names the setting with its current value under it (a menu's
            // subtitle); its choices open in the system's submenu.
            Section {
                Menu {
                    Picker("Group by", selection: bind(\.groupBy)) {
                        // By computer, as the desktop offers it, once chats come from more than one place.
                        ForEach(ChatListView.GroupBy.allCases.filter { $0 != .computer || places.count > 1 }, id: \.self) {
                            Text(Self.groupName($0)).tag($0)
                        }
                    }
                    .pickerStyle(.inline).labelsHidden()
                } label: {
                    Text("Group by")
                    Text(Self.groupName(view.groupBy))
                }
                .accessibilityIdentifier("chats.view.groupBy")
                Menu {
                    Picker("Sort by", selection: Binding(get: { view.sortBy }, set: { app.prefs.chatListView = view.withSort($0) })) {
                        ForEach(ChatListView.SortBy.allCases, id: \.self) { Text(Self.sortName($0)).tag($0) }
                    }
                    .pickerStyle(.inline).labelsHidden()
                } label: {
                    Text("Sort by")
                    Text(Self.sortName(view.sortBy))
                }
                .accessibilityIdentifier("chats.view.sortBy")
                // Manual order has no direction: it is whatever was dragged on the computer.
                if view.sortBy != .manual {
                    Menu {
                        Picker("Order", selection: bind(\.ascending)) {
                            Text(orderName(ascending: true)).tag(true)
                            Text(orderName(ascending: false)).tag(false)
                        }
                        .pickerStyle(.inline).labelsHidden()
                    } label: {
                        Text("Order")
                        Text(orderName(ascending: view.ascending))
                    }
                }
            }
            Section {
                // Toggles keep the submenu open, so several can be flipped in one go.
                Menu("Card details") {
                    Toggle("Model", isOn: bind(\.showModel)).menuActionDismissBehavior(.disabled)
                        .accessibilityIdentifier("chats.view.showModel")
                    Toggle("Context window", isOn: bind(\.showContext)).menuActionDismissBehavior(.disabled)
                        .accessibilityIdentifier("chats.view.showContext")
                    Toggle("Pull requests", isOn: bind(\.showPullRequests)).menuActionDismissBehavior(.disabled)
                        .accessibilityIdentifier("chats.view.showPullRequests")
                    Toggle("Last updated", isOn: bind(\.showUpdated)).menuActionDismissBehavior(.disabled)
                        .accessibilityIdentifier("chats.view.showUpdated")
                }
                Menu("Show") {
                    Toggle("Previews", isOn: bind(\.showPreviews)).menuActionDismissBehavior(.disabled)
                    Toggle("Completed chats", isOn: bind(\.showCompleted)).menuActionDismissBehavior(.disabled)
                    Toggle("Always show groups", isOn: bind(\.showEmptyGroups)).menuActionDismissBehavior(.disabled)
                        .accessibilityIdentifier("chats.view.showEmptyGroups")
                    if places.count > 1 {
                        Toggle("Computer", isOn: bind(\.showComputer)).menuActionDismissBehavior(.disabled)
                        Toggle("Computer icons", isOn: bind(\.showComputerIcons)).menuActionDismissBehavior(.disabled)
                    }
                }
            }
            Section {
                if view.canReorderGroups {
                    Button { reorderingGroups = true } label: { Label("Reorder groups…", systemImage: "arrow.up.arrow.down") }
                }
                Button { open(.customize) } label: { Label("Customize…", systemImage: "slider.horizontal.3") }
            }
            // Only when there is something to reset: what does not apply is gone, not greyed.
            if !view.isStandard {
                Section {
                    Button { app.prefs.chatListView = .standard } label: { Label("Reset to defaults", systemImage: "arrow.counterclockwise") }
                        .accessibilityIdentifier("chats.view.reset")
                }
            }
        } label: {
            Image(systemName: view.isStandard ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("View options")
        .accessibilityIdentifier("chats.view")
    }

    private var view: ChatListView { app.prefs.chatListView }

    /// A sort's direction in words: names A to Z or Z to A, dates oldest or newest first.
    private func orderName(ascending: Bool) -> String {
        view.sortBy == .name
            ? (ascending ? String(localized: "A to Z") : String(localized: "Z to A"))
            : (ascending ? String(localized: "Oldest first") : String(localized: "Newest first"))
    }

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

    /// The kind of provider a chat runs on, from the list of the place that holds it:
    /// this iPhone's own providers, or the active computer's. Nil for a chat on a
    /// computer not in view, whose row then names the provider from the model.
    private func providerKind(of s: SessionSummary) -> String? {
        guard let id = s.providerId else { return nil }
        if PhoneProviders.isPhoneChat(s.id) { return phone.providers.first { $0.id == id }?.kind }
        guard (owner(s) ?? store.activeId) == store.activeId else { return nil }
        return store.providers.first { $0.id == id }?.kind
    }

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
                    prs: view.showPullRequests ? store.rowPrs[s.id] ?? [] : [], providerKind: providerKind(of: s),
                    showModel: view.showModel, showContext: view.showContext, showUpdated: view.showUpdated)
        }
        // Straight on the ground like the rest of the list, with the attention bar on a chat that needs you.
        .listRowSeparator(.hidden)
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
    /// The kind of provider it runs on (`providers:list`), for the mark beside the model.
    var providerKind: String? = nil
    var showModel = true
    var showContext = true
    var showUpdated = true
    @Environment(\.palette) private var palette

    var body: some View {
        // A glyph column says what the chat is doing before the title is read
        // (the desktop's StatusIcon). Under the title, the desktop card's line:
        // the provider's mark and the model, then how full the context is while
        // the chat is in progress. The PR chip sits at the bottom right.
        HStack(alignment: .top, spacing: 10) {
            ChatStatusIcon(activity: activity, completed: summary.archived, waiting: waiting > 0, activeWatchCount: summary.activeWatchCount)
                .frame(width: 22, height: 22).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if summary.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(palette.warning).accessibilityLabel("Pinned") }
                    Text(title).font(.body.weight(.semibold)).foregroundStyle(summary.archived ? palette.inkSoft : palette.ink)
                        .lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
                if summary.chatType == "image" {
                    Label("Image", systemImage: "photo").font(.caption2).foregroundStyle(palette.accent)
                }
                if modelShown || contextShown != nil || showUpdated {
                    HStack(spacing: 6) {
                        if modelShown, let model = shownModelId {
                            ModelFact(model: model, mark: ChatCard.providerMark(kind: providerKind, modelId: model))
                        }
                        if let context = contextShown { ContextFact(context: context) }
                        if showUpdated {
                            Spacer(minLength: 4)
                            TimelineView(.periodic(from: .now, by: 60)) { _ in
                                Text(Date(timeIntervalSince1970: Double(summary.updatedAt) / 1000), format: .relative(presentation: .numeric, unitsStyle: .narrow))
                                    .font(.caption2).foregroundStyle(palette.inkFaint)
                            }
                        }
                    }
                }
                if showPreview, let preview { Text(preview).font(.footnote).foregroundStyle(palette.inkFaint).lineLimit(2) }
                if activity != nil || waiting > 0 || place != nil || !prs.isEmpty {
                    HStack(spacing: 6) {
                        badge
                        if let place { PlaceChip(place: place, showIcon: showPlaceIcon) }
                        if waiting > 0 {
                            Label("\(waiting) waiting", systemImage: "tray.and.arrow.up")
                                .font(.caption2).foregroundStyle(palette.inkSoft)
                                .accessibilityLabel(waiting == 1 ? "1 prompt waiting to send" : "\(waiting) prompts waiting to send")
                        }
                        if !prs.isEmpty {
                            Spacer(minLength: 4)
                            RowPrChip(prs: prs)
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        let text = summary.title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return text.isEmpty ? "New chat" : text
    }

    /// An image chat shows the image model it draws with, not the chat model.
    private var shownModelId: String? { summary.chatType == "image" ? summary.imageParams?.modelId : summary.modelId }
    private var modelShown: Bool { showModel && shownModelId != nil }

    /// The context gauge, while the chat is in progress (the desktop hides it once a chat is done).
    private var contextShown: ChatCard.Context? {
        guard showContext, ChatCard.showsContext(summary, activity: activity) else { return nil }
        return ChatCard.context(summary)
    }

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

/// The model a chat runs on, as the desktop card's line: the provider's mark,
/// tinted like the words, then "Opus 5.5". No mark for a custom endpoint.
struct ModelFact: View {
    let model: String
    let mark: String?
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 4) {
            if let mark {
                Image("provider-\(mark)").renderingMode(.template).resizable().scaledToFit()
                    .frame(width: 11, height: 11).accessibilityHidden(true)
                    .accessibilityIdentifier("chats.row.provider.\(mark)")
            }
            Text(ChatCard.modelName(model)).lineLimit(1)
        }
        .font(.caption2.weight(.medium)).foregroundStyle(palette.accent)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Model \(ChatCard.modelName(model))")
        .accessibilityIdentifier("chats.row.model")
    }
}

/// How full the chat's context window is, `45k/1M`, in the hue of how close to
/// full it is (the desktop's `fillTone`: green, amber from 60%, red from 85%).
struct ContextFact: View {
    let context: ChatCard.Context
    @Environment(\.palette) private var palette

    var body: some View {
        Text(context.text)
            .font(.caption2.monospacedDigit()).foregroundStyle(tone).lineLimit(1)
            .accessibilityLabel("Context window \(context.percent) percent full")
            .accessibilityIdentifier("chats.row.context")
    }

    private var tone: Color {
        switch context.fill {
        case .room: return palette.success
        case .filling: return palette.warning
        case .full: return palette.danger
        }
    }
}

/// The PRs a chat made, as the desktop card's chip (`SessionPrChip`): the PR that
/// matters most with GitHub's glyph for its state, tinted as GitHub tints it, and
/// `+N` for the others. Opening the chat lists each one.
struct RowPrChip: View {
    let prs: [PullRequest]
    @Environment(\.palette) private var palette

    var body: some View {
        if let pr = ChatCard.primaryPr(prs) {
            let status = ChatCard.prStatus(pr)
            HStack(spacing: 4) {
                HStack(spacing: 2) {
                    Image(Self.glyph(status)).renderingMode(.template).resizable().scaledToFit()
                        .frame(width: 11, height: 11)
                    Text("#\(pr.number)")
                }
                .foregroundStyle(tone(status))
                if prs.count > 1 { Text("+\(prs.count - 1)").foregroundStyle(palette.inkFaint) }
            }
            .font(.caption2.weight(.semibold).monospacedDigit())
            .padding(.horizontal, 6).padding(.vertical, 1)
            .overlay(Capsule().stroke(palette.line, lineWidth: 1))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityIdentifier("chats.row.prs")
        }
    }

    static func glyph(_ s: ChatCard.PrStatus) -> String {
        switch s {
        case .open: return "pr-open"
        case .draft: return "pr-draft"
        case .merged: return "pr-merged"
        case .closed: return "pr-closed"
        }
    }

    /// Merged in the merge hue, closed in danger, a draft faint, an open one green: the desktop's `prTone`.
    private func tone(_ s: ChatCard.PrStatus) -> Color {
        switch s {
        case .merged: return palette.accent
        case .closed: return palette.danger
        case .draft: return palette.inkFaint
        case .open: return palette.success
        }
    }

    private var label: String {
        prs.map { pr in
            let s: String = switch ChatCard.prStatus(pr) {
            case .merged: String(localized: "merged")
            case .closed: String(localized: "closed")
            case .draft: String(localized: "draft")
            case .open: String(localized: "open")
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
            Button { path.append(.pullRequests) } label: { Label("Pull requests", systemImage: "arrow.triangle.pull") }
                .accessibilityIdentifier("chats.menu.pullRequests")
            Button { path.append(.connectors) } label: { Label("Connectors", systemImage: "point.3.connected.trianglepath.dotted") }
                .accessibilityIdentifier("chats.menu.connectors")
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
                    // A long computer name (a CI Mac's is 40 characters with no spaces) widened the
                    // pill until iOS 26 folded the whole toolbar, New chat included, into More.
                    Text(showsPhone ? ChatPlace.phoneName : shown?.name ?? String(localized: "Computers")).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 150, alignment: .leading)
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
