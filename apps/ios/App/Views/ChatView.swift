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
    /// Whether the end of the transcript is on screen: only then does it follow new output.
    @State private var atBottom = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let chat {
                content(chat)
            } else {
                ProgressView()
            }
        }
        .background(palette.paper)
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
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
                do { try await chat.send(first) } catch {
                    chat.handBack(UnsentPrompt(text: first, skill: nil, images: []))
                    actionError = error.localizedDescription
                }
            }
        }
        .onDisappear { chat?.stop() }
        .onChange(of: store.conn) { _, s in chat?.connectionChanged(s) }
    }

    @ViewBuilder private func content(_ chat: ChatModel) -> some View {
        ScrollViewReader { proxy in
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
                    ForEach(chat.blocks) { b in BlockView(block: b).id(b.id) }
                    // Prompts written here that the computer doesn't have yet.
                    ForEach(chat.waiting) { item in
                        WaitingRow(item: item, sending: store.outbox.sendingId == item.id, online: store.conn == .online,
                                   edit: { _ = store.outbox.takeBack(item.id) },
                                   delete: { _ = store.outbox.remove(item.id) },
                                   sendNow: { sendNow() })
                            .id("waiting-\(item.id)")
                    }
                    if chat.turn.running && chat.turn.approval == nil && chat.turn.question == nil {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(chat.turn.blocks.isEmpty ? "Working…" : "Working on \(store.active?.name ?? "your computer")…")
                                .font(.footnote).foregroundStyle(palette.inkSoft)
                        }.id("working")
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
                VStack(spacing: 8) {
                    if let a = chat.turn.approval {
                        ApprovalCard(approval: a) { ok in try await chat.approve(ok) }.id(a.call.id)
                    }
                    if let q = chat.turn.question {
                        // A new question starts with nothing picked.
                        QuestionCard(request: q) { answers in try await chat.answer(answers) }.id(q.callId)
                    }
                    if !chat.queued.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(chat.queued.enumerated()), id: \.offset) { _, q in
                                Label(q, systemImage: "clock").font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(1)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                    }
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
        }
        .toolbar {
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
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { act { try await store.renameChat(sessionId, to: renameText); await chat.reload() } }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
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
    case .ask: return "Ask before every tool"
    case .guardrails: return "Guardrails (ask for risky tools)"
    case .yolo: return "YOLO (never ask)"
    }
}

struct BlockView: View {
    let block: Block
    @Environment(\.palette) private var palette
    @State private var expanded = false
    @State private var showReasoning = false

    var body: some View {
        switch block {
        case .user(_, let text, _, let images):
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(text).foregroundStyle(palette.userInk).textSelection(.enabled)
                    if images > 0 {
                        Label(images == 1 ? "1 image" : "\(images) images", systemImage: "photo").font(.caption2).foregroundStyle(palette.userInk.opacity(0.8))
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 18))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(images > 0 ? "You: \(text), with \(images == 1 ? "1 image" : "\(images) images")" : "You: \(text)")
        case .assistant(_, let text, let reasoning, let streaming, let interrupted):
            VStack(alignment: .leading, spacing: 6) {
                if let reasoning, !reasoning.isEmpty {
                    DisclosureGroup(isExpanded: $showReasoning) {
                        Text(reasoning).font(.footnote).foregroundStyle(palette.inkSoft).textSelection(.enabled)
                    } label: {
                        Label(streaming && text.isEmpty ? "Thinking…" : "Thought", systemImage: "brain").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                }
                if !text.isEmpty { MarkdownText(text: text).foregroundStyle(palette.ink) }
                if interrupted { Label("Interrupted", systemImage: "pause.circle").font(.caption).foregroundStyle(palette.warning) }
            }
        case .tool(_, _, let label, let status, let output):
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    if output != nil { withAnimation(.snappy) { expanded.toggle() } }
                } label: {
                    HStack(spacing: 8) {
                        statusIcon(status)
                        // Two lines collapsed: one line truncated even short commands by a fraction of a point.
                        Text(label).font(.footnote.monospaced()).foregroundStyle(palette.inkSoft).lineLimit(expanded ? nil : 2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        if output != nil { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(palette.inkFaint) }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(label), \(statusName(status))")
                .accessibilityValue(output == nil ? "" : (expanded ? "Output shown" : "Output hidden"))
                .accessibilityHint(output == nil ? "" : "Shows or hides the output")
                if expanded, let output {
                    let split = Transcript.splitNotes(output)
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(split.0.isEmpty ? "(no output)" : split.0).font(.caption.monospaced()).foregroundStyle(palette.ink)
                            .textSelection(.enabled).fixedSize(horizontal: true, vertical: false).padding(10)
                    }
                    .frame(maxHeight: 280)
                    .background(palette.code, in: RoundedRectangle(cornerRadius: 8))
                    ForEach(split.1, id: \.self) { Text($0).font(.caption2).foregroundStyle(palette.inkFaint) }
                }
            }
            .padding(10)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
            .accessibilityElement(children: .combine)
        }
    }

    private func statusName(_ s: ToolStatus) -> String {
        switch s {
        case .running: return "running"
        case .waiting: return "waiting for you"
        case .ok: return "done"
        case .error: return "failed"
        }
    }

    @ViewBuilder private func statusIcon(_ s: ToolStatus) -> some View {
        switch s {
        case .running: ProgressView().controlSize(.mini)
        case .waiting: Image(systemName: "hand.raised.fill").foregroundStyle(palette.warning)
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(palette.success)
        case .error: Image(systemName: "xmark.octagon.fill").foregroundStyle(palette.danger)
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
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(color.opacity(0.5)))
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
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.accent.opacity(0.4)))
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
    @State private var photos: [PhotosPickerItem] = []
    @State private var images: [String] = []
    @State private var loadingPhotos = false
    @State private var error: String?
    @State private var dictation = Dictation()
    @Environment(Prefs.self) private var prefs
    @FocusState private var focused: Bool
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
            if !skillMatches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(skillMatches) { s in
                            Button {
                                skill = s
                                text = ""
                            } label: {
                                VStack(alignment: .leading) {
                                    Text("/\(s.name)").font(.caption.weight(.semibold))
                                    if !s.description.isEmpty { Text(s.description).font(.caption2).lineLimit(1).foregroundStyle(palette.inkSoft) }
                                }.padding(8).frame(maxWidth: 200, alignment: .leading)
                                    .background(palette.surface2, in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    if !chat.skills.isEmpty {
                        Menu {
                            ForEach(chat.skills) { s in Button("/\(s.name)") { skill = s } }
                        } label: { Label("Skills on \(store.active?.name ?? "computer")", systemImage: "wand.and.stars") }
                    }
                    PhotosPicker(selection: $photos, maxSelectionCount: 4, matching: .images) {
                        Label("Photos", systemImage: "photo.on.rectangle")
                    }
                } label: {
                    Image(systemName: "plus.circle.fill").font(.title2).foregroundStyle(palette.inkSoft)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Add")
                TextField(chat.running ? "Queue a follow-up" : "Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .accessibilityIdentifier("chat.message")
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(palette.line))
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
            if dictation.recording || dictation.transcribing { Text(dictation.status).font(.caption2).foregroundStyle(palette.inkFaint) }
            else if let n = dictation.notice { Text(n).font(.caption2).foregroundStyle(palette.inkSoft) }
        }
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
        // A prompt that never reached the computer comes back, with its skill and photos.
        .onChange(of: chat.unsent) { _, u in
            guard u != nil, let back = chat.takeUnsent() else { return }
            if text.isEmpty { text = back.text }
            if skill == nil { skill = back.skill }
            if images.isEmpty { images = back.images }
        }
    }

    private var hasContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skill != nil || !images.isEmpty
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

    /// `/re` → the computer's skills starting with "re".
    private var skillMatches: [SkillSummary] {
        guard skill == nil, text.hasPrefix("/"), !text.contains(" ") else { return [] }
        let q = text.dropFirst().lowercased()
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
            }
        }
        let sentImages = images
        let sentBody = body
        let sentSkill = s
        let saved = text
        text = ""
        skill = nil
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
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { continue }
            let maxSide: CGFloat = 1600
            let scale = min(1, maxSide / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            // Scale 1: `size` is in pixels. The default (the screen's 3x) made 4,800 px JPEGs.
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { continue }
            out.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
        return out
    }
}
