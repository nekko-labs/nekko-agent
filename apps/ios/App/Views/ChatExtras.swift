import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit
import ImageIO

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
                if chat.running {
                    textButton("Interrupt and send now", hint: "Stops the reply and sends this now", id: "chat.queue.interrupt") {
                        try await chat.interruptQueued(i)
                    }
                    .padding(.leading, 20)
                }
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

    private func textButton(_ label: LocalizedStringKey, hint: LocalizedStringKey, id: String, _ run: @escaping () async throws -> Void) -> some View {
        Button {
            failed = nil
            Task {
                do { try await run() } catch { failed = error.localizedDescription }
            }
        } label: {
            Text(label).font(.footnote.weight(.semibold)).foregroundStyle(palette.accent)
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(hint)
        .accessibilityIdentifier(id)
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
        // A swipe down doesn't drop an edit (as FileEditor): Cancel does, on purpose.
        .interactiveDismissDisabled(busy || text != prompt.text)
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
                if let image = DataURLImage.thumbnail(p) {
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

/// Full-screen photos: swipe between them, pinch or double-tap to zoom where
/// you pinch or tap, pan a zoomed photo (UIScrollView: it follows the fingers
/// and bounces at the edges and at the zoom limits), and swipe up or down to
/// close. The transcript only holds small copies, so each photo opens on its
/// small copy under a spinner while the computer sends it full size
/// (`session:photo`); Save to Photos, Copy and Share use the full one.
struct ImageViewer: View {
    let photos: [String]
    @State var index: Int
    /// Photo `i` at full size, as a data URL (nil: the computer has none to send).
    /// Without it the viewer shows only the small copies.
    var load: ((Int) async throws -> String?)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var full: [Int: UIImage] = [:]
    @State private var loading: Set<Int> = []
    /// Asked for and none came: the small copy is all there is.
    @State private var unavailable: Set<Int> = []
    /// How far a swipe to close has gone, 0 to 1: the backdrop and controls fade with it.
    @State private var drag: CGFloat = 0
    @State private var note: String?

    var body: some View {
        // Pages keep the photos' own indices; a photo the computer kept back ("") has none.
        let pages = photos.indices.filter { !photos[$0].isEmpty }
        ZStack {
            Color.black.opacity(1 - drag * 0.85).ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(pages.enumerated()), id: \.element) { n, i in
                    ZoomingPhoto(source: photos[i], full: full[i], onDrag: dragged, onClose: swipeClose).tag(i)
                        .ignoresSafeArea()
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Photo \(n + 1) of \(pages.count)")
                        .accessibilityAddTraits(.isImage)
                        .accessibilityAction(named: "Close") { dismiss() }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: pages.count > 1 && drag == 0 ? .automatic : .never))
            if loading.contains(index) {
                ProgressView().controlSize(.large).tint(.white)
                    .padding(18).background(.black.opacity(0.45), in: Circle())
                    .opacity(1 - drag)
                    .accessibilityLabel("Loading the full-size photo")
                    .accessibilityIdentifier("viewer.loading")
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: loading.contains(index))
        .overlay(alignment: .top) { controls.opacity(1 - drag) }
        .overlay(alignment: .bottom) {
            if let note {
                Text(note).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule()).padding(.bottom, 32)
                    .transition(.opacity)
            }
        }
        .task(id: index) { await fetch(index) }
        .presentationBackground(.clear)
        .statusBarHidden()
    }

    private var controls: some View {
        HStack {
            let image = shareable(index)
            Menu {
                Button { if let image { save(image) } } label: { Label("Save to Photos", systemImage: "photo.badge.arrow.down") }
                    .accessibilityIdentifier("viewer.save")
                Button { if let image { copy(image) } } label: { Label("Copy", systemImage: "doc.on.doc") }
                    .accessibilityIdentifier("viewer.copy")
                if let image {
                    ShareLink(item: Image(uiImage: image), preview: SharePreview("Photo", image: Image(uiImage: image))) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
            } label: {
                circle("ellipsis")
            }
            .disabled(image == nil)
            .accessibilityLabel("Photo actions")
            .accessibilityHint(image == nil ? "Available once the full-size photo loads" : "Save, copy or share it")
            .accessibilityIdentifier("viewer.actions")
            Spacer()
            Button { dismiss() } label: { circle("xmark") }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("viewer.close")
        }
        .padding(16)
    }

    private func circle(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.body.weight(.bold)).foregroundStyle(.white)
            .frame(width: 44, height: 44).background(.black.opacity(0.5), in: Circle())
    }

    /// What Save, Copy and Share use: the full photo, or the small copy once
    /// there is no full one coming. Nil while it loads.
    private func shareable(_ i: Int) -> UIImage? {
        if let image = full[i] { return image }
        guard load == nil || unavailable.contains(i), photos.indices.contains(i) else { return nil }
        return DataURLImage.decode(photos[i])
    }

    private func fetch(_ i: Int) async {
        guard let load, full[i] == nil, !loading.contains(i), !unavailable.contains(i) else { return }
        loading.insert(i)
        defer { loading.remove(i) }
        let url = try? await load(i)
        // Decoding a photo of several megabytes stays off the main thread.
        let image = await Task.detached(priority: .userInitiated) { url.flatMap(DataURLImage.decode) }.value
        // Kept even if the page was swiped away meanwhile: it shows at once on the way back.
        if let image { full[i] = image } else { unavailable.insert(i) }
    }

    private func dragged(_ progress: CGFloat, animated: Bool) {
        withAnimation(animated ? .easeOut(duration: 0.25) : nil) { drag = progress }
    }

    /// The photo has already flown off: close without the cover sliding down after it.
    private func swipeClose() {
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { dismiss() }
    }

    private func save(_ image: UIImage) {
        UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil)
        show("Saved to Photos")
    }

    private func copy(_ image: UIImage) {
        UIPasteboard.general.image = image
        show("Copied")
    }

    private func show(_ s: String) {
        Haptics.tap()
        withAnimation { note = s }
        AccessibilityNotification.Announcement(s).post()
        Task { try? await Task.sleep(nanoseconds: 1_500_000_000); withAnimation { note = nil } }
    }
}

/// One photo in a zooming scroll view. The small copy is decoded in
/// `makeUIView`, once per page; the full one replaces it when it arrives.
private struct ZoomingPhoto: UIViewRepresentable {
    let source: String
    var full: UIImage?
    var onDrag: (CGFloat, Bool) -> Void
    var onClose: () -> Void

    func makeUIView(context: Context) -> PhotoScrollView {
        let view = PhotoScrollView(image: full ?? DataURLImage.decode(source))
        view.onDrag = onDrag
        view.onClose = onClose
        return view
    }

    func updateUIView(_ view: PhotoScrollView, context: Context) {
        view.onDrag = onDrag
        view.onClose = onClose
        if let full { view.show(full) }
    }
}

/// The photo fitted to the screen at zoom 1, centred while it is smaller than
/// the screen, zoomable to 5x around the pinch and pannable once zoomed.
/// Double-tap zooms to 2.5x at the tapped point, or back out. At zoom 1 a
/// mostly vertical drag carries the photo with the finger and closes the
/// viewer past a distance or a flick; short of that it springs back.
final class PhotoScrollView: UIScrollView, UIScrollViewDelegate {
    private let imageView = UIImageView()
    /// The size the image was last fitted to, so a resize or rotation fits it again.
    private var fitted: CGSize = .zero
    /// How far a swipe to close has gone (0 to 1), and whether to animate to it.
    var onDrag: ((CGFloat, Bool) -> Void)?
    var onClose: (() -> Void)?
    private let closePan = UIPanGestureRecognizer()
    /// Lets the swipe to close run alongside the pager's own swipe.
    private let closePanRules = SimultaneousGestures()

    init(image: UIImage?) {
        super.init(frame: .zero)
        imageView.image = image
        imageView.contentMode = .scaleAspectFit
        addSubview(imageView)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 5
        bouncesZoom = true
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        closePan.addTarget(self, action: #selector(panned(_:)))
        closePan.delegate = closePanRules
        addGestureRecognizer(closePan)
    }

    /// The full photo in place of the small copy, at the same zoom and place
    /// (it has the same shape; refitted if not).
    func show(_ image: UIImage) {
        guard imageView.image !== image else { return }
        let old = imageView.image?.size ?? .zero
        imageView.image = image
        let same = old.width > 0 && old.height > 0
            && abs(old.width / old.height - image.size.width / image.size.height) < 0.01
        if !same {
            fitted = .zero
            setNeedsLayout()
        }
    }

    override func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === closePan else { return super.gestureRecognizerShouldBegin(g) }
        // A zoomed photo pans instead; sideways is the pager's.
        guard zoomScale <= minimumZoomScale + 0.01 else { return false }
        let v = closePan.velocity(in: self)
        return abs(v.y) > abs(v.x) * 1.2
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let t = pan.translation(in: self)
        let height = max(bounds.height, 1)
        let progress = min(abs(t.y) / (height * 0.4), 1)
        switch pan.state {
        case .changed:
            let scale = 1 - progress * 0.2
            transform = CGAffineTransform(translationX: t.x * 0.5, y: t.y).scaledBy(x: scale, y: scale)
            onDrag?(progress, false)
        case .ended:
            let v = pan.velocity(in: self).y
            // Past a quarter of the screen, or flicked the same way it was dragged.
            let close = abs(t.y) > height * 0.25 || (abs(v) > 900 && (v > 0) == (t.y > 0))
            if close {
                let away = (t.y == 0 ? v : t.y) >= 0 ? height : -height
                onDrag?(1, true)
                UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut]) {
                    self.transform = self.transform.translatedBy(x: 0, y: away)
                } completion: { _ in
                    self.onClose?()
                }
            } else {
                springBack()
            }
        case .cancelled, .failed:
            springBack()
        default:
            break
        }
    }

    private func springBack() {
        onDrag?(0, true)
        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0) {
            self.transform = .identity
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let size = imageView.image?.size, size.width > 0, size.height > 0, bounds.width > 0, bounds.height > 0 else { return }
        if fitted != bounds.size {
            fitted = bounds.size
            zoomScale = minimumZoomScale
            let s = min(bounds.width / size.width, bounds.height / size.height)
            imageView.frame = CGRect(x: 0, y: 0, width: size.width * s, height: size.height * s)
            contentSize = imageView.frame.size
        }
        centre()
    }

    /// While the photo is smaller than the screen in a direction, it sits in the middle of it.
    private func centre() {
        let h = max(0, (bounds.width - contentSize.width) / 2)
        let v = max(0, (bounds.height - contentSize.height) / 2)
        let inset = UIEdgeInsets(top: v, left: h, bottom: v, right: h)
        if contentInset != inset { contentInset = inset }
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if zoomScale > minimumZoomScale {
            setZoomScale(minimumZoomScale, animated: true)
            return
        }
        let point = tap.location(in: imageView)
        let scale: CGFloat = 2.5
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}

/// Lets a pan run alongside the gestures around it (the pager's swipe).
private final class SimultaneousGestures: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

enum DataURLImage {
    /// Decode only a small preview for a selected full-size photo. ImageIO
    /// honours EXIF orientation without rasterising the entire attachment.
    static func thumbnail(_ url: String) -> UIImage? {
        guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 240,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

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
    /// The message they belong to, so the viewer can ask the computer for each at full size.
    var messageId: String?
    var id: String { "\(messageId ?? "")-\(index)-\(photos.count)" }
}
