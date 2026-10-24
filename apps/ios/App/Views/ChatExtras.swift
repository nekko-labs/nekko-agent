import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit

/// The prompts waiting in the computer's queue for this chat, each with Edit
/// and Remove. An edit is checked on the computer against the text shown here,
/// so it never lands on a prompt that already started.
struct QueueList: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var editing: Editing?
    @State private var failed: String?

    struct Editing: Identifiable {
        let index: Int
        let prompt: QueuedPrompt
        var id: String { "\(index)-\(prompt.text)" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(chat.queuedPrompts.count == 1 ? "Queued" : "Queued · \(chat.queuedPrompts.count)")
                .font(.caption.weight(.semibold)).foregroundStyle(palette.inkSoft)
            ForEach(Array(chat.queuedPrompts.enumerated()), id: \.offset) { i, q in
                HStack(spacing: 4) {
                    Image(systemName: "clock").font(.caption).foregroundStyle(palette.inkSoft).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(q.shown).font(.footnote).foregroundStyle(palette.ink).lineLimit(2)
                        if q.images > 0 {
                            Text(q.images == 1 ? "1 photo" : "\(q.images) photos").font(.caption2).foregroundStyle(palette.inkSoft)
                        }
                    }
                    Spacer(minLength: 4)
                    if q.editable {
                        iconButton("Edit queued prompt", "pencil", palette.accent) { editing = Editing(index: i, prompt: q) }
                            .accessibilityIdentifier("chat.queue.edit")
                    }
                    iconButton("Remove queued prompt", "xmark.circle", palette.danger) { remove(i, q) }
                        .accessibilityIdentifier("chat.queue.remove")
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Queued: \(q.shown)")
            }
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // On an opaque surface: over the translucent bar the queued text measured below contrast.
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .sheet(item: $editing) { e in
            QueueEditor(prompt: e.prompt, computer: store.active?.name ?? "your computer") { text in
                try await chat.editQueued(e.index, expect: e.prompt.text, text: text)
            }
        }
    }

    private func iconButton(_ label: String, _ icon: String, _ color: Color, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: icon).font(.body).foregroundStyle(color).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func remove(_ i: Int, _ q: QueuedPrompt) {
        failed = nil
        Task {
            do { try await chat.editQueued(i, expect: q.text, text: nil) } catch { failed = error.localizedDescription }
        }
    }
}

/// Change a queued prompt's words before it runs. Saving blank removes it (unless it has photos).
struct QueueEditor: View {
    let prompt: QueuedPrompt
    let computer: String
    var save: (String?) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var text = ""
    @State private var busy = false
    @State private var failed: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Prompt", text: $text, axis: .vertical)
                        .lineLimit(3...12)
                        .focused($focused)
                        .accessibilityIdentifier("queue.editor.text")
                } footer: {
                    Text("It runs on \(computer) after the current reply. If it has already started, nothing changes.")
                }
                if let failed {
                    Section { Label(failed, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
                }
                Section {
                    Button("Remove from the queue", role: .destructive) { run(nil) }.disabled(busy)
                }
            }
            .navigationTitle("Queued prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { run(text) }.disabled(busy || text == prompt.text)
                        .accessibilityIdentifier("queue.editor.save")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            text = prompt.text
            focused = true
        }
    }

    private func run(_ value: String?) {
        busy = true
        failed = nil
        Task {
            do {
                try await save(value)
                dismiss()
            } catch {
                failed = error.localizedDescription
            }
            busy = false
        }
    }
}

/// A user's photos in the transcript, as the small copies the computer sends; tap to see them full screen.
struct PhotoStrip: View {
    let photos: [String]
    var open: (Int) -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(photos.enumerated()), id: \.offset) { i, p in
                if let image = DataURLImage.decode(p) {
                    Button { open(i) } label: {
                        Image(uiImage: image).resizable().scaledToFill().frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Photo \(i + 1) of \(photos.count)")
                    .accessibilityHint("Opens it full screen")
                    .accessibilityIdentifier("chat.photo")
                }
            }
        }
    }
}

/// Full-screen photos: swipe between them, pinch or double-tap to zoom.
struct ImageViewer: View {
    let photos: [String]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let shown = photos.compactMap(DataURLImage.decode)
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(shown.enumerated()), id: \.offset) { i, image in
                    ZoomableImage(image: image).tag(i)
                        .accessibilityLabel("Photo \(i + 1) of \(shown.count)")
                }
            }
            .tabViewStyle(.page(indexDisplayMode: shown.count > 1 ? .automatic : .never))
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.body.weight(.bold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(.black.opacity(0.5), in: Circle())
            }
            .accessibilityLabel("Close")
            .accessibilityIdentifier("viewer.close")
            .padding(16)
        }
        .statusBarHidden()
    }
}

private struct ZoomableImage: View {
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var settled: CGFloat = 1

    var body: some View {
        Image(uiImage: image).resizable().scaledToFit()
            .scaleEffect(scale)
            .gesture(MagnifyGesture()
                .onChanged { scale = min(5, max(1, settled * $0.magnification)) }
                .onEnded { _ in settled = scale })
            .onTapGesture(count: 2) {
                withAnimation(.snappy) { scale = scale > 1 ? 1 : 2.5 }
                settled = scale
            }
            .accessibilityAddTraits(.isImage)
    }
}

enum DataURLImage {
    /// A `data:image/…;base64,` URL's image, or nil (`""` is a photo the computer kept back).
    static func decode(_ url: String) -> UIImage? {
        guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

/// The chat's pull request: its state and checks, and the git steps the agent takes for you.
struct PrChip: View {
    let chat: ChatModel
    @Environment(\.palette) private var palette
    @State private var prs: [PullRequest] = []
    @State private var open = false

    var body: some View {
        Group {
            if let pr = prs.first {
                Button { open = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.pull").accessibilityHidden(true)
                        Text(pr.summary).lineLimit(1)
                    }
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12).frame(minHeight: 32)
                    .background(color(pr).opacity(0.14), in: Capsule())
                    .foregroundStyle(color(pr))
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Pull request \(pr.summary)")
                .accessibilityIdentifier("chat.prChip")
            }
        }
        .task(id: chat.session?.updatedAt) {
            if let list = try? await chat.pullRequests() { prs = list }
        }
        .sheet(isPresented: $open) { PrSheet(chat: chat, initial: prs) }
    }

    private func color(_ pr: PullRequest) -> Color {
        switch (pr.state, pr.checks) {
        case (.merged, _): return palette.accent
        case (.closed, _): return palette.inkSoft
        case (_, .failing): return palette.danger
        case (_, .pending): return palette.running
        default: return palette.success
        }
    }
}

/// A chat's pull requests, and git steps phrased as prompts: the agent runs
/// them on the computer, so this chat's approvals apply to every command.
struct PrSheet: View {
    let chat: ChatModel
    let initial: [PullRequest]
    @State private var prs: [PullRequest] = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @Environment(ComputersStore.self) private var store
    @State private var failed: String?
    @State private var git: GitModel?

    var body: some View {
        NavigationStack {
            List {
                if prs.isEmpty {
                    Text("This chat hasn’t opened a pull request.").foregroundStyle(palette.inkSoft)
                }
                ForEach(prs) { pr in
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pr.title).font(.headline).foregroundStyle(palette.ink)
                            Text(pr.summary).font(.subheadline).foregroundStyle(palette.inkSoft)
                            Text("+\(pr.additions) −\(pr.deletions) in \(pr.changedFiles == 1 ? "1 file" : "\(pr.changedFiles) files")")
                                .font(.footnote).foregroundStyle(palette.inkFaint)
                            if let r = pr.reviewDecision, !r.isEmpty {
                                Text(r.replacingOccurrences(of: "_", with: " ").capitalized).font(.footnote).foregroundStyle(palette.inkSoft)
                            }
                        }
                        if let url = URL(string: pr.url) {
                            Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
                        }
                        // IO-33 FA-2: its checks, its files and the PR actions, straight from the phone.
                        if let git {
                            NavigationLink { PrDetailView(model: git, pr: pr) } label: {
                                Label("Checks, files and actions", systemImage: "checklist")
                            }
                            .accessibilityIdentifier("pr.detail")
                        }
                    }
                }
                Section {
                    NavigationLink { GitScreen(chatId: chat.sessionId) } label: {
                        Label("Git: status, commit, push", systemImage: "arrow.triangle.branch")
                    }
                    .accessibilityIdentifier("pr.git")
                } footer: {
                    Text("Done from this phone, with Face ID or your passcode.")
                }
                Section {
                    ForEach(actions, id: \.self) { a in
                        Button { send(a) } label: { Label(a.label, systemImage: icon(a)) }
                            .accessibilityIdentifier("pr.ask.\(a.rawValue)")
                    }
                } header: {
                    Text("Ask the agent")
                } footer: {
                    Text("Sent to this chat as a prompt. The agent does the git work on \(chat.title == "Chat" ? "your computer" : "the computer"), and asks you before anything that needs approval.")
                }
                if let failed { Label(failed, systemImage: "exclamationmark.triangle").foregroundStyle(palette.danger) }
            }
            .task {
                prs = initial
                if git == nil { git = GitModel(store: store, chatId: chat.sessionId) }
                if let list = try? await chat.pullRequests() { prs = list }
            }
            .navigationTitle(prs.count == 1 ? "Pull request" : "Pull requests")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private var actions: [GitPrompt] {
        var out: [GitPrompt] = [.commit]
        if prs.isEmpty || prs.allSatisfy({ $0.state != .open }) { out.append(.openPr) }
        if prs.contains(where: { $0.state == .open && $0.checks == .failing }) { out.append(.fixChecks) }
        return out
    }

    private func icon(_ a: GitPrompt) -> String {
        switch a {
        case .commit: return "checkmark.seal"
        case .openPr: return "arrow.triangle.pull"
        case .fixChecks: return "wrench.and.screwdriver"
        }
    }

    private func send(_ a: GitPrompt) {
        failed = nil
        Task {
            do {
                try await chat.send(a.text)
                Haptics.tap()
                dismiss()
            } catch {
                failed = error.localizedDescription
            }
        }
    }
}

extension Block {
    /// A prompt the user sent (the bubble on the right).
    var isPrompt: Bool { if case .user = self { return true } else { return false } }

    /// What Copy puts on the clipboard.
    var copyText: String? {
        switch self {
        case .user(_, let text, _, _): return text
        case .assistant(_, let text, _, _, _): return text
        case .tool(_, _, let label, _, let output, _): return output.map { label + "\n" + Transcript.splitNotes($0).0 } ?? label
        }
    }
}

/// Photos open full screen, and the one tapped.
struct PhotoSet: Identifiable {
    let photos: [String]
    let index: Int
    var id: String { "\(index)-\(photos.count)" }
}
