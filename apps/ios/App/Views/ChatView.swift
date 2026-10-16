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
    @State private var renaming = false
    @State private var renameText = ""
    @State private var actionError: String?

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
        .task(id: sessionId) {
            let c = ChatModel(sessionId: sessionId, store: store)
            chat = c
            c.start()
            app.notifier.clear(sessionId: sessionId)
        }
        .onDisappear { chat?.stop() }
        .onChange(of: store.conn) { _, s in chat?.connectionChanged(s) }
    }

    @ViewBuilder private func content(_ chat: ChatModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let n = chat.session?.omittedMessages, n > 0 {
                        Text("\(n) earlier messages are on \(store.active?.name ?? "your computer").")
                            .font(.footnote).foregroundStyle(palette.inkFaint).frame(maxWidth: .infinity)
                    }
                    if !chat.ready { ProgressView().frame(maxWidth: .infinity).padding(.top, 40) }
                    ForEach(chat.blocks) { b in BlockView(block: b).id(b.id) }
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
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: chat.blocks.last) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) } }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    if let a = chat.turn.approval {
                        ApprovalCard(approval: a) { ok in act { try await chat.approve(ok) } }
                    }
                    if let q = chat.turn.question {
                        QuestionCard(request: q) { answers in act { try await chat.answer(answers) } }
                    }
                    if !chat.queued.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(chat.queued.enumerated()), id: \.offset) { _, q in
                                Label(q, systemImage: "clock").font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(1)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
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
                    Button { renameText = chat.title; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                    Button { act { try await store.completeChat(sessionId) } } label: { Label("Complete", systemImage: "checkmark.circle") }
                    Button { Task { await chat.reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .sheet(isPresented: $showModels) {
            ModelPicker(selected: (chat.session?.providerId, chat.modelId)) { p, m in
                act { try await chat.setOptions(providerId: p, modelId: m) }
            }
        }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { act { try await store.renameChat(sessionId, to: renameText); await chat.reload() } }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do { try await body() } catch { actionError = error.localizedDescription }
        }
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
                        Text(label).font(.footnote.monospaced()).foregroundStyle(palette.inkSoft).lineLimit(expanded ? nil : 1)
                        Spacer(minLength: 0)
                        if output != nil { Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(palette.inkFaint) }
                    }
                }
                .buttonStyle(.plain)
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
    var answer: (Bool) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Approve this tool?", systemImage: "hand.raised").font(.subheadline.weight(.semibold))
                Spacer()
                Text(approval.severity.rawValue.capitalized).font(.caption2.weight(.bold)).padding(.horizontal, 7).padding(.vertical, 2)
                    .background(color.opacity(0.18), in: Capsule()).foregroundStyle(color)
            }
            Text(Transcript.toolLabel(approval.call)).font(.footnote.monospaced()).foregroundStyle(palette.ink).lineLimit(4)
            if let detail { ScrollView { Text(detail).font(.caption.monospaced()).foregroundStyle(palette.inkSoft).textSelection(.enabled) }.frame(maxHeight: 120) }
            if !approval.reason.isEmpty { Text(approval.reason).font(.footnote).foregroundStyle(palette.inkSoft) }
            HStack {
                Button(role: .destructive) { answer(false) } label: { Text("Deny").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                Button { answer(true) } label: { Text("Allow").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(color.opacity(0.5)))
        .onAppear { Haptics.needsYou() }
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
    var submit: ([AskAnswer]) -> Void
    @Environment(\.palette) private var palette
    @State private var picked: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(request.questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if !q.header.isEmpty { Text(q.header).font(.caption.weight(.semibold)).foregroundStyle(palette.accent) }
                    Text(q.question).font(.subheadline).foregroundStyle(palette.ink)
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
            Button {
                submit(request.questions.map { q in AskAnswer(questionId: q.id, labels: Array(picked[q.id] ?? []), note: notes[q.id]) })
            } label: { Text("Answer").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .disabled(request.questions.contains { (picked[$0.id] ?? []).isEmpty })
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.accent.opacity(0.4)))
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
            Button { tap(o) } label: {
                Text(o).font(.footnote).padding(.horizontal, 12).padding(.vertical, 7)
                    .background(selected.contains(o) ? palette.accent : palette.surface2, in: Capsule())
                    .foregroundStyle(selected.contains(o) ? palette.onAccent : palette.ink)
            }.buttonStyle(.plain)
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
    @State private var error: String?
    @State private var dictation = Dictation()
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let blocked = chat.blocked {
                Text(blocked).font(.caption).foregroundStyle(palette.warning)
            }
            if let error { Text(error).font(.caption).foregroundStyle(palette.danger) }
            if let skill {
                HStack(spacing: 6) {
                    Label("/\(skill.name)", systemImage: "wand.and.stars").font(.caption.weight(.semibold))
                    Button { self.skill = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Remove skill")
                }
                .padding(.horizontal, 10).padding(.vertical, 4).background(palette.accent.opacity(0.15), in: Capsule()).foregroundStyle(palette.accent)
            }
            if !images.isEmpty {
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
                }
                .accessibilityLabel("Add")
                TextField(chat.turn.running ? "Queue a follow-up" : "Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(palette.line))
                if dictation.available && text.isEmpty && !dictation.recording {
                    Button { Task { await dictation.start(store: store) } } label: {
                        Image(systemName: "mic.fill").font(.title3).foregroundStyle(palette.inkSoft)
                    }.accessibilityLabel("Dictate")
                } else if dictation.recording {
                    Button { Task { if let t = await dictation.stop(store: store) { text += (text.isEmpty ? "" : " ") + t } } } label: {
                        Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(palette.danger)
                    }.accessibilityLabel("Stop dictation")
                }
                if chat.turn.running && text.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button { chat.abort() } label: {
                        Image(systemName: "stop.fill").font(.body.weight(.bold)).frame(width: 36, height: 36)
                            .background(palette.danger, in: Circle()).foregroundStyle(.white)
                    }.accessibilityLabel("Stop")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 36, height: 36)
                            .background(canSend ? palette.accent : palette.surface2, in: Circle())
                            .foregroundStyle(canSend ? palette.onAccent : palette.inkFaint)
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(chat.turn.running ? "Queue" : "Send")
                }
            }
            if dictation.recording { Text(dictation.status).font(.caption2).foregroundStyle(palette.inkFaint) }
        }
        .onChange(of: photos) { _, items in Task { images = await ImageAttachments.load(items) } }
        .onChange(of: dictation.error) { _, e in if let e { error = e } }
    }

    private var canSend: Bool {
        chat.blocked == nil && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || skill != nil || !images.isEmpty)
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
        Task {
            do {
                try await chat.send(sentBody, skill: sentSkill, images: sentImages)
                Haptics.tap()
            } catch {
                self.error = error.localizedDescription
                text = saved
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
            let resized = UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { continue }
            out.append("data:image/jpeg;base64," + jpeg.base64EncodedString())
        }
        return out
    }
}
