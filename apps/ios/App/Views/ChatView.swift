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
    @Environment(\.displayScale) private var displayScale
    @State private var chat: ChatModel?
    @State private var showModels = false
    @State private var showChanges = false
    @State private var showAudit = false
    @State private var changedFiles = 0
    @State private var renaming = false
    @State private var renameText = ""
    @State private var actionError: String?
    /// A switch of this chat to YOLO, waiting on the warning.
    @State private var yoloAsk: YoloAsk?
    /// The waiting call whose "Always allow this tool" a notification or the Live
    /// Activity asked for (`AppModel.alwaysAllowIn`): its card runs it once.
    @State private var alwaysNow: String?
    @State private var showGit = false
    @State private var showGitScreen = false
    @State private var showTerminals = false
    @State private var showFiles = false
    /// The photos open full screen.
    @State private var viewing: PhotoSet?
    /// Whether the end of the transcript is on screen: only then does it follow new output.
    @State private var atBottom = true
    /// The `blocksLayout` the transcript last followed: a new one means rows were added or replaced.
    @State private var followedLayout = -1
    /// The pending scroll to the end once new rows are laid out (see `settleAtEnd`).
    @State private var settling: Task<Void, Never>?
    @State private var pull = PawPull()
    /// The transcript's rows between renders (a streamed token patches only the last one).
    @State private var rowCache = TranscriptRowCache()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(Prefs.self) private var prefs
    /// Expert mode's hardware and loaded models, read while the chat is on screen.
    @State private var monitor: HardwareMonitorModel?
    /// The pill opened into the agent's details.
    @State private var showPanel = false
    /// The pill scrolled away.
    @State private var pillHidden = false
    /// Simple: the turns whose folded steps were opened here (not saved).
    @State private var openSteps: Set<String> = []
    /// Tabletop (FD-6): the hinge in window points, from the pane host; nil elsewhere.
    @Environment(\.paneHinge) private var paneHinge
    /// In the pane host: messages can be dragged to the other pane.
    @Environment(\.inPanes) private var inPanes
    /// This chat's frame in the window, to place the hinge.
    @State private var windowFrame: CGRect = .zero
    /// Something is being dragged over the chat.
    @State private var dropping = false
    /// The GitHub star ask under the reply that reached 10 (then 50) prompts, until the next send or a choice.
    @State private var starAsk = false

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
        .task(id: sessionId) {
            // Coming back to the same chat (a pushed screen popped) keeps the
            // model and what has streamed so far; start() re-subscribes and re-reads.
            // A chat on another computer makes that computer active first, over the
            // link the phone already holds to it, so the model talks to the right one.
            store.focus(chat: sessionId)
            if chat?.sessionId != sessionId {
                chat?.stop()
                starAsk = false
                chat = ChatModel(sessionId: sessionId, store: store)
            }
            chat?.start()
            app.notifier.clear(sessionId: sessionId)
            if let first = app.firstMessages.removeValue(forKey: sessionId), let chat {
                await chat.reload()
                do {
                    try await chat.send(first.text, images: first.images)
                    if chat.isImageChat && store.drafts.draft(sessionId).text == first.text { store.drafts.clear(sessionId) }
                } catch {
                    chat.handBack(first)
                    actionError = error.localizedDescription
                }
            }
        }
        .onDisappear { chat?.stop() }
        .onChange(of: store.conn) { _, s in chat?.connectionChanged(s) }
    }

    /// The room the transcript leaves at its top for the pill in its standard place.
    private var pillRoom: CGFloat { AgentPillLayer.room(prefs.pillPlacement, gauges: gauges) }

    /// The readings the floating pill shows, while the hardware shows; no pill otherwise.
    private var gauges: HardwareMonitorModel? {
        prefs.shows("hardware", localModelLoaded: monitor?.localModelLoaded ?? false) ? monitor : nil
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
            // Round inward in window coordinates: a fractional viewport origin
            // must not let Text's pixel rounding consume the 16pt gutters.
            let bounds = geo.frame(in: .global)
            let left = ceil((bounds.minX + 16) * displayScale) / displayScale
            let right = floor((bounds.maxX - 16) * displayScale) / displayScale
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let n = chat.session?.omittedMessages, n > 0 {
                        Text("\(n) earlier messages are on \(store.active?.name ?? "your computer").")
                            .font(.footnote).foregroundStyle(palette.inkFaint).frame(maxWidth: .infinity)
                    }
                    if !chat.ready { ProgressView().frame(maxWidth: .infinity).padding(.top, 40) }
                    // Simple folds each turn's reasoning and tool steps to one line, unless chosen in Settings.
                    let rows = rowCache.rows(chat)
                    let footers = chat.turnDetails
                    let items = prefs.shows("thinking") ? TranscriptRow.detailed(rows, footers: footers)
                        : TranscriptRow.folded(rows, open: openSteps, running: chat.turn.running, footers: footers)
                    ForEach(items) { item in
                        switch item {
                        case .details(let details):
                            TurnDetailsView(details: details)
                        case .summary(let turn, let steps, let thought, let running):
                            StepsSummaryRow(text: StepFold.summary(steps: steps, thought: thought, running: running),
                                            open: openSteps.contains(turn)) {
                                if openSteps.contains(turn) { openSteps.remove(turn) } else { openSteps.insert(turn) }
                            }
                            .id("steps-\(turn)")
                        case .row(let row, let reasoning):
                        switch row {
                        case .block(let b):
                            BlockView(block: b, chat: chat, voice: rowCache.voices[b.id], photos: chat.photos(b.id), reasoning: reasoning,
                                      openPhoto: { i in viewing = PhotoSet(photos: chat.photos(b.id), index: i, messageId: b.id) },
                                      editPicture: chat.canEdit(b.id) ? { i in editPicture(chat, b.id, i) } : nil)
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
                    }
                    ForEach(chat.responseMessages) { message in
                        ResponseMessageRow(message: message,
                            retry: { chat.retryResponse(message.id) }, cancel: { chat.cancelResponse(message.id) })
                            .id("response-\(message.id)")
                    }
                    // Prompts written here that the computer doesn't have yet.
                    ForEach(chat.waiting) { item in
                        WaitingRow(item: item, sending: store.outbox.sendingId == item.id, online: store.conn == .online,
                                   edit: { _ = store.outbox.takeBack(item.id) },
                                   delete: { _ = store.outbox.remove(item.id) },
                                   sendNow: { sendNow() })
                            .id("waiting-\(item.id)")
                    }
                    if chat.turn.running && chat.turn.approval == nil && chat.turn.question == nil && chat.turn.secret == nil {
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
                    // Under the reply, never over a question, an approval, a failure or a saved copy.
                    if starAsk && !chat.running && chat.turn.approval == nil && chat.turn.question == nil && chat.turn.secret == nil && chat.error == nil && chat.savedAt == nil {
                        GitHubStarAsk(stop: { prefs.stopStarAsk() }, close: { withAnimation(.easeOut(duration: 0.16)) { starAsk = false } })
                            .id("starAsk")
                            .transition(.opacity)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { if #unavailable(iOS 18.0) { atBottom = true } }
                        .onDisappear { if #unavailable(iOS 18.0) { atBottom = false } }
                }
                // A vertical ScrollView must propose the viewport's exact column
                // width. Text's pixel-rounded ideal width can otherwise grow it
                // by a fraction of a point at accessibility sizes.
                .frame(width: max(0, right - left), alignment: .leading)
                .padding(.leading, left - bounds.minX)
                .padding(.trailing, bounds.maxX - right)
                .padding(.vertical, 12)
                .frame(minHeight: max(0, geo.size.height - pillRoom), alignment: .bottom)
            }
            .accessibilityIdentifier("chat.transcript")
            #if DEBUG
            .modifier(TurnDetailsMeasureFrame(name: "transcript"))
            #endif
            .pawRefreshableFromEnd(pull) {
                await chat.reload()
                guard !Task.isCancelled else { return }
                // The gesture starts at the end; retain it after the new transcript lays out.
                scrollAfterLayout(proxy)
            }
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { hideKeyboard() })
            .defaultScrollAnchor(.bottom)
             .modifier(TranscriptFollow(atBottom: $atBottom,
                 readerScrolled: { settling?.cancel() }))
            .contentMargins(.top, pillRoom, for: .scrollContent)
            .hidesPillOnScroll($pillHidden)
          }
            // The bar has no background to hide what scrolls behind it: stop the transcript at the
            // bar's top edge, and leave the top open so it still runs under the navigation glass.
            .clipShape(Rectangle().scale(x: 1, y: 2, anchor: .bottom))
            // Follow streamed output only while the reader is at the end, and
            // without animating every token (overlapping animations shudder).
            // Rows added or replaced (the transcript arriving, a re-read, a new step)
            // also scroll again once laid out: the lazy stack leaves the screen blank
            // when it jumps to rows it has not built yet, until the reader scrolls.
            .onChange(of: chat.blocksRevision) { _, _ in
                let layoutChanged = chat.blocksLayout != followedLayout
                followedLayout = chat.blocksLayout
                guard atBottom else { return }
                // iOS 18+ follows laid-out height, not every token. New lazy rows still settle.
                if #unavailable(iOS 18.0) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                    if layoutChanged { settleAtEnd(proxy) }
                }
            }
            // A chat that opens with its transcript already there (the saved copy) settles too.
            .onAppear {
                guard atBottom, followedLayout != chat.blocksLayout, !chat.blocks.isEmpty else { return }
                followedLayout = chat.blocksLayout
                settleAtEnd(proxy)
            }
            .onDisappear { settling?.cancel() }
            // An approval or question card grows the bottom bar: keep the latest step above it.
            // After the card has been laid out: scrolling in the same update used the old inset.
            .onChange(of: chat.turn.approval?.call.id) { _, _ in scrollAfterLayout(proxy) }
            .onChange(of: chat.turn.question != nil) { _, _ in scrollAfterLayout(proxy) }
            .onChange(of: chat.turn.secret != nil) { _, _ in scrollAfterLayout(proxy) }
            // A prompt sent from here got its reply: it counts, and the 10th and 50th carry the star ask.
            .onChange(of: chat.promptReplies) { old, new in
                guard new > old, prefs.starAskAfterReply() else { return }
                withAnimation(.easeOut(duration: 0.2)) { starAsk = true }
                if atBottom { scrollAfterLayout(proxy) }
            }
            // The next send takes it away; unanswered, it was Not now.
            .onChange(of: chat.promptsSent) { _, _ in starAsk = false }
            .overlay(alignment: .bottomTrailing) {
                // Fades in and out (a fade, so also with Reduce Motion) rather than popping:
                // `atBottom` changes outside any animation, as the end scrolls in or out of view.
                ZStack {
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
                .animation(.smooth(duration: 0.2), value: !atBottom && chat.running)
            }
            // The minimal monitor while the hardware shows, floating over the
            // transcript; tapped, it opens into the agent's details.
            .agentPill(gauges: gauges, monitor: monitor, chat: chat, hidden: pillHidden, expanded: $showPanel)
            .safeAreaInset(edge: .bottom) {
                if flex == nil { bottomBar(chat) }
            }
            .frame(height: flex.map { CGFloat($0.top) })
          if let flex {
              // Nothing sits on the hinge.
              Color.clear.frame(height: CGFloat(flex.gap)).accessibilityHidden(true)
              ScrollView { bottomBar(chat) }
                  .scrollBounceBehavior(.basedOnSize)
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
        .modifier(MonitorFollow(monitor: $monitor, panelOpen: showPanel))
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    ChatMascot(working: chat.running, pull: pull, refresh: {
                        Task { await pull.reload { await chat.reload() } }
                    })
                    VStack(alignment: .leading, spacing: 0) {
                        Text(chat.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                        if prefs.shows("ph-subtitle") {
                            Text([chat.modelId, store.active?.name].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption2).foregroundStyle(palette.inkFaint).lineLimit(1)
                        }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // Simple or Detailed is this phone's own, so it works on a saved copy too.
                    ModeMenuPicker()
                    // A saved copy is read-only: changing the chat needs the computer.
                    Group {
                        if chat.isImageChat || ModelEffortButton.parts(prefs, chat).model {
                            Button { showModels = true } label: { Label(chat.isImageChat ? "Image settings" : "Model", systemImage: chat.isImageChat ? "photo.badge.plus" : "cpu") }
                        }
                        // Simple shows this under the message box, in plain words.
                        if !chat.isImageChat && prefs.expertMode && prefs.shows("asks") {
                            Menu {
                                ForEach(PcSettings.ChatMode.allCases, id: \.self) { m in
                                    Button {
                                        let current = chat.session?.mode.flatMap(PcSettings.ChatMode.init(rawValue:)) ?? store.pcSettings.effectiveMode
                                        yoloAsk = prefs.gateYolo(from: current, to: m) { act { try await chat.setOptions(mode: m) } }
                                    } label: {
                                        Label {
                                            Text(modeName(m))
                                            if chat.session?.mode == m.rawValue { Image(systemName: "checkmark") }
                                        } icon: { ToolPolicyPicker.image(m) }
                                    }
                                }
                            } label: { Label("Tool policy", systemImage: "shield.lefthalf.filled") }
                        }
                        if store.pcSettings.phoneChanges && prefs.shows("changes", changes: changedFiles > 0) {
                            Button { showChanges = true } label: { Label(SimpleMode.filesChanged(changedFiles), systemImage: "plusminus") }
                        }
                        if prefs.shows("ph-git") {
                            Button { showGitScreen = true } label: { Label("Git", systemImage: "arrow.triangle.branch") }
                                .accessibilityIdentifier("chat.git")
                        }
                        Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
                            .accessibilityIdentifier("chat.files")
                        if prefs.shows("ph-git") {
                            Button { showGit = true } label: { Label("Commit or open a PR", systemImage: "arrow.triangle.pull") }
                        }
                        if prefs.shows("terminal") {
                            Button { showTerminals = true } label: { Label("Terminals", systemImage: "terminal") }
                                .accessibilityIdentifier("chat.terminals")
                        }
                        // Who allowed what in this chat: read only, value-free.
                        Button { showAudit = true } label: { Label("Audit trail", systemImage: "checkmark.shield") }
                            .accessibilityIdentifier("chat.audit")
                        Button { renameText = chat.title; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                        Button { act { try await store.completeChat(sessionId) } } label: { Label("Complete", systemImage: "checkmark.circle") }
                    }
                    .disabled(chat.savedAt != nil)
                    Button { Task { await pull.reload { await chat.reload() } } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                } label: { Label("More", systemImage: "ellipsis.circle") }
                .accessibilityIdentifier("chat.more")
            }
        }
        .sheet(isPresented: $showModels) {
            if chat.isImageChat { ImageChatSettingsSheet(chat: chat) }
            else {
                ModelPicker(selected: (chat.session?.providerId, chat.modelId)) { p, m in
                    act { try await chat.setOptions(providerId: p, modelId: m) }
                }
            }
        }
        .sheet(isPresented: $showChanges) { ChangesView(chat: chat) }
        .sheet(isPresented: $showAudit) {
            AuditTrailView(load: { try await chat.auditTrail() }, incognito: chat.session?.runOptions["incognito"]?.bool == true)
        }
        // Read with the chat and after each turn: Changes shows only with something in it.
        .task(id: chat.session?.updatedAt) {
            guard store.pcSettings.phoneChanges, let c = try? await chat.changes() else { return }
            changedFiles = c.files.count + c.omittedFiles
        }
        .sheet(isPresented: $showGit) { PrSheet(chat: chat, initial: []) }
        .sheet(isPresented: $showGitScreen) { GitView(chatId: sessionId) }
        .sheet(isPresented: $showTerminals) { TerminalsView(chatId: sessionId) }
        .sheet(isPresented: $showFiles) { FilesView(root: .chat(sessionId), title: chat.title) }
        .fullScreenCover(item: $viewing) { set in
            ImageViewer(photos: set.photos, index: set.index, load: set.messageId.map { id -> (Int) async throws -> String? in { i in try await chat.fullPhoto(id, i) } })
        }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { act { try await store.renameChat(sessionId, to: renameText); await chat.reload() } }
        }
        .alert("Couldn’t do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(actionError ?? "") }
        .yoloWarning($yoloAsk)
        // "Always allow this tool" from a notification or the Live Activity: taken once the
        // app is unlocked and this chat's card shows that very call.
        .onChange(of: app.alwaysAllowIn, initial: true) { _, _ in takeAlwaysAllow(chat) }
        .onChange(of: app.lock.locked) { _, _ in takeAlwaysAllow(chat) }
        .onChange(of: chat.turn.approval?.call.id) { _, _ in takeAlwaysAllow(chat) }
    }

    private func takeAlwaysAllow(_ chat: ChatModel) {
        guard let a = chat.turn.approval, ChatModel.offersAlwaysAllow(a.call),
              app.takeAlwaysAllow(chat.sessionId, callId: a.call.id) else { return }
        alwaysNow = a.call.id
    }

    /// The approval and question cards, the queue, the PR chip and the composer.
    private func bottomBar(_ chat: ChatModel) -> some View {
        VStack(spacing: 8) {
            if let a = chat.responseApproval {
                ApprovalCard(approval: a, answer: { ok in try await chat.approve(ok) },
                             alwaysAllow: ChatModel.offersAlwaysAllow(a.call) ? { try await chat.alwaysAllowTool() } : nil,
                             startAlways: alwaysNow == a.call.id, startedAlways: { alwaysNow = nil })
                    .id(a.call.id)
            }
            if let q = chat.responseQuestion {
                // A new question starts with nothing picked.
                QuestionCard(request: q) { answers in try await chat.answer(answers) }.id(q.callId)
            }
            if let s = chat.turn.secret { SecretCard(request: s).id(s.callId) }
            if !chat.queuedPrompts.isEmpty { QueueList(chat: chat) }
            if prefs.shows("pr-status", pr: true) { PrChip(chat: chat).frame(maxWidth: .infinity, alignment: .leading) }
            // The phone's saved copy (OF-5): read-only until the computer answers.
            if let at = chat.savedAt {
                Label(SavedListNote.copy(savedAt: at, computer: store.active?.name ?? "your computer"), systemImage: "clock.arrow.circlepath")
                    .font(.footnote).foregroundStyle(palette.inkSoft)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
                    .accessibilityIdentifier("chat.savedCopy")
            }
            Composer(chat: chat, openTerminals: { showTerminals = true }, openFiles: { showFiles = true })
        }
        .padding(.horizontal, 12).padding(.bottom, 8).padding(.top, 6)
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
        if chat.savedAt == nil, !b.id.hasPrefix("ask-answer:"), chat.forkPoint(b) != nil {
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
        atBottom = true
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    /// Scroll to the end again after the new rows are laid out, then once more when the
    /// lazy stack has measured the rows it estimated: scrolling to an id makes it build
    /// the rows there, which a jump inside the same update did not. Coalesced and never
    /// animated. Not gated on `atBottom` again: the unbuilt end can read as scrolled away.
    /// It is over in under 0.2 s, before a reader's own scroll gets going.
    private func settleAtEnd(_ proxy: ScrollViewProxy) {
        settling?.cancel()
        settling = Task { @MainActor in
            for wait in [30, 150] {
                try? await Task.sleep(for: .milliseconds(wait))
                guard !Task.isCancelled else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
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

    /// Edit under a made picture: it goes into the message box as a photo to edit
    /// (as large as the computer sends it, scaled as the desktop does), never sent by itself.
    private func editPicture(_ chat: ChatModel, _ messageId: String, _ index: Int) {
        act {
            let picture = try await chat.pictureToEdit(messageId, index)
            guard let photo = ImageAttachments.forEdit(picture) else { throw RelayError(String(localized: "That picture couldn’t be read.")) }
            chat.attach(images: [photo])
            Haptics.tap()
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
    SimpleMode.asksName(m)
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

    /// Simple's transcript: each turn's tool steps and reasoning folded behind one
    /// summary line at the first of them, unless the turn is in `open`. The
    /// last turn is the running one while `running`.
    static func folded(_ rows: [TranscriptRow], open: Set<String>, running: Bool = false, footers: [String: TurnDetails] = [:]) -> [FoldItem] {
        // Turns start at each prompt; rows before the first one are turn "start".
        var turnOf: [Int] = []
        var turnIds: [String] = ["start"]
        for row in rows {
            if case .block(let b) = row, b.isPrompt, !row.isWake { turnIds.append(b.id) }
            turnOf.append(turnIds.count - 1)
        }
        var steps = Array(repeating: 0, count: turnIds.count)
        var thought = Array(repeating: false, count: turnIds.count)
        var first = Array(repeating: Int?.none, count: turnIds.count)
        for (i, row) in rows.enumerated() {
            let t = turnOf[i]
            if row.isStep {
                steps[t] += row.stepCount
                if first[t] == nil { first[t] = i }
            } else if case .block(.assistant(_, _, let r, _, _)) = row, let r, !r.isEmpty {
                thought[t] = true
                if first[t] == nil { first[t] = i }
            }
        }
        var out: [FoldItem] = []
        for (i, row) in rows.enumerated() {
            let t = turnOf[i]
            let isOpen = open.contains(turnIds[t])
            if first[t] == i {
                out.append(.summary(turn: turnIds[t], steps: steps[t], thought: thought[t], running: running && t == turnIds.count - 1))
            }
            if !row.isStep || isOpen { out.append(.row(row, reasoning: isOpen)) }
            // End-of-turn details stay visible even when Simple folds the tool-only turn.
            out += row.footerItems(footers)
        }
        return out
    }

    /// How many tool calls a step row holds.
    var stepCount: Int {
        switch self {
        case .block(.tool): return 1
        case .block: return isWake ? 1 : 0
        case .agents(let blocks), .purpose(_, let blocks, _): return blocks.count
        }
    }

    /// A tool step or a group of them, which Simple mode keeps out of sight (`thinking`).
    var isStep: Bool {
        switch self {
        case .block(.tool): return true
        case .block: return isWake
        case .agents, .purpose: return true
        }
    }

    /// A watch's wake-up arrives as a user block, but it is a step of the run, not a new prompt.
    var isWake: Bool {
        if case .block(.user(_, let text, _, 0)) = self { return AgentRows.parseWake(text) != nil }
        return false
    }

    static func detailed(_ rows: [TranscriptRow], footers: [String: TurnDetails]) -> [FoldItem] {
        rows.flatMap { [.row($0, reasoning: true)] + $0.footerItems(footers) }
    }

    private func footerItems(_ footers: [String: TurnDetails]) -> [FoldItem] {
        let blocks: [Block]
        switch self {
        case .block(let b): blocks = [b]
        case .agents(let bs), .purpose(_, let bs, _): blocks = bs
        }
        return blocks.compactMap { footers[$0.id].map { .details($0) } }
    }

    static func of(_ blocks: [Block], footers: [String: TurnDetails] = [:]) -> [TranscriptRow] {
        // A turn footer ends a purpose group. Otherwise two tool-only replies
        // with the same purpose could put both footers under the second reply.
        var out: [TranscriptRow] = []
        var chunk: [Block] = []
        for b in blocks {
            chunk.append(b)
            if footers[b.id] != nil {
                out += grouped(chunk)
                chunk = []
            }
        }
        return out + grouped(chunk)
    }

    private static func grouped(_ blocks: [Block]) -> [TranscriptRow] {
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

/// `TranscriptRow.of`, kept between renders. While a reply streams, each token
/// changes only the chat's last block (`ChatModel.blocksLayout` stays put), so
/// only the last row is replaced instead of grouping the whole transcript again.
/// A plain class in `@State`: reading it in `body` is memoization, not state.
@MainActor
final class TranscriptRowCache {
    private var chat: ObjectIdentifier?
    private var layout = -1
    private var rows: [TranscriptRow] = []
    private var running = false
    /// How each reply reads in its turn (spec/chat/thinking-and-replies.md), as of the last `rows`.
    private(set) var voices: [String: Voice] = [:]

    func rows(_ chat: ChatModel) -> [TranscriptRow] {
        let blocks = chat.blocks
        // A streaming reply has no voice yet, so growing it changes none.
        if ObjectIdentifier(chat) == self.chat, chat.blocksLayout == layout, chat.turn.running == running, let last = blocks.last,
           case .block(let shown)? = rows.last, shown.id == last.id, Self.breaker(shown), Self.breaker(last),
           Self.streaming(shown), Self.streaming(last) {
            rows[rows.count - 1] = .block(last)
            return rows
        }
        self.chat = ObjectIdentifier(chat)
        layout = chat.blocksLayout
        running = chat.turn.running
        rows = TranscriptRow.of(blocks, footers: chat.turnDetails)
        voices = Dictionary(zip(blocks.map(\.id), ReplyTopics.voices(blocks, running: running)).compactMap { id, v in v.map { (id, $0) } }) { a, _ in a }
        return rows
    }

    private static func streaming(_ b: Block) -> Bool {
        if case .assistant(_, _, _, let streaming, _) = b { return streaming }
        return false
    }

    /// A reply with text ends any purpose group (`Purpose.role`): its own row
    /// whatever the text grows to. A reply still blank (reasoning only) may not be.
    private static func breaker(_ b: Block) -> Bool {
        if case .assistant(_, let text, _, _, _) = b { return text.contains { !$0.isWhitespace } }
        return false
    }
}

struct BlockView: View {
    let block: Block
    /// The chat, for rows that read more than the block (watch chips, subagent children). Nil in previews.
    var chat: ChatModel? = nil
    /// How a reply reads in its turn: a note, something left for the reader, or the reply.
    var voice: Voice? = nil
    /// A prompt's photos as the computer sent them (small copies; `""` for one it kept back).
    var photos: [String] = []
    /// Simple mode hides what the model thought (`thinking`).
    var reasoning = true
    var openPhoto: (Int) -> Void = { _ in }
    /// An image chat's made picture: Edit puts picture `i` in the message box. Nil: no Edit (a clip, or no picture).
    var editPicture: ((Int) -> Void)? = nil
    @Environment(\.palette) private var palette
    @State private var showReasoning = false
    @State private var showProgress = false
    @State private var showContext = false

    var body: some View {
        switch block {
        case .user(_, let text, let at, let images):
            if images == 0, let wake = AgentRows.parseWake(text) {
                // A watch's wake-up is a step of the run, not something the user typed.
                WatchWakeRow(wake: wake, content: text, at: at)
            } else if images == 0, let context = ConversationContext.parts(text) {
                DisclosureGroup(isExpanded: $showContext) {
                    MarkdownText(text: context.summary).textSelection(.enabled)
                } label: {
                    Label("Conversation summary", systemImage: "text.alignleft")
                        .font(.footnote).foregroundStyle(palette.inkSoft)
                        .frame(minHeight: 44)
                }
                .accessibilityIdentifier("chat.contextSummary")
                if let prompt = context.prompt, !prompt.isEmpty {
                    MarkdownText(text: prompt, bubble: true, selectable: false)
                        .foregroundStyle(palette.userInk)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .background(palette.userBubble, in: RoundedRectangle(cornerRadius: 18))
                }
            } else {
                HStack {
                    Spacer(minLength: 48)
                    VStack(alignment: .trailing, spacing: 4) {
                        // Markdown, as on the desktop (T101). No text selection here: touch and
                        // hold opens the menu (Copy, Edit in a new chat); a table keeps its own menu.
                        if block.id.hasPrefix("ask-answer:") {
                            Text(text).foregroundStyle(palette.userInk)
                        } else {
                            MarkdownText(text: text, bubble: true, selectable: false).foregroundStyle(palette.userInk)
                        }
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
                if self.reasoning, let reasoning, !reasoning.isEmpty {
                    DisclosureGroup(isExpanded: $showReasoning) {
                        Text(reasoning).font(.footnote).foregroundStyle(palette.inkSoft).textSelection(.enabled)
                    } label: {
                        Label(streaming && text.isEmpty ? "Thinking…" : "Thought", systemImage: "brain").font(.footnote).foregroundStyle(palette.inkFaint)
                    }
                }
                if !text.isEmpty {
                    if voice == .working {
                        DisclosureGroup(isExpanded: $showProgress) {
                            replyText(text, streaming: streaming)
                        } label: {
                            Label("Progress note", systemImage: "brain")
                                .font(.footnote).foregroundStyle(palette.inkSoft)
                                .frame(minHeight: 44)
                        }
                        .accessibilityIdentifier("chat.progressNote")
                    } else {
                        replyText(text, streaming: streaming)
                            .modifier(Voiced(voice: voice))
                    }
                }
                if !photos.isEmpty {
                    if photos.contains(where: { !$0.isEmpty }) {
                        PhotoStrip(photos: photos, open: openPhoto)
                        if let editPicture { EditPictureButtons(count: photos.count, edit: editPicture) }
                    } else { Label("Image unavailable in this copy", systemImage: "photo") }
                } else if let count = chat?.session?.messages.first(where: { $0.id == block.id })?.imageCount, count > 0 {
                    Label("Reconnect to view generated images", systemImage: "photo")
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

    @ViewBuilder
    private func replyText(_ text: String, streaming: Bool) -> some View {
        if let chat {
            AssistantReply(text: text, streaming: streaming, sessionId: chat.sessionId, voice: voice)
        } else {
            MarkdownText(text: text, topics: true, askTail: voice == .reply || voice == .attention)
                .foregroundStyle(voice == .working ? palette.inkSoft : palette.ink)
        }
    }
}

/// Who a reply's text is for (spec/chat/thinking-and-replies.md). A note is
/// quiet with the thought icon; a reply, or anything left for the reader
/// mid-turn, sits on a panel. The icon and the panel's edge live in the
/// transcript's 16pt side padding, so a block that settles its voice keeps its
/// width and does not re-wrap.
private struct Voiced: ViewModifier {
    let voice: Voice?
    @Environment(\.palette) private var palette

    func body(content: Content) -> some View {
        switch voice {
        case .working?:
            content.overlay(alignment: .topLeading) {
                Image(systemName: "brain").font(.system(size: 9)).foregroundStyle(palette.inkFaint)
                    .frame(width: 12).offset(x: -14, y: 6).accessibilityHidden(true)
            }
        case .reply?, .attention?:
            let tone = voice == .reply ? palette.accent : palette.warning
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(tone.opacity(0.08))
                .overlay(alignment: .leading) { tone.frame(width: 2) }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, -10)
        case nil:
            content
        }
    }
}

/// The computer asks before running a tool: show exactly what, and why.
struct ApprovalCard: View {
    let approval: Approval
    var answer: (Bool) async throws -> Void
    /// "Always allow this tool", offered for MCP tools only (decision 0054): saves the
    /// tool for this chat, then allows the call. Never switches the chat to YOLO.
    var alwaysAllow: (() async throws -> Void)? = nil
    /// Run "Always allow this tool" once, as if tapped: asked for from a notification
    /// or the Live Activity. A refusal or failure shows on this card, nothing allowed.
    var startAlways = false
    var startedAlways: () -> Void = {}
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
                    .buttonStyle(.bordered).tint(palette.inkSoft).buttonBorderShape(.roundedRectangle(radius: 8))
                // Drawn rather than .borderedProminent, which the audit reports as clipping its label.
                Button { decide(true) } label: {
                    Group { if busy { ProgressView().tint(palette.onAccent) } else { Text("Allow").font(.body.weight(.semibold)) } }
                        .foregroundStyle(palette.onAccent)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(palette.accent, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
            .controlSize(.large)
            .disabled(busy)
            if alwaysAllow != nil {
                // Its own full-width row, so a long translation wraps instead of squeezing Deny and Allow.
                Button { decide(true, always: true) } label: {
                    Text("Always allow this tool").font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(palette.accent)
                        .padding(.vertical, 8).padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(RoundedRectangle(cornerRadius: 8).stroke(palette.accent.opacity(0.6)))
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityHint("Allows this call and stops asking for this tool in this chat. Other tools still ask.")
                .accessibilityIdentifier("approval.alwaysAllow")
            }
        }
        .padding(14)
        // A card, because it needs you; tinted by its risk rather than outlined.
        .background { RoundedRectangle(cornerRadius: 12).fill(palette.surface).overlay(RoundedRectangle(cornerRadius: 12).fill(color.opacity(0.09))) }
        // The haptic comes from AppModel, per the user's vibration setting; VoiceOver gets told here.
        .onAppear { AccessibilityNotification.Announcement("Approval needed: \(Transcript.toolLabel(approval.call))").post() }
        .task(id: startAlways) {
            guard startAlways, alwaysAllow != nil, !busy else { return }
            startedAlways()
            decide(true, always: true)
        }
    }

    private func decide(_ ok: Bool, always: Bool = false) {
        busy = true
        failed = nil
        Task {
            do {
                if always, let alwaysAllow { try await alwaysAllow() } else { try await answer(ok) }
            } catch { failed = "Couldn’t send that: \(error.localizedDescription) Try again." }
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

/// The agent asked for a secret (`request_secret`, #2594). Same words and order as the
/// computer's secret box: a lock, the variable name, the agent's reason. The value is
/// entered on the computer only: `chat:provideSecret` is not a phone channel, so this
/// card has no field, nothing to send and nothing to keep.
struct SecretCard: View {
    let request: SecretRequest
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill").font(.subheadline).foregroundStyle(palette.inkSoft)
                .padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(request.name).font(.system(.subheadline, design: .monospaced).weight(.medium))
                    .foregroundStyle(palette.ink).lineLimit(1).truncationMode(.middle)
                if !request.reason.isEmpty {
                    Text(request.reason).font(.caption).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
                }
                Text("Enter this on your computer").font(.footnote).foregroundStyle(palette.inkSoft)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("The agent needs \(request.name). Enter this on your computer.")
        .accessibilityIdentifier("chat.secretCard")
    }
}

/// The agent's `ask_user` questions: options, multi-select, or "Something else" with a note.
struct QuestionCard: View {
    let request: AskRequest
    var submit: ([AskAnswer]) async throws -> Void
    @Environment(\.palette) private var palette
    @State private var step = 0
    @State private var picked: [String: Set<String>] = [:]
    @State private var notes: [String: String] = [:]
    @State private var busy = false
    @State private var failed: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button { step = max(0, step - 1); failed = nil } label: {
                    Image(systemName: "chevron.left").font(.footnote)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel("Previous question").disabled(step == 0 || busy)
                Spacer()
                Text("\(step + 1) of \(request.questions.count)").font(.caption).foregroundStyle(palette.inkSoft)
                Spacer()
                Button {
                    guard let q = current else { return }
                    picked[q.id] = nil; notes[q.id] = nil
                    advance()
                } label: {
                    Text("Skip").font(.footnote).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(busy)
            }
            if let q = current {
                VStack(alignment: .leading, spacing: 6) {
                    if !q.header.isEmpty { Text(q.header).font(.caption.weight(.semibold)).foregroundStyle(palette.accent) }
                    Text(q.question).font(.subheadline).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
                    FlowOptions(options: q.options.map(\.label) + [askOtherLabel], selected: picked[q.id] ?? []) { label in
                        var s = picked[q.id] ?? []
                        if q.multiSelect { if s.contains(label) { s.remove(label) } else { s.insert(label) } } else { s = [label] }
                        picked[q.id] = s
                    }
                    if picked[q.id]?.contains(askOtherLabel) == true {
                        TextField("Your answer", text: Binding(get: { notes[q.id] ?? "" }, set: { notes[q.id] = $0 }),
                                  prompt: Text("Your answer").foregroundStyle(palette.inkFaint), axis: .vertical)
                            .font(.subheadline).foregroundStyle(palette.ink)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                    }
                }.disabled(busy)
            }
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
            }
            Button(action: advance) {
                Group { if busy { ProgressView().tint(palette.onAccent) } else { Text(step == request.questions.count - 1 ? "Send answers" : "Next").font(.footnote.weight(.semibold)) } }
                    .foregroundStyle(ready ? palette.onAccent : palette.inkFaint)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(ready ? palette.accent : palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
                .buttonStyle(.plain)
                .disabled(!ready || busy)
        }
        .padding(14)
        // The message box's own surface and edge, so the two read as one panel.
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
    }

    private var current: AskQuestion? { request.questions.indices.contains(step) ? request.questions[step] : nil }
    private var ready: Bool {
        guard let q = current else { return false }
        return !(picked[q.id] ?? []).subtracting([askOtherLabel]).isEmpty || !(notes[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private func advance() {
        guard !busy else { return }
        if step < request.questions.count - 1 { step += 1; failed = nil } else { send() }
    }
    private func send() {
        guard !busy else { return }
        let answers = request.questions.compactMap { q -> AskAnswer? in
            let labels = q.options.map(\.label).filter { (picked[q.id] ?? []).contains($0) }
            let note = (notes[q.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return labels.isEmpty && note.isEmpty ? nil : AskAnswer(questionId: q.id, labels: labels, note: note.isEmpty ? nil : note)
        }
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
            VStack(alignment: .leading, spacing: 0) { chips }
        }
    }

    private var chips: some View {
        ForEach(options, id: \.self) { o in
            let on = selected.contains(o)
            Button { tap(o) } label: {
                // A checkmark as well as the colour, and a 44 pt target around the slim chip.
                HStack(spacing: 5) {
                    if on { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
                    Text(o)
                }
                .font(.footnote).padding(.horizontal, 12).frame(minHeight: 36)
                .background(on ? palette.accent : palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(on ? palette.onAccent : palette.ink)
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
        }
    }
}

/// Text, the computer's skills (`/`), photos, dictation, Send / Stop, with + and Send inside the box.
struct Composer: View {
    let chat: ChatModel
    /// + → Terminal: the chat's terminals sheet.
    var openTerminals: () -> Void = {}
    /// The folder after + → Files: the chat's files sheet.
    var openFiles: () -> Void = {}
    @Environment(AppModel.self) private var app
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
    /// "Nekko, ..." commands in what is dictated, and the words for the message box.
    @State private var voice = VoiceRunner()
    /// The first tap of the mic shows the how-voice-works video instead of listening.
    @State private var intro = VoiceIntroGate()
    @Environment(\.scenePhase) private var phase
    @Environment(Prefs.self) private var prefs
    /// The message box has the keyboard (its formatting toolbar shows then).
    @State private var focused = false
    /// Why the computer turned down the prompt now in the box (it came back from the outbox).
    @State private var refusal: String?
    /// The draft as last saved from here: a different one in the store was handed back (Edit, a refusal).
    @State private var lastSaved: Draft?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // With the other next steps, above the box. A skill or saved prompt is a slash command, not work to place.
            if !chat.isImageChat, skill == nil, prompt == nil, chat.offersSubagent(text) { workPlace }
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
            // Simple: a long chat suggests starting fresh, with what that saves.
            if !prefs.expertMode, !prefs.longChatDismissed.contains(chat.sessionId),
               let saving = SimpleMode.longChatSaving(longChatContext, used: chat.contextTokens) {
                LongChatNote(tokens: saving, startFresh: startFresh, dismiss: { prefs.dismissLongChat(chat.sessionId) })
            }
            // Voice and dictation say what they heard above the box, with the other notes.
            if let pending = voice.pending { voicePending(pending) }
            if let said = voice.notice {
                Text(said.text).font(.caption2).foregroundStyle(palette.inkSoft).accessibilityIdentifier("composer.voiceNotice")
            }
            if dictation.recording || dictation.transcribing { Text(dictation.status).font(.caption2).foregroundStyle(palette.inkFaint) }
            else if let n = dictation.notice { Text(n).font(.caption2).foregroundStyle(palette.inkSoft) }
            // The agent's plan, tucked behind the box's top edge (drawn first, so the box covers its foot).
            if !PlanSheet.plan(chat, store).isEmpty {
                PlanSheet(chat: chat).padding(.bottom, -(PlanSheet.tuck + 6))
            }
            // One box the width of the screen: the message on top, + and Send below it, then model and context.
            VStack(alignment: .leading, spacing: 0) {
                if loadingPhotos {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Adding photos…").font(.caption)
                    }
                    .foregroundStyle(palette.inkSoft)
                    .padding(.horizontal, 12).padding(.top, 10)
                }
                if !images.isEmpty {
                    ComposerPhotos(photos: images) { index in
                        images.remove(at: index)
                        photos = []
                    }
                    .padding(.horizontal, 12).padding(.top, 10)
                }
                // Markdown source with a formatting toolbar in the card (MD-3); VoiceOver's
                // "Hide keyboard" action is on the text view itself.
                MarkdownComposerField(text: $text, focused: $focused,
                                      placeholder: chat.isImageChat ? (images.isEmpty ? "Describe an image to generate" : "Describe the change") : chat.running ? "Queue a follow-up" : "Message",
                                      onPasteImages: pasteImages, boxed: false)
                    .padding(.horizontal, 12).padding(.top, 10)
                HStack(alignment: .center, spacing: 4) {
                    Menu {
                        // As on the desktop: another agent or a terminal beside this one, or a photo for this message.
                        Button { app.newChatRequested = true } label: { Label("New agent", systemImage: "plus.bubble") }
                            .accessibilityIdentifier("composer.newAgent")
                        if prefs.shows("terminal") {
                            Button(action: openTerminals) { Label("Terminal", systemImage: "terminal") }
                                .disabled(chat.savedAt != nil)
                                .accessibilityIdentifier("composer.terminal")
                        }
                        Divider()
                        if !store.pcSettings.prompts.isEmpty {
                            Menu {
                                ForEach(store.pcSettings.prompts) { p in Button("/\(p.name)") { prompt = p; skill = nil } }
                            } label: { Label("Saved prompts", systemImage: "text.badge.star") }
                        }
                        if !chat.isImageChat && !chat.skills.isEmpty {
                            Menu {
                                ForEach(chat.skills) { s in Button("/\(s.name)") { skill = s; prompt = nil } }
                            } label: { Label("Skills on \(store.active?.name ?? "computer")", systemImage: "wand.and.stars") }
                        }
                        // A PhotosPicker inside a Menu never opens its sheet: the menu closing dismisses it.
                        Button { pickingPhotos = true } label: {
                            Label(chat.isImageChat ? "Photos to edit" : "Photos", systemImage: "photo.on.rectangle")
                        }
                        // Asked for by the user, so iOS shows its paste prompt only then.
                        Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
                            .disabled(!UIPasteboard.general.hasImages)
                    } label: {
                        ComposerGlyph(name: "plus").foregroundStyle(palette.inkSoft)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Add")
                    .accessibilityIdentifier("composer.add")
                    // The desktop composer's order (#2448): +, the folder, then Simple's asks-first icon; mic and Send at the right.
                    ComposerFolderMenu(chat: chat, openFiles: openFiles)
                    if !chat.isImageChat && !prefs.expertMode && prefs.shows("asks") { AsksFirstMenu(chat: chat, iconOnly: true) }
                    Spacer(minLength: 0)
                    // Listening (tap mode) keeps its stop button while earlier segments are transcribed.
                    if dictation.recording && !prefs.dictationHold {
                        Button { dictation.stopListening() } label: {
                            Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(palette.danger)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .accessibilityLabel("Stop dictation")
                        .accessibilityIdentifier("composer.stopDictation")
                    } else if dictation.starting && !prefs.dictationHold {
                        // Permissions or the computer are being asked; a second tap would open a second microphone.
                        ProgressView().frame(width: 44, height: 44).accessibilityLabel("Starting dictation")
                            .accessibilityIdentifier("composer.dictationStarting")
                    } else if dictation.transcribing {
                        ProgressView().frame(width: 44, height: 44).accessibilityLabel("Transcribing")
                    } else {
                        // One mic: the voice conversation. Dictation into the box is the keyboard's own mic.
                        VoiceConversationButton(makeTarget: {
                            guard let id = store.activeId else { throw RelayError("Choose a computer first.") }
                            return .computer(chat, computerId: id)
                        })
                        .disabled(chat.isImageChat || chat.savedAt != nil || chat.sendsLater)
                    }
                    // Stop while running with nothing to queue; a photo or skill alone can be queued.
                    if chat.running && (!hasContent || chat.isImageChat) {
                        Button { chat.abort() } label: {
                            Image(systemName: "stop.fill").font(.body.weight(.bold)).frame(width: 36, height: 36)
                                .background(palette.danger, in: Circle()).foregroundStyle(.white)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }.accessibilityLabel("Stop")
                    } else if chat.sendsLater {
                        // Offline: the prompt waits on this iPhone (the outbox) and goes when the computer is back.
                        Button { send() } label: {
                            Text("Send when online").font(.footnote.weight(.semibold)).lineLimit(1)
                                .padding(.horizontal, 12).frame(minHeight: 36)
                                .background(canSend ? palette.accent : palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                                .foregroundStyle(canSend ? palette.onAccent : palette.inkFaint)
                                .frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                        .accessibilityIdentifier("chat.sendLater")
                    } else {
                        Button { send() } label: {
                            Image(systemName: "arrow.up").font(.body.weight(.bold)).frame(width: 36, height: 36)
                                .background(canSend ? palette.accent : palette.surface2, in: Circle())
                                .foregroundStyle(canSend ? palette.onAccent : palette.inkFaint)
                                .frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .disabled(!canSend)
                        .accessibilityLabel(chat.running ? "Queue" : "Send")
                    }
                }
                .padding(.horizontal, 4)
                // The chat's model and effort, and its context window: the box's bottom row, as Settings > Simple mode says.
                // Nothing sits below the box (#1599).
                let parts = ModelEffortButton.parts(prefs, chat)
                if parts.model || parts.effort || prefs.shows("context") {
                    HStack(spacing: 0) {
                        if parts.model || parts.effort { ModelEffortButton(chat: chat) }
                        // Expert keeps it beside the model with its name, as the desktop's details row does.
                        // It gives way first on a narrow phone, so the context gauge keeps its width.
                        if !chat.isImageChat && prefs.expertMode && prefs.shows("asks") { AsksFirstMenu(chat: chat).layoutPriority(-1) }
                        Spacer(minLength: 8)
                        if prefs.shows("context") { ContextGauge(chat: chat) }
                    }
                    .padding(.horizontal, 4).padding(.top, -6)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 4, matching: .images)
        // Send waits for the photos (it used to send without them, and they came back later).
        .task(id: photos) {
            guard !photos.isEmpty else { return }
            loadingPhotos = true
            let loaded = await ImageAttachments.load(photos, toEdit: chat.isImageChat)
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
        .onAppear(perform: bindVoice)
        // The Live Activity's mic on iOS 17 opens this chat listening (tap mode only: a hold needs
        // a finger), once the app is unlocked and the chat list has this chat.
        .onChange(of: app.listenIn, initial: true) { _, _ in takeListen() }
        .onChange(of: app.lock.locked) { _, _ in takeListen() }
        .onChange(of: store.summariesLoaded) { _, _ in takeListen() }
        .sheet(isPresented: $intro.showing, onDismiss: {
            // Turn on is the one way out that listens: in hold mode there is no hold to start from.
            intro.closed(prefs) { if !prefs.dictationHold { Task { await dictation.startListening(store: store) } } }
        }) { VoiceIntroView(onTurnOn: intro.turnOn) }
        .onChange(of: dictation.recording) { _, on in
            if on { return voice.started() }
            let afterHold = dictation.released
            Task { await voice.stopped(afterHold: afterHold, after: dictation.drain) }
        }
        // Listening never outlives the screen: lock, app switch, or leaving the chat stops it, and it never restarts by itself.
        .onChange(of: phase) { _, p in if Dictation.leavesScreen(p, starting: dictation.starting) { dictation.abort() } }
        .onDisappear(perform: unbindVoice)
        .task(id: voice.notice) {
            guard let said = voice.notice else { return }
            try? await Task.sleep(for: .seconds(4))
            voice.clearNotice(said.id)
        }
        // "Ask about this" in Changes: the quote goes after what's typed, never sent.
        .onChange(of: chat.insert) { _, q in
            guard q != nil, let quote = chat.takeInsert() else { return }
            text += (text.isEmpty || text.hasSuffix("\n") ? "" : "\n\n") + quote
        }
        // A photo dropped on the chat (from the other pane): into the message, at most four, never sent.
        .onChange(of: chat.insertImages) { _, dropped in
            guard !dropped.isEmpty else { return }
            // In an image chat they are photos to edit: sized as the desktop sizes them.
            let taken = chat.isImageChat ? chat.takeImages().compactMap(ImageAttachments.forEdit) : chat.takeImages()
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

    /// More work for a chat that has replied: run it here, or hand it to a subagent.
    private var workPlace: some View {
        let here = Button { send() } label: { outlined("Do it here") }.accessibilityIdentifier("composer.doItHere")
        let subagent = Button { send(wrap: Session.inSubagent) } label: { outlined("In a subagent") }.accessibilityIdentifier("composer.inSubagent")
        let cost = Text("Here uses more context").font(.caption).foregroundStyle(palette.ink)
        // Side by side when it fits; a large text size or a long translation puts the note below.
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { here; subagent; cost }
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) { here; subagent }
                cost
            }
        }
        .buttonStyle(.plain).disabled(!canSend)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// An outlined action, as the desktop's: accent words on the surface, a 44 pt target.
    private func outlined(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(canSend ? palette.accent : palette.inkFaint)
            .padding(.horizontal, 12).frame(minHeight: 34)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.line))
            .frame(minHeight: 44).contentShape(Rectangle())
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
        // An image chat edits them: attached as the desktop attaches photos to edit (photoEdit.ts).
        let toEdit = chat.isImageChat
        let added = pasted.prefix(room).compactMap { toEdit ? ImageAttachments.encode($0, maxSide: CGFloat(PhotoEdit.maxEdge)) : ImageAttachments.encode($0) }
        if added.isEmpty {
            error = "There’s no image on the clipboard."
            return
        }
        images += added
    }

    private var canSend: Bool { chat.blocked == nil && !loadingPhotos && hasContent && (!chat.isImageChat || (!chat.running && !chat.sending && skill == nil)) }

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
        // Initial image generation keeps its prompt durable while authorization
        // is open. Clear that box only when the same saved draft was accepted.
        if chat.isImageChat, stored == nil, store.drafts.drafts[chat.sessionId] == nil, current == lastSaved {
            lastSaved = Draft()
            text = ""; skill = nil; images = []; refusal = nil
            return
        }
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
        return chat.isImageChat ? [] : chat.skills.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }.prefix(8).map { $0 }
    }

    /// A confirm or a choice from a voice command: answered by voice or a tap.
    private func voicePending(_ p: VoiceRunner.Pending) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(p.message).font(.caption).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
            if p.confirm {
                HStack {
                    Button("Confirm") { answer(.yes) }.buttonStyle(.borderedProminent).accessibilityIdentifier("composer.voiceConfirm")
                    Button("Cancel") { answer(.no) }.buttonStyle(.bordered)
                }
                .frame(minHeight: 44)
            } else {
                ForEach(Array(p.options.enumerated()), id: \.offset) { i, o in
                    Button { answer(.pick(i + 1)) } label: {
                        Text(o.label).font(.footnote).lineLimit(1).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.accent)
                }
                Button("Cancel") { answer(.no) }.font(.footnote).frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("composer.voicePending")
    }

    /// Each segment once, in order, while this composer is on screen: words into the message, "Nekko, ..." commands run.
    private func bindVoice() {
        let store = store, id = chat.sessionId
        voice.park = nil
        dictation.park = { Self.park($0, in: id, store.drafts) }
        dictation.sink = { words in
            voice.host = voiceHost
            Task { await voice.hear([words]) }
        }
    }

    private func takeListen() {
        guard app.takeListen(chat.sessionId) else { return }
        if !prefs.dictationHold, dictation.available, !intro.intercept(prefs) { Task { await dictation.startListening(store: store) } }
    }

    /// The chat closed: listening stops, and words still on their way go to its saved draft as plain text.
    private func unbindVoice() {
        dictation.sink = nil
        voice.park = dictation.park
        dictation.stopListening()
    }

    /// Words for a chat whose composer is not on screen: after its saved draft, which the composer shows when it opens.
    static func park(_ words: String, in chatId: String, _ drafts: DraftStore) {
        var d = drafts.draft(chatId)
        d.text += (d.text.isEmpty || d.text.last?.isWhitespace == true ? "" : " ") + words
        drafts.set(chatId, d)
    }

    private func answer(_ intent: VoiceIntent) {
        voice.host = voiceHost
        Task { await voice.answer(intent) }
    }

    /// What voice commands act on: this composer, this chat, and the app's routes.
    private var voiceHost: VoiceRunner.Host {
        let chat = chat, store = store, app = app
        return VoiceRunner.Host(
            text: $text,
            send: { canSend ? await send().value : false },
            toast: { AccessibilityNotification.Announcement($0).post() },
            tap: { Haptics.tap() },
            chats: { store.summaries.filter(\.isVisible) },
            open: { app.openChat = $0 },
            park: { Self.park($0, in: chat.sessionId, store.drafts) },
            newChat: { app.newChatRequested = true },
            openSettings: { app.openSettings = true },
            status: {
                let lane = switch store.activity[chat.sessionId] {
                case .needsYou: "Needs you"
                case .running: "Working"
                case .failed: "Error"
                case nil: chat.running ? "Working" : "Idle"
                }
                let watching = chat.watches.contains { $0.kind == .pr && $0.status == .active }
                return "\(chat.title): \(lane)\(watching ? ", Watching PR" : "")"
            },
            ship: { VoiceRunner.ShipFacts(prs: try await chat.pullRequests(refresh: true), running: chat.running, question: chat.turn.question) },
            merge: { pr in
                let r = await GitModel(store: store, chatId: chat.sessionId).prAction(pr.url, .merge)
                if r?.ok == true { return nil }
                return r.map { $0.message.isEmpty ? "Git refused it." : $0.message } ?? "Couldn’t merge \(VoiceRunner.label(pr))."
            },
            answer: { q, note in try await chat.answer(q.questions.map { AskAnswer(questionId: $0.id, labels: [], note: note) }) },
            complete: { try await store.completeChat(chat.sessionId) },
            title: { chat.title })
    }

    /// The chat's context window, or (screenshot captures, `-uiTestLongChat`) a nearly full one.
    private var longChatContext: ContextUsage? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-uiTestLongChat") {
            let json = #"{"usedTokens":176000,"contextWindow":200000,"sources":{"system":6000,"conversation":112000,"attached-file":58000}}"#
            return ContextUsage.from(try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
        }
        #endif
        return chat.context
    }

    /// A new chat on the same computer with this chat's model (the long-chat note's Start fresh).
    private func startFresh() {
        if let id = store.activeId, let p = chat.providerId, let m = chat.modelId { prefs.lastModel[id] = "\(p)::\(m)" }
        app.newChatRequested = true
    }

    /// Sends what is in the box, through `wrap`; the task says whether the computer took it (a refusal puts the text back).
    @discardableResult
    private func send(wrap: (String) -> String = { $0 }) -> Task<Bool, Never> {
        var body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var s = skill
        // "/name rest" typed out in full runs that skill.
        if !chat.isImageChat, s == nil, body.hasPrefix("/"), let space = body.firstIndex(of: " ") ?? Optional(body.endIndex) {
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
        let sentBody = wrap(body)
        let sentSkill = s
        let saved = text
        if chat.isImageChat {
            // Unlike text turns there is no exactly-once image outbox. Keep the
            // prompt durable during authorization/generation and never replay it.
            saveDraft()
            return Task {
                do {
                    try await chat.send(sentBody, skill: sentSkill, images: sentImages)
                    if text == saved {
                        text = ""; prompt = nil
                        // The photos were edited: they leave the box with the prompt.
                        if images == sentImages { images = []; photos = [] }
                        saveDraft()
                    }
                    Haptics.tap()
                    return true
                } catch { self.error = error.localizedDescription; return false }
            }
        }
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
        return Task {
            do {
                try await chat.send(sentBody, skill: sentSkill, images: sentImages)
                Haptics.tap()
                return true
            } catch {
                self.error = error.localizedDescription
                // Words dictated since stay after the refused message.
                text = text.isEmpty ? saved : saved + " " + text
                skill = sentSkill
                prompt = sentPrompt
                images = sentImages
                return false
            }
        }
    }
}

enum ImageAttachments {
    /// Photos → JPEG data URLs the computer's vision models take, scaled so a
    /// few of them stay well under the relay's frame cap.
    /// `toEdit`: photos an image chat edits, as the desktop attaches them (photoEdit.ts):
    /// at most `PhotoEdit.maxEdge` px, and a PNG stays a PNG (it may be transparent).
    static func load(_ items: [PhotosPickerItem], toEdit: Bool = false) async -> [String] {
        var out: [String] = []
        for item in items.prefix(4) {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                  let url = toEdit ? encode(image, maxSide: CGFloat(PhotoEdit.maxEdge), png: isPNG(data)) : encode(image) else { continue }
            out.append(url)
        }
        return out
    }

    /// One image as a JPEG (or PNG) data URL, at most `maxSide` px on its long side.
    static func encode(_ image: UIImage, maxSide: CGFloat = 1600, png: Bool = false) -> String? {
        // Whole pixels, rounded as the desktop's fitWithin: the computer reads the edit's shape from them.
        let fitted = PhotoEdit.fit(PixelSize(width: Int(image.size.width.rounded()), height: Int(image.size.height.rounded())), max: Int(maxSide))
        let size = CGSize(width: fitted.width, height: fitted.height)
        // Scale 1: `size` is in pixels. The default (the screen's 3x) made 4,800 px JPEGs.
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = !png
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        if png, let data = resized.pngData() { return "data:image/png;base64," + data.base64EncodedString() }
        guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { return nil }
        return "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }

    /// A picture (a data URL) ready to edit: kept as it is when the computer's gate
    /// takes it and it is small enough, else scaled like a picked photo to edit.
    static func forEdit(_ dataURL: String) -> String? {
        if PhotoEdit.accepts(dataURL), let size = PhotoEdit.size(of: dataURL), max(size.width, size.height) <= PhotoEdit.maxEdge {
            return dataURL
        }
        guard let image = DataURLImage.decode(dataURL) else { return nil }
        return encode(image, maxSide: CGFloat(PhotoEdit.maxEdge), png: dataURL.hasPrefix("data:image/png"))
    }

    private static func isPNG(_ data: Data) -> Bool { data.starts(with: [0x89, 0x50, 0x4E, 0x47]) }
}

/// Simple mode's note above the message box once a chat fills 85% of its
/// window: starting fresh saves about the conversation's tokens.
struct LongChatNote: View {
    let tokens: Int64
    var startFresh: () -> Void
    var dismiss: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Text("This chat is getting long. Starting fresh saves about \(MonitorFormat.tokens(tokens)) tokens.")
                .font(.caption).foregroundStyle(palette.inkSoft)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Start fresh", action: startFresh)
                .font(.caption.weight(.semibold)).foregroundStyle(palette.accent)
                .frame(minHeight: 44).contentShape(Rectangle())
                .accessibilityIdentifier("chat.startFresh")
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundStyle(palette.inkFaint)
                    .frame(width: 32, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 12).padding(.trailing, 4)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
        .accessibilityIdentifier("chat.longChat")
    }
}

/// A transcript row as the chat draws it: a row (with or without its reasoning),
/// or Simple's one-line summary of a turn's steps.
enum FoldItem: Identifiable {
    case row(TranscriptRow, reasoning: Bool)
    case summary(turn: String, steps: Int, thought: Bool, running: Bool)
    case details(TurnDetails)

    var id: String {
        switch self {
        case .row(let row, _): return row.id
        case .summary(let turn, _, _, _): return "steps-" + turn
        case .details(let details): return "turn-details-" + details.id
        }
    }
}

/// The words on Simple's folded steps line.
enum StepFold {
    static func summary(steps: Int, thought: Bool, running: Bool, seconds: Int? = nil) -> String {
        var text: String
        if running {
            switch steps {
            case 0: text = String(localized: "Working")
            case 1: text = String(localized: "Working · 1 step so far")
            default: text = String(localized: "Working · \(steps) steps so far")
            }
            return text
        }
        switch steps {
        case 0: text = thought ? String(localized: "Thought it through") : String(localized: "No steps")
        case 1: text = String(localized: "Took 1 step")
        default: text = String(localized: "Took \(steps) steps")
        }
        if let seconds, seconds > 0 {
            text += " · " + Duration.seconds(seconds).formatted(.units(allowed: [.minutes, .seconds], width: .narrow))
        }
        return text
    }
}

/// Simple's one line for a turn's reasoning and tool steps, with Show steps.
struct StepsSummaryRow: View {
    let text: String
    let open: Bool
    var toggle: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "list.bullet").font(.caption).foregroundStyle(palette.inkFaint).accessibilityHidden(true)
            Text(text).font(.footnote).foregroundStyle(palette.inkSoft).lineLimit(1)
            Spacer(minLength: 8)
            Button(action: toggle) {
                Text(open ? LocalizedStringKey("Hide steps") : "Show steps").font(.footnote.weight(.semibold)).foregroundStyle(palette.accent)
                    .padding(.horizontal, 4).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat.steps")
        }
        .accessibilityElement(children: .contain)
    }
}
