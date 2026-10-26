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
    @Environment(\.palette) private var palette
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

    var body: some View {
        Group {
            if let selection {
                List(selection: selection) { rows }
            } else {
                List { rows }
            }
        }
        // Flat rows on the paper, hairline separated, as the desktop's Agents panel (2026-10-24).
        .listStyle(.plain)
        .listRowSeparatorTint(palette.line)
        .scrollContentBackground(.hidden)
        .background(palette.paper)
        .searchable(text: $query, prompt: "Search chats")
        .refreshable { await store.refresh() }
        .navigationTitle("Chats")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                ChatMascot(working: store.activity.values.contains(.running))
            }
            ToolbarItem(placement: .topBarLeading) { ComputerMenu(path: $path, feedback: $sendingFeedback) }
            ToolbarItem(placement: .topBarTrailing) { viewMenu }
            ToolbarItem(placement: .topBarTrailing) {
                // Offline too: a chat started now begins when the computer is back.
                Button { open(.newChat) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New chat")
            }
        }
        .overlay(alignment: .top) { if store.summariesLoading && store.summaries.isEmpty { ProgressView().padding(.top, 80) } }
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
                    rename: { s in act { try await store.renameChat(s.id, to: renameText) } },
                    delete: { s in act { try await store.deleteChat(s.id) } },
                    computer: store.active?.name ?? "your computer")
    }

    @ViewBuilder private var rows: some View {
            ConnectionBanner().listRowSeparator(.hidden).listRowBackground(Color.clear)
            ProtocolBanner().listRowSeparator(.hidden).listRowBackground(Color.clear)
            if let at = store.savedListAt {
                Label(SavedListNote.text(savedAt: at, computer: store.active?.name ?? "your computer"), systemImage: "clock.arrow.circlepath")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                    .accessibilityIdentifier("chats.savedList")
            }
            if store.summariesLoaded && store.summaries.isEmpty && !store.summariesLoading, let e = store.lastError {
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
            } else if store.conn == .online && store.summariesLoaded && store.summaries.isEmpty && !store.summariesLoading {
                // Not ContentUnavailableView: its fixed layout clips at large text sizes.
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.bubble.right").font(.largeTitle).foregroundStyle(palette.inkSoft)
                        .accessibilityHidden(true)
                    Text("No chats yet").font(.title3.weight(.semibold)).foregroundStyle(palette.ink)
                    Text("Start one here, or on \(store.active?.name ?? "your computer").")
                        .font(.subheadline).foregroundStyle(palette.inkSoft)
                    Button { open(.newChat) } label: { Text("New chat").foregroundStyle(palette.onAccent) }
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
                    ForEach(store.outbox.pendingNewChats) { item in PendingChatRow(item: item, path: $path) }
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
            if query.isEmpty && !store.computers.isEmpty {
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
        let split = ChatSections.split(g, activity: store.activity, now: nowMs)
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
                VStack(alignment: .leading, spacing: 3) {
                    GroupHeading(groupTitle(g), count: counts(g))
                    if let path = store.workspaces.first(where: { $0.id == g.key })?.path {
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
                ForEach(ChatListView.GroupBy.allCases, id: \.self) { Text(Self.groupName($0)).tag($0) }
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
                Toggle("Empty groups", isOn: bind(\.showEmptyGroups))
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
        store.workspaces.contains { $0.id == g.key } ? g.name : String(localized: String.LocalizationValue(g.name))
    }

    private var nowMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private var sections: [ChatSection] {
        ChatSections.make(filtered, folders: store.workspaces, view: view, activity: store.activity,
                          groupOrder: app.prefs.groupOrder[store.activeId ?? ""] ?? [], now: nowMs)
    }

    private func flip(_ set: inout Set<String>, _ key: String) {
        if set.contains(key) { set.remove(key) } else { set.insert(key) }
    }

    private func setGroupOrder(_ keys: [String]) {
        guard let id = store.activeId else { return }
        withAnimation { app.prefs.groupOrder[id] = keys }
        dropTarget = nil
    }

    /// Every word of the search, in the title, first prompt or last reply; completed chats too.
    private var filtered: [SessionSummary] { ChatSearch.matches(store.summaries, query) }

    /// "3 active · 12 done", as the desktop's group headings count.
    private func counts(_ g: ChatSection) -> String {
        var parts: [String] = []
        if g.activeCount > 0 { parts.append(g.activeCount == 1 ? String(localized: "1 active") : String(localized: "\(g.activeCount) active")) }
        if g.doneCount > 0 { parts.append(String(localized: "\(g.doneCount) done")) }
        return parts.joined(separator: " · ")
    }

    private var needsYou: [SessionSummary] { store.summaries.filter { store.activity[$0.id] == .needsYou } }

    private func row(_ s: SessionSummary) -> some View {
        NavigationLink(value: Route.chat(s.id)) {
            ChatRow(summary: s, activity: store.activity[s.id], waiting: store.outbox.count(for: s.id), showPreview: view.showPreviews)
        }
        // On the paper like the rest of the list, with the attention bar on a chat that needs you.
        .listRowBackground(RowBackground(needsYou: store.activity[s.id] == .needsYou,
                                         selected: selection.map { $0.wrappedValue == .chat(s.id) } ?? (highlighted == s.id)))
        .accessibilityIdentifier("chats.row")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if s.archived {
                Button { act { try await store.restoreChat(s.id) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    .tint(palette.running)
            } else if store.pcSettings.effectiveAction == .delete {
                Button(role: .destructive) { askDelete(s) } label: { Label("Delete", systemImage: "trash") }
            } else {
                Button { act { try await store.completeChat(s.id) } } label: { Label("Complete", systemImage: "checkmark.circle") }
                    .tint(palette.success)
            }
        }
        .swipeActions(edge: .leading) {
            Button { act { try await store.setPinned(s.id, !s.pinned) } } label: {
                Label(s.pinned ? "Unpin" : "Pin", systemImage: s.pinned ? "pin.slash" : "pin")
            }.tint(palette.warning)
        }
        .contextMenu {
            Button { renameText = s.title; renaming = s } label: { Label("Rename", systemImage: "pencil") }
            Button { act { try await store.setPinned(s.id, !s.pinned) } } label: { Label(s.pinned ? "Unpin" : "Pin", systemImage: "pin") }
            if s.archived {
                Button { act { try await store.restoreChat(s.id) } } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
            } else {
                Button { act { try await store.completeChat(s.id) } } label: { Label("Complete", systemImage: "checkmark.circle") }
            }
            Button(role: .destructive) { askDelete(s) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func askDelete(_ s: SessionSummary) {
        if store.pcSettings.confirmDelete { confirmDelete = s } else { act { try await store.deleteChat(s.id) } }
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
                if activity != nil || waiting > 0 {
                    HStack(spacing: 6) {
                        badge
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
        case nil: EmptyView()
        }
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
            if selected { palette.accent.opacity(0.12) } else if needsYou { palette.warning.opacity(0.07) } else { Color.clear }
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

/// Switch computers, pair another, open settings, send feedback.
struct ComputerMenu: View {
    @Binding var path: [Route]
    /// Presents *Send feedback*; the sheet hangs on the chat list, not on the toolbar item.
    @Binding var feedback: Bool
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var forgetting: Computer?

    var body: some View {
        Menu {
            // Each computer opens its own actions: switch to it, or forget it here.
            ForEach(store.computers) { c in
                Menu {
                    if c.id != store.activeId {
                        Button { store.connect(c.id) } label: { Label("Connect", systemImage: "bolt.horizontal") }
                    }
                    Button(role: .destructive) { forgetting = c } label: { Label("Forget…", systemImage: "trash") }
                } label: {
                    if c.id == store.activeId { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
            Divider()
            Button { path.append(.pair) } label: { Label("Pair another computer", systemImage: "plus") }
            Button { path.append(.automations) } label: { Label("Automations", systemImage: "bolt.badge.clock") }
            Button { path.append(.usage) } label: { Label("Usage and limits", systemImage: "gauge.with.dots.needle.33percent") }
            Button { path.append(.files) } label: { Label("Files", systemImage: "folder") }
                .accessibilityIdentifier("computer.files")
            Button { path.append(.logs) } label: { Label("Logs", systemImage: "doc.text.magnifyingglass") }
                .accessibilityIdentifier("computer.logs")
            Button { path.append(.computers) } label: { Label("Computers", systemImage: "desktopcomputer") }
            Button { path.append(.settings) } label: { Label("Settings", systemImage: "gearshape") }
            Button { feedback = true } label: { Label("Send feedback", systemImage: "envelope") }
                .accessibilityIdentifier("computer.feedback")
            // The safety exits for the active computer (SK-8), a submenu away from any chat list.
            if store.active != nil {
                Divider()
                Menu {
                    SafetyExitItems()
                } label: { Label("Sign out or stop", systemImage: "hand.raised") }
                    .accessibilityIdentifier("chats.menu.safety")
            }
        } label: {
            // The computer is the title's companion: its state, its name, and a chevron into the menu.
            HStack(spacing: 6) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(store.active?.name ?? String(localized: "Computers")).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
            }
            .modifier(PillChrome())
            // One element with one label: the name inside the pill must not be read
            // (or matched by the UI tests) as a second label beside the menu's own.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Computers and settings, \(stateName(store.conn))")
        }
        .accessibilityLabel("Computers and settings, \(stateName(store.conn))")
        .accessibilityIdentifier("chats.menu")
        .forgetDialog($forgetting)
    }

    private var dot: Color {
        switch store.conn {
        case .online: return palette.success
        case .connecting: return palette.running
        case .offline: return palette.warning
        case .denied: return palette.danger
        case .idle: return palette.inkFaint
        }
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
