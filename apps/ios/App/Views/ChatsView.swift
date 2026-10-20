import NekkoKit
import NekkoProtocol
import SwiftUI

/// The computer's chats, grouped like the desktop's sidebar (General, then
/// each project folder), with Working / Needs you badges, search, swipe to
/// complete / delete, and the computer switcher in the title.
struct ChatsView: View {
    @Binding var path: [Route]
    /// iPad (regular width): the split view's selected chat. Nil on iPhone, where rows push.
    var selection: Binding<Route?>? = nil
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var query = ""
    @State private var showCompleted: Set<String> = []
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
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(palette.paper)
        .searchable(text: $query, prompt: "Search chats")
        .refreshable { await store.refresh() }
        .navigationTitle(store.active?.name ?? "Chats")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ComputerMenu(path: $path) }
            ToolbarItem(placement: .topBarTrailing) {
                // Offline too: a chat started now begins when the computer is back.
                Button { open(.newChat) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New chat")
            }
        }
        .overlay(alignment: .top) { if store.summariesLoading && store.summaries.isEmpty { ProgressView().padding(.top, 80) } }
        .modifier(dialogs)
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
            if query.isEmpty, let last = ChatSearch.continueChat(store.summaries), store.activity[last.id] != .needsYou {
                Section {
                    ContinueCard(summary: last, activity: store.activity[last.id]) { open(.chat(last.id)) }
                }
            }
            if !needsYou.isEmpty && query.isEmpty {
                Section { ForEach(needsYou) { row($0) } } header: { SectionTitle("Needs you") }
            }
            ForEach(query.isEmpty || !filtered.isEmpty ? groups : []) { g in
                Section {
                    if g.active.isEmpty && g.completed.isEmpty {
                        Text("No active agents").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                    ForEach(g.active) { row($0) }
                    if !g.completed.isEmpty {
                        DisclosureGroup(isExpanded: Binding(get: { showCompleted.contains(g.key) || !query.isEmpty },
                                                            set: { if $0 { showCompleted.insert(g.key) } else { showCompleted.remove(g.key) } })) {
                            ForEach(g.completed) { row($0) }
                        } label: {
                            Text("Completed · \(g.completed.count)").font(.footnote).foregroundStyle(palette.inkSoft)
                        }
                    }
                } header: {
                    SectionTitle(g.name)
                }
            }
    }

    /// Every word of the search, in the title, first prompt or last reply; completed chats too.
    private var filtered: [SessionSummary] { ChatSearch.matches(store.summaries, query) }

    private var groups: [ChatGroup] { ChatGroup.of(filtered, folders: store.workspaces) }

    private var needsYou: [SessionSummary] { store.summaries.filter { store.activity[$0.id] == .needsYou } }

    private func row(_ s: SessionSummary) -> some View {
        NavigationLink(value: Route.chat(s.id)) {
            ChatRow(summary: s, activity: store.activity[s.id], waiting: store.outbox.count(for: s.id))
        }
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
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if summary.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(palette.warning) }
                    Text(title).font(.body.weight(.medium)).foregroundStyle(summary.archived ? palette.inkSoft : palette.ink).lineLimit(1)
                }
                if let preview { Text(preview).font(.footnote).foregroundStyle(palette.inkFaint).lineLimit(2) }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 4) {
                // Re-rendered each minute, so "2m" doesn't stay "2m".
                TimelineView(.periodic(from: .now, by: 60)) { _ in
                    Text(Date(timeIntervalSince1970: Double(summary.updatedAt) / 1000), format: .relative(presentation: .numeric, unitsStyle: .narrow))
                        .font(.caption2).foregroundStyle(palette.inkFaint)
                }
                badge
                if waiting > 0 {
                    Label("\(waiting) waiting", systemImage: "tray.and.arrow.up")
                        .font(.caption2).foregroundStyle(palette.inkSoft)
                        .accessibilityLabel(waiting == 1 ? "1 prompt waiting to send" : "\(waiting) prompts waiting to send")
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var title: String { summary.title.trimmingCharacters(in: .whitespaces).isEmpty ? "New chat" : summary.title }

    private var preview: String? {
        let t = (summary.lastReplyText ?? summary.firstUserText ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? nil : t
    }

    @ViewBuilder private var badge: some View {
        switch activity {
        case .needsYou?:
            Text("Needs you").font(.caption2.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2)
                .background(palette.warning.opacity(0.18), in: Capsule()).foregroundStyle(palette.warning)
        case .running?:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Working").font(.caption2)
            }.foregroundStyle(palette.running)
        case nil:
            EmptyView()
        }
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

/// Switch computers, pair another, open settings.
struct ComputerMenu: View {
    @Binding var path: [Route]
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette

    var body: some View {
        Menu {
            ForEach(store.computers) { c in
                Button { store.connect(c.id) } label: {
                    if c.id == store.activeId { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
            Divider()
            Button { path.append(.pair) } label: { Label("Pair another computer", systemImage: "plus") }
            Button { path.append(.automations) } label: { Label("Automations", systemImage: "bolt.badge.clock") }
            Button { path.append(.usage) } label: { Label("Usage and limits", systemImage: "gauge.with.dots.needle.33percent") }
            Button { path.append(.computers) } label: { Label("Computers", systemImage: "desktopcomputer") }
            Button { path.append(.settings) } label: { Label("Settings", systemImage: "gearshape") }
        } label: {
            HStack(spacing: 5) {
                Circle().fill(dot).frame(width: 8, height: 8)
                Image(systemName: "desktopcomputer")
            }
        }
        .accessibilityLabel("Computers and settings, \(store.conn.rawValue)")
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
