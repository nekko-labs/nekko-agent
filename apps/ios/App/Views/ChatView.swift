import NekkoKit
import NekkoProtocol
import PhotosUI
import SwiftUI

/// One chat on the computer: the transcript as it streams, tool steps, the
/// computer's approvals and questions, and the composer.
struct ChatView: View {
    let sessionId: String
    @Environment(AppModel.self) private var app
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var chat: ChatModel?
    @State private var showModels = false
    @State private var showChanges = false
    @State private var renaming = false
    @State private var renameText = ""
    @State private var actionError: String?
    @State private var showGit = false
    @State private var showGitScreen = false
    @State private var showTerminals = false
    @State private var showFiles = false
    /// The photos open full screen.
    @State private var viewing: PhotoSet?
    /// Whether the end of the transcript is on screen: only then does it follow new output.
    @State private var atBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(Prefs.self) private var prefs
    /// Expert mode's hardware and loaded models, read while the chat is on screen.
    @State private var monitor: HardwareMonitorModel?
    /// Tabletop (FD-6): the hinge in window points, from the pane host; nil elsewhere.
    @Environment(\.paneHinge) private var paneHinge
    /// In the pane host: messages can be dragged to the other pane.
    @Environment(\.inPanes) private var inPanes
    /// This chat's frame in the window, to place the hinge.
    @State private var windowFrame: CGRect = .zero
    /// Something is being dragged over the chat.
    @State private var dropping = false

    var body: some View {
        Group {
            if let chat {
                content(chat)
            } else {
                ProgressView()
            }
        }
        .background { AppBackdrop() }
        .navigationBarTitleDisplayMode(.inline)
        // No keyboard toolbar here: on iOS 26 its Done floats over the
        // composer's send button. Scrolling or tapping the transcript puts
        // the keyboard away, and the message box has a VoiceOver action for it.
        .task(id: sessionId) {
            // Coming back to the same chat (a pushed screen popped) keeps the
            // model and what has streamed so far; start() re-subscribes and re-reads.
            if chat?.sessionId != sessionId {
                chat?.stop()
                chat = ChatModel(sessionId: sessionId, store: store)
            }
            chat?.start()
            app.notifier.clear(sessionId: sessionId)
            if let first = app.firstMessages.removeValue(forKey: sessionId), let chat {
                await chat.reload()
                do { try await chat.send(first.text, images: first.images) } catch {
                    chat.handBack(first)
                    actionError = error.localizedDescription
                }
            }
        }
        .onDisappear { chat?.stop() }
        .onChange(of: store.conn) { _, s in chat?.connectionChanged(s) }
    }

    @ViewBuilder private func content(_ chat: ChatModel) -> some View {
        let flex = self.flex
        ScrollViewReader { proxy in
         // Tabletop (FD-6): the transcript above the hinge, the composer and cards below it.
         // One structure either way, so the transcript keeps its place when the phone folds.
         VStack(spacing: 0) {
          // At least as tall as the space above the bottom bar, bottom-aligned:
          // a short transcript then moves up when an approval or question card
          // grows the bar, instead of staying pinned where the card now covers it.
          GeometryReader { geo in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let n = chat.session?.omittedMessages, n > 0 {
                        Text("\(n) earlier messages are on \(store.active?.name ?? "your computer").")
                            .font(.footnote).foregroundStyle(palette.inkFaint).frame(maxWidth: .infinity)
                    }
                    if !chat.ready { ProgressView().frame(maxWidth: .infinity).padding(.top, 40) }
                    ForEach(TranscriptRow.of(chat.blocks)) { row in
                        switch row {
                        case .block(let b):
                            BlockView(block: b, chat: chat, photos: b.isPrompt ? chat.photos(b.id) : []) { i in
                                viewing = PhotoSet(photos: chat.photos(b.id), index: i)
                            }
                            .id(b.id)
                            // Drag a message to the other pane's composer (FD-4); it lands as text, never sent.
                            .modifier(PaneDraggable(text: inPanes ? b.copyText : nil))
                            .contextMenu { blockMenu(chat, b) }
                        case .agents(let blocks):
                            // Consecutive delegations read as one group, as on the desktop.
                            SubagentGroup(blocks: blocks, chat: chat)
                                .id(row.id)
                                .contextMenu { if let first = blocks.first { blockMenu(chat, first) } }
                        case .purpose(let purpose, let blocks, let calls):
                            // Adjacent calls with one purpose: one row that says the goal, opening to the calls.
                            PurposeGroupRow(purpose: purpose, blocks: blocks, calls: calls) { b in
                                BlockView(block: b, chat: chat)
                                    .id(b.id)
                                    .contextMenu { blockMenu(chat, b) }
                            }
                            .id(row.id)
                        }
                    }
                    // Prompts written here that the computer doesn't have yet.
                    ForEach(chat.waiting) { item in
                        WaitingRow(item: item, sending: store.outbox.sendingId == item.id, online: store.conn == .online,
                                   edit: { _ = store.outbox.takeBack(item.id) },
                                   delete: { _ = store.outbox.remove(item.id) },
                                   sendNow: { sendNow() })
                            .id("waiting-\(item.id)")
                    }
                    if chat.turn.running && chat.turn.approval == nil && chat.turn.question == nil {
                        let working = chat.turn.blocks.isEmpty ? "Working…" : "Working on \(store.active?.name ?? "your computer")…"
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(working).font(.footnote).foregroundStyle(palette.inkSoft)
                        }
                        // A status line a full row tall: the audit measures it as a target.
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(working)
                        .accessibilityAddTraits(.isStaticText)
                        .id("working")
                    }
                    if let e = chat.error {
                        Label(e, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(minHeight: geo.size.height, alignment: .bottom)
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
            .defaultScrollAnchor(.bottom)
          }
            // Follow streamed output only while the reader is at the end, and
            // without animating every token (overlapping animations shudder).
            .onChange(of: chat.blocks.last) { _, _ in if atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
            // An approval or question card grows the bottom bar: keep the latest step above it.
            // After the card has been laid out: scrolling in the same update used the old inset.
            .onChange(of: chat.turn.approval?.call.id) { _, _ in scrollAfterLayout(proxy) }
            .onChange(of: chat.turn.question != nil) { _, _ in scrollAfterLayout(proxy) }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && chat.running {
                    Button { scrollToEnd(proxy) } label: {
                        Label("Jump to latest", systemImage: "arrow.down").labelStyle(.iconOnly)
                            .font(.body.weight(.semibold)).frame(width: 44, height: 44)
                            .background(.regularMaterial, in: Circle())
                    }
                    .padding(16)
                    .transition(.opacity)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if flex == nil { bottomBar(chat) }
            }
            .frame(height: flex.map { CGFloat($0.top) })
          if let flex {
              // Nothing sits on the hinge.
              Color.clear.frame(height: CGFloat(flex.gap)).accessibilityHidden(true)
              ScrollView { bottomBar(chat) }
                  .scrollBounceBehavior(.basedOnSize)
                  .background(.bar)
                  .accessibilityIdentifier("chat.flexLower")
          }
         }
        }
        // Where this chat sits in the window, for the hinge (measured under the keyboard too).
        .background {
            GeometryReader { g in
                Color.clear.onChange(of: g.frame(in: .global), initial: true) { _, f in windowFrame = f }
            }
            .ignoresSafeArea(.keyboard)
        }
        // Text or a photo dragged from the other pane (or another app) goes into the message; nothing is sent.
        .dropDestination(for: PaneDrop.self) { items, _ in
            PaneDrop.accept(items, into: chat)
        } isTargeted: { dropping = $0 }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 14).strokeBorder(palette.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .padding(6).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .safeAreaInset(edge: .top) {
            if prefs.expertMode, let monitor {
                MonitorPanel(monitor: monitor, chat: chat).background(.bar)
            }
        }
        // Expert mode re-reads the hardware every few seconds, only while it's on and the chat is on screen.
        .task(id: prefs.expertMode) {
            guard prefs.expertMode else { return }
            let m = monitor ?? HardwareMonitorModel(store: store)
            monitor = m
            await m.follow()
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { ModeToggle() }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(chat.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text([chat.modelId, store.active?.name].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(palette.inkFaint).lineLimit(1)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // A saved copy is read-only: changing the chat needs the computer.
                    Group {
                        Button { showModels = true } label: { Label("Model", systemImage: "cpu") }
                        Menu {
                            ForEach(PcSettings.ChatMode.allCases, id: \.self) { m in
                                Button {
                                    act { try await chat.setOptions(mode: m) }
                                } label: {
                                    if chat.session?.mode == m.rawValue { Label(modeName(m), systemImage: "checkmark") } else { Text(modeName(m)) }
                                }
                            }
                        } label: { Label("Tool policy", systemImage: "shield.lefthalf.filled") }
                        if store.pcSettings.phoneChanges {
                            Button { showChanges = true } label: { Label("Changes", systemImage: "plusminus") }
                        }
                        Button { showGitScreen = true } label: { Label("Git", systemImage: "arrow.triangle.branch") }
                            .accessibilityIdentifier("chat.git")
                        Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                            .accessibilityIdentifier("chat.files")
                        Button { showGit = true } label: { Label("Commit or open a PR", systemImage: "arrow.triangle.pull") }
                        Button { showTerminals = true } label: { Label("Terminals", systemImage: "terminal") }
                            .accessibilityIdentifier("chat.terminals")
                        Button { renameText = chat.title; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                        Button { act { try await store.completeChat(sessionId) } } label: { Label("Complete", systemImage: "checkmark.circle") }
                    }
                    .disabled(chat.savedAt != nil)
                    Button { Task { await chat.reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (chat.session?.providerId, chat.modelId)) { p, m in
                act { try await chat.setOptions(providerId: p, modelId: m) }
            }
        }
        .sheet(isPresented: $showChanges) { ChangesView(chat: chat) }
        .sheet(isPresented: $showGit) { PrSheet(chat: chat, initial: []) }
        .sheet(isPresented: $showGitScreen) { GitView(chatId: sessionId) }
        .sheet(isPresented: $showTerminals) { TerminalsView(chatId: sessionId) }
        .sheet(isPresented: $showFiles) { FilesView(root: .chat(sessionId), title: chat.title) }
        .fullScreenCover(item: $viewing) { set in ImageViewer(photos: set.photos, index: set.index) }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { act { try await store.renameChat(sessionId, to: renameText); await chat.reload() } }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
    }

    /// The approval and question cards, the queue, the PR chip and the composer.
    private func bottomBar(_ chat: ChatModel) -> some View {
        VStack(spacing: 8) {
            if let a = chat.turn.approval {
                ApprovalCard(approval: a) { ok in try await chat.approve(ok) }.id(a.call.id)
            }
            if let q = chat.turn.question {
                // A new question starts with nothing picked.
                QuestionCard(request: q) { answers in try await chat.answer(answers) }.id(q.callId)
            }
            if !chat.queuedPrompts.isEmpty { QueueList(chat: chat) }
            PrChip(chat: chat).frame(maxWidth: .infinity, alignment: .leading)
            // The phone's saved copy (OF-5): read-only until the computer answers.
            if let at = chat.savedAt {
                Label(SavedListNote.copy(savedAt: at, computer: store.active?.name ?? "your computer"), systemImage: "clock.arrow.circlepath")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                    .accessibilityIdentifier("chat.savedCopy")
            }
            Composer(chat: chat)
        }
        .padding(.horizontal, 12).padding(.bottom, 8).padding(.top, 6)
        .background(.bar)
    }

    /// Tabletop: where the hinge cuts this chat, when the pane host passes one and it falls inside.
    private var flex: PaneFlex? {
        guard let h = paneHinge else { return nil }
        return PaneFlex(hingeMinY: Double(h.minY), hingeMaxY: Double(h.maxY),
                        frameMinY: Double(windowFrame.minY), frameHeight: Double(windowFrame.height))
    }

    /// Copy, and fork: a prompt comes back in a new chat to edit and send; a reply keeps the chat up to there.
    @ViewBuilder private func blockMenu(_ chat: ChatModel, _ b: Block) -> some View {
        if let text = b.copyText, !text.isEmpty {
            Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
        if chat.savedAt == nil, chat.forkPoint(b) != nil {
            Button {
                act {
                    let id = try await chat.fork(from: b)
                    app.openChat = id
                }
            } label: {
                Label(b.isPrompt ? "Edit in a new chat" : "Fork from here", systemImage: "arrow.triangle.branch")
            }
            .accessibilityIdentifier("chat.fork")
        }
    }

    private func scrollToEnd(_ proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private func scrollAfterLayout(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 80_000_000)
            scrollToEnd(proxy)
        }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do { try await body() } catch { actionError = error.localizedDescription }
        }
    }

    /// Send now on a waiting prompt: deliver at once, or dial the computer now rather than after the backoff.
    private func sendNow() {
        if store.conn == .online { store.flushOutbox() } else { store.reconnect() }
    }
}

/// A prompt in the outbox, shown where it will land in the transcript: it
/// goes when the computer is back. Edit puts it back in the message box.
struct WaitingRow: View {
    let item: OutboxItem
    let sending: Bool
    let online: Bool
    var edit: () -> Void
    var delete: () -> Void
    var sendNow: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                VStack(alignment: .trailing, spacing: 4) {
                    Text(item.preview).foregroundStyle(palette.ink).textSelection(.enabled)
                    if !item.images.isEmpty {
                        Label(item.images.count == 1 ? "1 photo" : "\(item.images.count) photos", systemImage: "photo")
                            .font(.caption2).foregroundStyle(palette.inkSoft)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(palette.line, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
                HStack(spacing: 6) {
                    if sending {
                        ProgressView().controlSize(.mini)
                        Text("Sending…")
                    } else {
                        Image(systemName: "clock").accessibilityHidden(true)
                        Text("Waiting to send")
                    }
                }
                .font(.caption2).foregroundStyle(palette.inkSoft)
                if let e = item.lastError, !sending {
                    Text(e).font(.caption2).foregroundStyle(palette.inkFaint).multilineTextAlignment(.trailing)
                }
                if !sending {
                    HStack(spacing: 2) {
                        action("Edit", palette.accent, edit)
                        action("Delete", palette.danger, delete)
                        action(online ? "Send now" : "Try now", palette.accent, sendNow)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Waiting to send: \(item.preview)")
        .accessibilityIdentifier("chat.waiting")
    }

    /// A text button with a full 44 pt target, in a colour that reads on the transcript.
    private func action(_ title: String, _ color: Color, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(color)
                .padding(.horizontal, 8)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

func modeName(_ m: PcSettings.ChatMode) -> String {
    switch m {
    case .ask: return String(localized: "Ask before every tool")
    case .guardrails: return String(localized: "Guardrails (ask for risky tools)")
    case .yolo: return String(localized: "YOLO (never ask)")
    }
}

/// The transcript's rows: each block on its own, except adjacent calls with one
/// purpose, which are one row that says the goal (spec/chat/tool-calls-grouped-by-purpose.md).
/// A run of delegations is the Delegate purpose, drawn as the subagent group.
enum TranscriptRow: Identifiable {
    case block(Block)
    case agents([Block])
    case purpose(ToolPurpose, [Block], [PurposeCall])

    var id: String {
        switch self {
        case .block(let b): return b.id
        case .agents(let blocks): return "agents-" + (blocks.first?.id ?? "")
        case .purpose(_, let blocks, _): return "purpose-" + (blocks.first?.id ?? "")
        }
    }

    static func of(_ blocks: [Block]) -> [TranscriptRow] {
        Purpose.group(blocks, role: Purpose.role(of:)).map { run in
            switch run {
            case .single(let b):
                return .block(b)
            case .group(let purpose, let items, let calls):
                let subagents = items.allSatisfy { b in
                    if case .tool(_, let name, _, _, _, _) = b { return name == AgentRows.subagentTool }
                    return false
                }
                return purpose == .delegate && subagents ? .agents(items) : .purpose(purpose, items, calls)
            }
        }
    }
}

struct BlockView: View {
    let block: Block
    /// The chat, for rows that read more than the block (watch chips, subagent children). Nil in previews.
    var chat: ChatModel? = nil
    /// A prompt's photos as the computer sent them (small copies; `""` for one it kept back).
    var photos: [String] = []
    var openPhoto: (Int) -> Void = { _ in }
    @Environment(\.palette) private var palette
    @State private var showReasoning = false

    var body: some View {
        switch block {
        case .user(_, let text, let at, let images):
            if images == 0, let wake = AgentRows.parseWake(text) {
                // A watch's wake-up is a step of the run, not something the user typed.
                WatchWakeRow(wake: wake, content: text, at: at)
            } else {
                HStack {
                    Spacer(minLength: 48)
                    VStack(alignment: .trailing, spacing: 4) {
                        // Markdown, as on the desktop (T101). No text selection here: touch and
                        // hold opens the menu (Copy, Edit in a new chat); a table keeps its own menu.
                        MarkdownText(text: text, bubble: true, selectable: false).foregroundStyle(palette.userInk)
                        if photos.contains(where: { !$0.isEmpty }) {
                            PhotoStrip(photos: photos, open: openPhoto)
                        } else if images > 0 {
                            Label(images == 1 ? "1 image" : "\(images) images", systemImage: "photo").font(.caption2).foregroundStyle(palette.userInk.opacity(0.8))
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 18))
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(images > 0 ? "You: \(text), with \(images == 1 ? "1 image" : "\(images) images")" : "You: \(text)")
            }
        case .assistant(_, let text, let reasoning, let streaming, let interrupted):
            VStack(alignment: .leading, spacing: 6) {
                if let reasoning, !reasoning.isEmpty {
                    DisclosureGroup(isExpanded: $showReasoning) {
                        Text(reasoning).font(.footnote).foregroundStyle(palette.inkSoft).textSelection(.enabled)
                    } label: {
                        Label(streaming && text.isEmpty ? "Thinking…" : "Thought", systemImage: "brain").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                }
                if !text.isEmpty {
                    if let chat {
                        // Links route to the preview window or Safari; linked files and pages get cards (#1095).
                        AssistantReply(text: text, streaming: streaming, sessionId: chat.sessionId)
                    } else {
                        MarkdownText(text: text).foregroundStyle(palette.ink)
                    }
                }
                if interrupted { Label("Interrupted", systemImage: "pause.circle").font(.caption).foregroundStyle(palette.warning) }
            }
        case .tool(_, let name, let label, let status, let output, let input):
            // The agent's work, drawn as the desktop draws it: no fill, no stroke, one line each.
            switch name {
            case AgentRows.watchTool:
                WatchRow(input: input, status: status, output: output, watches: chat?.watches ?? [])
            case AgentRows.subagentTool:
                if let chat { SubagentRow(input: input, status: status, output: output, chat: chat) } else { ToolRow(label: label, status: status, output: output) }
            default:
                ToolRow(label: label, status: status, output: output)
            }
        }
    }
}

/// The computer asks before running a tool: show exactly what, and why.
struct ApprovalCard: View {
    let approval: Approval
    var answer: (Bool) async throws -> Void
    @Environment(\.palette) private var palette
    @State private var busy = false
    @State private var failed: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Approve this tool?", systemImage: "hand.raised").font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Text(approval.severity.rawValue.capitalized).font(.caption2.weight(.bold)).padding(.horizontal, 7).padding(.vertical, 2)
                    .background(color.opacity(0.12), in: Capsule()).foregroundStyle(color)
            }
            Text(Transcript.toolLabel(approval.call)).font(.footnote.monospaced()).foregroundStyle(palette.ink).lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            if let detail { ScrollView { Text(detail).font(.caption.monospaced()).foregroundStyle(palette.inkSoft).textSelection(.enabled) }.frame(maxHeight: 120) }
            if !approval.reason.isEmpty { Text(approval.reason).font(.footnote).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true) }
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
            }
            HStack {
                Button(role: .destructive) { decide(false) } label: { Text("Deny").frame(maxWidth: .infinity).foregroundStyle(palette.ink) }
                    .buttonStyle(.bordered).tint(palette.inkSoft)
                // Drawn rather than .borderedProminent, which the audit reports as clipping its label.
                Button { decide(true) } label: {
                    Group { if busy { ProgressView().tint(palette.onAccent) } else { Text("Allow").font(.body.weight(.semibold)) } }
                        .foregroundStyle(palette.onAccent)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(palette.accent, in: RoundedRectangle(cornerRadius: 12))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
            .controlSize(.large)
            .disabled(busy)
        }
        .padding(14)
        // A card, because it needs you; tinted by its risk rather than outlined.
        .background { RoundedRectangle(cornerRadius: 16).fill(palette.surface).overlay(RoundedRectangle(cornerRadius: 16).fill(color.opacity(0.09))) }
        // The haptic comes from AppModel, per the user's vibration setting; VoiceOver gets told here.
        .onAppear { AccessibilityNotification.Announcement("Approval needed: \(Transcript.toolLabel(approval.call))").post() }
    }

    private func decide(_ ok: Bool) {
        busy = true
        failed = nil
        Task {
            do { try await answer(ok) } catch { failed = "Couldn’t send that: \(error.localizedDescription) Try again." }
            busy = false
        }
    }

    private var color: Color {
        switch approval.severity {
        case .high: return palette.danger
        case .medium: return palette.warning
        case .low: return palette.running
        }
    }

    /// The exact input when the label doesn't already show all of it.
    private var detail: String? {
        let input = approval.call.input
        guard !input.isEmpty else { return nil }
        if input.count == 1, let s = input.values.first?.string, Transcript.toolLabel(approval.call).hasSuffix(s) { return nil }
        return JSONValue.object(input).serialized()
    }
}

/// The agent's `ask_user` questions: options, multi-select, or "Something else" with a note.
struct QuestionCard: View {
    let request: AskRequest
    var submit: ([AskAnswer]) async throws -> Void
    @Environment(\.palette) private var palette
    @State private var picked: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]
    @State private var busy = false
    @State private var failed: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(request.questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if !q.header.isEmpty { Text(q.header).font(.caption.weight(.semibold)).foregroundStyle(palette.accent) }
                    Text(q.question).font(.subheadline).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                    FlowOptions(options: q.options.map(\.label) + [askOtherLabel], selected: picked[q.id] ?? []) { label in
                        var s = picked[q.id] ?? []
                        if q.multiSelect { if s.contains(label) { s.remove(label) } else { s.insert(label) } } else { s = [label] }
                        picked[q.id] = s
                    }
                    if picked[q.id]?.contains(askOtherLabel) == true {
                        TextField("Your answer", text: Binding(get: { notes[q.id] ?? "" }, set: { notes[q.id] = $0 }), axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
            }
            Button(action: send) {
                Group { if busy { ProgressView().tint(palette.onAccent) } else { Text("Answer") } }
                    .frame(maxWidth: .infinity).foregroundStyle(ready ? palette.onAccent : palette.inkFaint)
            }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!ready || busy)
        }
        .padding(14)
        .background { RoundedRectangle(cornerRadius: 16).fill(palette.surface).overlay(RoundedRectangle(cornerRadius: 16).fill(palette.accent.opacity(0.07))) }
    }

    private var ready: Bool { !request.questions.contains { (picked[$0.id] ?? []).isEmpty } }

    private func send() {
        let answers = request.questions.map { q in AskAnswer(questionId: q.id, labels: Array(picked[q.id] ?? []), note: notes[q.id]) }
        busy = true
        failed = nil
        Task {
            do { try await submit(answers) } catch { failed = "Couldn’t send that: \(error.localizedDescription) Try again." }
            busy = false
        }
    }
}

struct FlowOptions: View {
    let options: [String]
    let selected: Set<String>
    var tap: (String) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack { chips }
            VStack(alignment: .leading) { chips }
        }
    }

    private var chips: some View {
        ForEach(options, id: \.self) { o in
            let on = selected.contains(o)
            Button { tap(o) } label: {
                // A checkmark as well as the colour, and a 44 pt target.
                HStack(spacing: 5) {
                    if on { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
                    Text(o)
                }
                .font(.footnote).padding(.horizontal, 14).frame(minHeight: 44)
                .background(on ? palette.accent : palette.surface2, in: Capsule())
                .foregroundStyle(on ? palette.onAccent : palette.ink)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
        }
    }
}

/// The microphone in hold-to-talk mode (IO-28): records while pressed, stops
/// on release. VoiceOver can't hold, so its double-tap starts and the next one stops.
struct HoldToTalkButton: View {
    let dictation: Dictation
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var down = false

    var body: some View {
        Image(systemName: dictation.recording ? "waveform.circle.fill" : "mic.fill")
            .font(dictation.recording ? .title2 : .title3)
            .foregroundStyle(dictation.recording ? palette.danger : palette.inkSoft)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .scaleEffect(down ? 1.15 : 1)
            .animation(.easeOut(duration: 0.12), value: down)
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !down else { return }
                    down = true
                    Task { await dictation.press(store: store) }
                }
                .onEnded { _ in
                    down = false
                    Task { await dictation.letGo(store: store) }
                })
            .accessibilityElement()
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(dictation.recording ? "Stop dictation" : "Dictate")
            .accessibilityHint(dictation.recording ? "" : "Hold to talk, let go to stop")
            .accessibilityIdentifier("composer.holdToTalk")
            .accessibilityAction {
                Task {
                    if dictation.recording { await dictation.finish(store: store) } else { await dictation.start(store: store) }
                }
            }
    }
}

/// Text, the computer's skills (`/`), photos, dictation, Send / Stop.
struct Composer: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var text = ""
    @State private var skill: SkillSummary?
    /// A saved prompt from the computer, run with what's typed after it.
    @State private var prompt: SavedPrompt?
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var images: [String] = []
    @State private var loadingPhotos = false
    @State private var error: String?
    @State private var dictation = Dictation()
    @Environment(Prefs.self) private var prefs
    /// The message box has the keyboard (its formatting toolbar shows then).
    @State private var focused = false
    /// Why the computer turned down the prompt now in the box (it came back from the outbox).
    @State private var refusal: String?
    /// The draft as last saved from here: a different one in the store was handed back (Edit, a refusal).
    @State private var lastSaved: Draft?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let blocked = chat.blocked {
                Text(blocked).font(.caption).foregroundStyle(palette.warning)
            } else if let note = chat.offlineNote {
                // On its own surface: over the bar's translucent material its contrast depended on what scrolled behind.
                Label(note, systemImage: "tray.and.arrow.up").font(.caption).foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("chat.offlineNote")
            }
            if let refusal {
                HStack(alignment: .top, spacing: 6) {
                    Label(refusal, systemImage: "exclamationmark.bubble").font(.caption).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button { self.refusal = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .foregroundStyle(palette.inkSoft).accessibilityLabel("Dismiss")
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(palette.danger) }
            if let skill {
                HStack(spacing: 6) {
                    Label("/\(skill.name)", systemImage: "wand.and.stars").font(.caption.weight(.semibold))
                    Button { self.skill = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove skill")
                }
                .padding(.horizontal, 10).padding(.vertical, 4).background(palette.accent.opacity(0.15), in: Capsule()).foregroundStyle(palette.accent)
            }
            if let prompt {
                HStack(spacing: 6) {
                    Label("/\(prompt.name)", systemImage: "text.badge.star").font(.caption.weight(.semibold))
                    Button { self.prompt = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove saved prompt")
                }
                .padding(.horizontal, 10).padding(.vertical, 4).background(palette.accent.opacity(0.15), in: Capsule()).foregroundStyle(palette.accent)
                .accessibilityIdentifier("chat.savedPrompt")
            }
            if loadingPhotos {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Adding photos…").font(.caption)
                }.foregroundStyle(palette.inkSoft)
            } else if !images.isEmpty {
                HStack {
                    Label(images.count == 1 ? "1 photo" : "\(images.count) photos", systemImage: "photo").font(.caption)
                    Button { images = []; photos = [] } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove photos")
                }.foregroundStyle(palette.inkSoft)
            }
            if !skillMatches.isEmpty || !promptMatches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(promptMatches) { p in
                            Button {
                                // After existing text the prompt's text replaces the `/query`; alone it becomes the chip.
                                if SlashMenu.trigger(text)?.atStart == false {
                                    text = SlashMenu.textAfterPrompt(text, promptText: p.text(input: ""))
                                } else {
                                    prompt = p
                                    skill = nil
                                    text = ""
                                }
                            } label: {
                                slashChip("/\(p.name)", p.body, saved: true)
                            }.buttonStyle(.plain)
                        }
                        ForEach(skillMatches) { s in
                            Button {
                                skill = s
                                prompt = nil
                                text = SlashMenu.textAfterSkill(text)
                            } label: {
                                slashChip("/\(s.name)", s.description, saved: false)
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    if !store.pcSettings.prompts.isEmpty {
                        Menu {
                            ForEach(store.pcSettings.prompts) { p in Button("/\(p.name)") { prompt = p; skill = nil } }
                        } label: { Label("Saved prompts", systemImage: "text.badge.star") }
                    }
                    if !chat.skills.isEmpty {
                        Menu {
                            ForEach(chat.skills) { s in Button("/\(s.name)") { skill = s; prompt = nil } }
                        } label: { Label("Skills on \(store.active?.name ?? "computer")", systemImage: "wand.and.stars") }
                    }
                    // A PhotosPicker inside a Menu never opens its sheet: the menu closing dismisses it.
                    Button { pickingPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                    // Asked for by the user, so iOS shows its paste prompt only then.
                    Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                        .disabled(!UIPasteboard.general.hasImages)
                } label: {
                    Image(systemName: "plus.circle.fill").font(.title2).foregroundStyle(palette.inkSoft)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Add")
                // Markdown source with a formatting toolbar in the card (MD-3); VoiceOver's
                // "Hide keyboard" action is on the text view itself.
                MarkdownComposerField(text: $text, focused: $focused,
                                      placeholder: chat.running ? "Queue a follow-up" : "Message",
                                      onPasteImages: pasteImages)
                if dictation.transcribing {
                    ProgressView().frame(width: 44, height: 44).accessibilityLabel("Transcribing")
                } else if prefs.dictationHold && dictation.available && (text.isEmpty || dictation.recording) {
                    HoldToTalkButton(dictation: dictation)
                } else if dictation.available && text.isEmpty && !dictation.recording {
                    Button { Task { await dictation.start(store: store) } } label: {
                        Image(systemName: "mic.fill").font(.title3).foregroundStyle(palette.inkSoft)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Dictate")
                } else if dictation.recording {
                    Button { Task { await dictation.finish(store: store) } } label: {
                        Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(palette.danger)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Stop dictation")
                }
                // Stop while running with nothing to queue; a photo or skill alone can be queued.
                if chat.running && !hasContent {
                    Button { chat.abort() } label: {
                        Image(systemName: "stop.fill").font(.body.weight(.bold)).frame(width: 36, height: 36)
                            .background(palette.danger, in: Circle()).foregroundStyle(.white)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Stop")
                } else if chat.sendsLater {
                    // Offline: the prompt waits on this iPhone (the outbox) and goes when the computer is back.
                    Button(action: send) {
                        Text("Send when online").font(.footnote.weight(.semibold)).lineLimit(1)
                            .padding(.horizontal, 12).frame(minHeight: 36)
                            .background(canSend ? palette.accent : palette.surface2, in: Capsule())
                            .foregroundStyle(canSend ? palette.onAccent : palette.inkFaint)
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityIdentifier("chat.sendLater")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 36, height: 36)
                            .background(canSend ? palette.accent : palette.surface2, in: Circle())
                            .foregroundStyle(canSend ? palette.onAccent : palette.inkFaint)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(chat.running ? "Queue" : "Send")
                }
            }
            // The chat's model and effort, and its context window: in Simple and Expert alike.
            HStack(spacing: 0) {
                ModelEffortButton(chat: chat)
                Spacer(minLength: 8)
                ContextGauge(chat: chat)
            }
            .padding(.top, -4)
            if dictation.recording || dictation.transcribing { Text(dictation.status).font(.caption2).foregroundStyle(palette.inkFaint) }
            else if let n = dictation.notice { Text(n).font(.caption2).foregroundStyle(palette.inkSoft) }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 4, matching: .images)
        // Send waits for the photos (it used to send without them, and they came back later).
        .task(id: photos) {
            guard !photos.isEmpty else { return }
            loadingPhotos = true
            let loaded = await ImageAttachments.load(photos)
            if !Task.isCancelled { images = loaded }
            loadingPhotos = false
        }
        .onChange(of: dictation.error) { _, e in if let e { error = e } }
        // What is typed is kept on the phone (drafts survive leaving the chat and iOS ending the app).
        .onAppear(perform: restoreDraft)
        .onChange(of: text) { _, _ in saveDraft() }
        .onChange(of: skill) { _, _ in saveDraft() }
        .onChange(of: images) { _, _ in saveDraft() }
        .onChange(of: refusal) { _, _ in saveDraft() }
        // Edit on a waiting prompt, or a refusal: the prompt comes back into the box.
        .onChange(of: store.drafts.drafts[chat.sessionId]) { _, d in adopt(d) }
        // Tapped stop or hit the 30-second limit: the words go into the message, never sent.
        .onChange(of: dictation.result) { _, r in if let r { text += (text.isEmpty ? "" : " ") + r.text } }
        // "Ask about this" in Changes: the quote goes after what's typed, never sent.
        .onChange(of: chat.insert) { _, q in
            guard q != nil, let quote = chat.takeInsert() else { return }
            text += (text.isEmpty || text.hasSuffix("\n") ? "" : "\n\n") + quote
        }
        // A photo dropped on the chat (from the other pane): into the message, at most four, never sent.
        .onChange(of: chat.insertImages) { _, dropped in
            guard !dropped.isEmpty else { return }
            let taken = chat.takeImages()
            let room = max(0, 4 - images.count)
            images += taken.prefix(room)
            if taken.count > room { error = "A message takes four photos at most." }
        }
        // A prompt that never reached the computer comes back, with its skill and photos.
        .onChange(of: chat.unsent) { _, u in
            guard u != nil, let back = chat.takeUnsent() else { return }
            if text.isEmpty { text = back.text }
            if skill == nil { skill = back.skill }
            if images.isEmpty { images = back.images }
        }
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skill != nil || prompt != nil || !images.isEmpty
    }

    private func slashChip(_ name: String, _ detail: String, saved: Bool) -> some View {
        VStack(alignment: .leading) {
            Label(name, systemImage: saved ? "text.badge.star" : "wand.and.stars").font(.caption.weight(.semibold))
            if !detail.isEmpty { Text(detail).font(.caption2).lineLimit(1).foregroundStyle(palette.inkSoft) }
        }
        .padding(8).frame(minHeight: 44).frame(maxWidth: 200, alignment: .leading)
        .background(palette.surface2, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityHint(saved ? "A saved prompt from your computer" : "A skill on your computer")
    }

    /// `/fi` → the computer's saved prompts starting with "fi", at the start or after what's typed.
    private var promptMatches: [SavedPrompt] {
        guard skill == nil, prompt == nil, let q = SlashMenu.trigger(text)?.query.lowercased() else { return [] }
        return store.pcSettings.prompts.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }.prefix(6).map { $0 }
    }

    /// Images on the clipboard, scaled like picked photos (at most four in the message).
    private func pasteImages() {
        let pasted = UIPasteboard.general.images ?? []
        let room = max(0, 4 - images.count)
        let added = pasted.prefix(room).compactMap(ImageAttachments.encode)
        if added.isEmpty {
            error = "There’s no image on the clipboard."
            return
        }
        images += added
    }

    private var canSend: Bool { chat.blocked == nil && !loadingPhotos && hasContent }

    private var current: Draft { Draft(text: text, skill: skill, images: images, refusal: refusal) }

    private func restoreDraft() {
        let d = store.drafts.draft(chat.sessionId)
        lastSaved = d
        guard !d.isEmpty else { return }
        text = d.text
        skill = d.skill
        images = d.images
        refusal = d.refusal
    }

    private func saveDraft() {
        let d = current
        guard d != lastSaved else { return }
        lastSaved = d
        store.drafts.set(chat.sessionId, d)
    }

    /// A draft changed in the store, not from here: a waiting prompt taken back, or one refused.
    private func adopt(_ stored: Draft?) {
        let d = stored ?? Draft()
        guard d != lastSaved, !d.isEmpty else { return }
        lastSaved = d
        text = d.text
        skill = d.skill
        images = d.images
        refusal = d.refusal
    }

    /// `/re` → the computer's skills starting with "re", at the start or after what's typed.
    private var skillMatches: [SkillSummary] {
        guard skill == nil, prompt == nil, let q = SlashMenu.trigger(text)?.query.lowercased() else { return [] }
        return chat.skills.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }.prefix(8).map { $0 }
    }

    private func send() {
        var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var s = skill
        // "/name rest" typed out in full runs that skill.
        if s == nil, body.hasPrefix("/"), let space = body.firstIndex(of: " ") ?? Optional(body.endIndex) {
            let name = String(body[body.index(after: body.startIndex)..<space])
            if let match = chat.skills.first(where: { $0.name == name }) {
                s = match
                body = String(body[space...]).trimmingCharacters(in: .whitespaces)
            } else if prompt == nil, let saved = store.pcSettings.prompts.first(where: { $0.name == name }) {
                body = saved.text(input: String(body[space...]))
            }
        }
        // A saved prompt sends its text, then what was typed: an ordinary prompt the computer runs.
        if s == nil, let prompt { body = prompt.text(input: body) }
        let sentPrompt = prompt
        let sentImages = images
        let sentBody = body
        let sentSkill = s
        let saved = text
        text = ""
        skill = nil
        prompt = nil
        images = []
        photos = []
        error = nil
        refusal = nil
        // The prompt is on disk in the outbox from here until the computer lists it.
        store.drafts.clear(chat.sessionId)
        lastSaved = nil
        Task {
            do {
                try await chat.send(sentBody, skill: sentSkill, images: sentImages)
                Haptics.tap()
            } catch {
                self.error = error.localizedDescription
                text = saved
                skill = sentSkill
                prompt = sentPrompt
                images = sentImages
            }
        }
    }
}

enum ImageAttachments {
    /// Photos → JPEG data URLs the computer's vision models take, scaled so a
    /// few of them stay well under the relay's frame cap.
    static func load(_ items: [PhotosPickerItem]) async -> [String] {
        var out: [String] = []
        for item in items.prefix(4) {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                  let url = encode(image) else { continue }
            out.append(url)
        }
        return out
    }

    /// One image as a JPEG data URL, at most 1,600 px on its long side.
    static func encode(_ image: UIImage) -> String? {
        let maxSide: CGFloat = 1600
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        // Scale 1: `size` is in pixels. The default (the screen's 3x) made 4,800 px JPEGs.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}
