import NekkoKit
import NekkoProtocol
import SwiftUI

/// A paid cloud clip's choice and confirmation in one card (#3038), the iPhone's
/// twin of the desktop's `ClipPicker`: length, audio and resolution as native
/// segmented choices, the total updating with each pick, what leaves the
/// computer, and one button that names the price. Logic is `ClipPicker`.
struct ClipPickerCard: View {
    let request: AskRequest
    let offer: ClipOffer
    var submit: ([AskAnswer]) async throws -> Void
    @Environment(\.palette) private var palette
    @State private var picks: [String: String]
    @State private var sending = false
    @State private var failed: String?

    init(request: AskRequest, offer: ClipOffer, submit: @escaping ([AskAnswer]) async throws -> Void) {
        self.request = request
        self.offer = offer
        self.submit = submit
        _picks = State(initialValue: ClipPicker.suggested(request))
    }

    var body: some View {
        let total = ClipPicker.total(request, picks: picks)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Make a clip with \(offer.model)").font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                Text("through \(offer.via) · paid from your \(offer.via) account").font(.caption).foregroundStyle(palette.inkSoft)
            }
            .accessibilityElement(children: .combine)
            ForEach(request.questions) { q in
                VStack(alignment: .leading, spacing: 4) {
                    Text(q.header).font(.caption.weight(.semibold)).foregroundStyle(palette.inkSoft)
                    if q.options.count > 1 {
                        Picker(q.header, selection: Binding(get: { picks[q.id] ?? "" }, set: { picks[q.id] = $0 })) {
                            ForEach(q.options, id: \.label) { Text($0.label).tag($0.label) }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("clip.\(q.header)")
                    } else {
                        Text(q.options.first?.label ?? "").font(.footnote).foregroundStyle(palette.ink)
                    }
                }
            }
            .disabled(sending)
            HStack(alignment: .firstTextBaseline) {
                Text("Total").font(.footnote).foregroundStyle(palette.inkSoft)
                Spacer()
                Text(total.map(ClipPicker.dollars) ?? "Not priced").font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(palette.ink)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: total)
                    .accessibilityIdentifier("clip.total")
            }
            .accessibilityElement(children: .combine)
            Text("\(ClipPicker.warning) \(ClipPicker.leaves(offer))")
                .font(.caption).foregroundStyle(palette.inkSoft).fixedSize(horizontal: false, vertical: true)
            if let failed {
                Label(failed, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger)
            }
            HStack(spacing: 8) {
                Button { run([]) } label: {
                    Text("Cancel").font(.footnote.weight(.semibold)).foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .background(palette.surface2, in: RoundedRectangle(cornerRadius: 8))
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(sending)
                Button {
                    if let total { run(ClipPicker.answers(request, picks: picks, total: total)) }
                } label: {
                    Group {
                        if sending { ProgressView().tint(palette.onAccent) } else { Text(ClipPicker.makeTitle(total: total, sending: false)).font(.footnote.weight(.semibold)) }
                    }
                    .foregroundStyle(total == nil ? palette.inkFaint : palette.onAccent)
                    .frame(maxWidth: .infinity, minHeight: 36)
                    .background(total == nil ? palette.surface2 : palette.accent, in: RoundedRectangle(cornerRadius: 8))
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(sending || total == nil)
                .accessibilityIdentifier("clip.make")
            }
        }
        .padding(14)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.accent.opacity(0.6)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Make a clip with \(offer.model)")
    }

    private func run(_ answers: [AskAnswer]) {
        guard !sending else { return }
        sending = true
        failed = nil
        Task {
            do { try await submit(answers) } catch { failed = "Couldn’t send that: \(error.localizedDescription) Try again." }
            sending = false
        }
    }
}

/// The clips being made in this chat, above the message box: name, stage and state,
/// and Cancel clip.
struct ClipChips: View {
    let chat: ChatModel
    @Environment(ComputersStore.self) private var store
    @Environment(\.palette) private var palette
    @State private var busy: String?
    @State private var failed: String?

    var body: some View {
        let clips = AgentRows.chips(chat.watches).filter { $0.kind == .clip }
        if !clips.isEmpty || failed != nil {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(clips) { w in chip(w) }
                if let failed { Label(failed, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(palette.danger) }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
        }
    }

    private func chip(_ w: AgentWatch) -> some View {
        let call = AgentRows.WatchCall(action: .create, kind: .clip, url: nil, seconds: nil, prompt: "", id: w.id)
        return HStack(alignment: .center, spacing: 8) {
            RunningDots()
            VStack(alignment: .leading, spacing: 0) {
                Text(AgentRows.watchName(.clip)).font(.footnote.weight(.medium)).foregroundStyle(palette.ink)
                let clock = AgentRows.watchClock(call, view: w, now: 0)
                Text([AgentRows.watchProgress(w), clock?.text].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(palette.inkSoft).lineLimit(2)
            }
            Spacer(minLength: 4)
            Button { cancel(w) } label: {
                Text(busy == w.id ? "Cancelling…" : AgentRows.cancelLabel(.clip)).font(.footnote).foregroundStyle(palette.accent)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(busy != nil)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.clipChip")
    }

    private func cancel(_ w: AgentWatch) {
        busy = w.id
        failed = nil
        Task {
            do {
                _ = try await store.remote().call(Channels.sessionCancelWatch, [.string(chat.sessionId), .string(w.id)])
                await chat.refreshAgentState()
            } catch { failed = "Couldn’t cancel the clip: \(error.localizedDescription)" }
            busy = nil
        }
    }
}

/// The pictures an agent made in a `generate_image` or `edit_image` call, under its row.
/// Each is asked for when the row appears (`session:photo`), so the chat itself never
/// carries them; tap to view full size.
struct ToolPicturesRow: View {
    let chat: ChatModel
    let found: ToolPictures.Found
    @Environment(\.palette) private var palette
    @State private var photos: [String] = []
    @State private var settled = false
    @State private var viewing: PhotoSet?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if photos.contains(where: { !$0.isEmpty }) {
                PhotoStrip(photos: photos) { viewing = PhotoSet(photos: photos, index: $0, messageId: nil) }
            } else if settled {
                Label("Picture not shown here. Open it on your computer.", systemImage: "photo").font(.caption).foregroundStyle(palette.inkFaint)
            } else {
                ProgressView().controlSize(.small).frame(width: 64, height: 64)
            }
        }
        .padding(.leading, 24)
        .task(id: found) { await load() }
        .fullScreenCover(item: $viewing) { set in ImageViewer(photos: set.photos, index: set.index) }
    }

    private func load() async {
        var out = Array(repeating: "", count: found.count)
        for i in 0..<found.count {
            if let url = try? await chat.toolPhoto(found, i) { out[i] = url }
        }
        photos = out
        settled = true
    }
}
