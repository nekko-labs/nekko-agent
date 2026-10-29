import NekkoKit
import NekkoProtocol
import PDFKit
import SwiftUI
import UIKit

/// A file the agent made, or a dev server on the computer, opened full screen
/// (#1095): an HTML prototype or SVG runs in the isolated web view
/// (`PreviewWebView`), interactive; images zoom; Markdown is formatted; text,
/// JSON and CSV are monospaced; a PDF opens in PDFKit. Everything is read
/// from the computer through the relay: the phone never reaches the
/// computer's files or ports itself.
struct PreviewWindow: View {
    let link: ChatPreviewLink
    let sessionId: String
    let loader: PreviewLoader
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @State private var content: Content?
    @State private var error: String?
    @State private var webLoading = false
    @State private var attempt = 0
    @State private var copied = false

    enum Content {
        case web(PreviewSource)
        case image(UIImage)
        case markdown(String, cut: Int64?)
        case text(String, cut: Int64?)
        case pdf(Data)
    }

    private var loopback: Bool { if case .loopback = link.target { return true } else { return false } }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .top) {
                palette.paper.ignoresSafeArea()
                if let error {
                    failure(error)
                } else if let content {
                    view(content)
                } else {
                    ProgressView("Opening on your computer…")
                        .foregroundStyle(palette.inkSoft)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("preview.loading")
                }
                if webLoading && error == nil {
                    ProgressView()
                        .padding(10)
                        .background(.regularMaterial, in: Circle())
                        .padding(.top, 12)
                        .accessibilityLabel("Loading")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(link.title).font(.headline).foregroundStyle(palette.ink).lineLimit(1)
                        Text(link.detail).font(.caption).foregroundStyle(palette.inkSoft).lineLimit(1).truncationMode(.middle)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("preview.done")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { attempt += 1 } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .accessibilityIdentifier("preview.reload")
                    Menu {
                        Button {
                            UIPasteboard.general.string = link.original
                            AccessibilityNotification.Announcement("Copied").post()
                        } label: { Label(loopback ? "Copy address" : "Copy path", systemImage: "doc.on.doc") }
                        ShareLink(item: link.original) { Label("Share", systemImage: "square.and.arrow.up") }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        .task(id: attempt) { await load() }
    }

    @ViewBuilder private func view(_ content: Content) -> some View {
        switch content {
        case .web(let source):
            PreviewWebView(source: source, interactive: true) { state in
                switch state {
                case .loading: webLoading = true
                case .loaded: webLoading = false
                case .failed(let message):
                    webLoading = false
                    error = message
                }
            }
            .id(attempt)
            .ignoresSafeArea(edges: .bottom)
            .accessibilityLabel(link.title)
        case .image(let image):
            ZoomableImage(image: image)
                .ignoresSafeArea(edges: .bottom)
                .accessibilityLabel(link.title)
                .accessibilityAddTraits(.isImage)
        case .markdown(let text, let cut):
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    cutNote(cut)
                    MarkdownText(text: text).foregroundStyle(palette.ink)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .text(let text, let cut):
            ScrollView([.vertical, .horizontal]) {
                VStack(alignment: .leading, spacing: 12) {
                    cutNote(cut)
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(palette.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                }
                .padding(16)
            }
        case .pdf(let data):
            PDFPreview(data: data).ignoresSafeArea(edges: .bottom)
        }
    }

    @ViewBuilder private func cutNote(_ size: Int64?) -> some View {
        if let size {
            Label("Only the start is shown: the whole file is \(ByteCountFormatter.string(fromByteCount: size, countStyle: .file)) on your computer.",
                  systemImage: "scissors")
                .font(.footnote).foregroundStyle(palette.warning)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(palette.inkSoft)
                .accessibilityHidden(true)
            Text("Couldn’t open the preview").font(.headline).foregroundStyle(palette.ink)
            Text(message).font(.body).foregroundStyle(palette.inkSoft).multilineTextAlignment(.center)
            Button("Try again") { attempt += 1 }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("preview.retry")
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("preview.error")
    }

    @MainActor private func load() async {
        let reload = attempt > 0
        error = nil
        content = nil
        webLoading = false
        // Reload reads the page and everything it uses again.
        if reload { loader.forget(sessionId) }
        do {
            switch link.target {
            case .artifact(let path):
                let body = try await loader.artifact(sessionId, path, reload: reload)
                let cut = body.truncated ? body.size : nil
                switch link.kind ?? ArtifactKind(path: path) ?? .text {
                case .html, .svg:
                    // Half a page would run half a prototype.
                    if body.truncated { throw RelayError("Too large to open on a phone.") }
                    guard let url = PreviewSchemes.url(artifact: path) else { throw RelayError("This path can’t be opened.") }
                    content = .web(PreviewSource(sessionId: sessionId, loader: loader, url: url, origin: nil))
                case .image:
                    guard let image = UIImage(data: body.data) else { throw RelayError("This image can’t be shown on a phone.") }
                    content = .image(image)
                case .markdown:
                    content = .markdown(String(decoding: body.data, as: UTF8.self), cut: cut)
                case .text:
                    content = .text(Self.shown(String(decoding: body.data, as: UTF8.self)), cut: cut)
                case .pdf:
                    content = .pdf(body.data)
                }
            case .loopback(let url):
                guard let local = PreviewSchemes.url(preview: url), let first = PreviewSchemes.upstream(local, origin: url) else {
                    throw RelayError("This address can’t be opened.")
                }
                // Read the page first, so a stopped server says so here rather than as a blank page.
                _ = try await loader.fetch(sessionId, first, reload: reload)
                content = .web(PreviewSource(sessionId: sessionId, loader: loader, url: local, origin: url))
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = PreviewLoader.message(error, loopback: loopback)
        }
    }

    /// A very long text file is cut for display: one `Text` can't lay out megabytes.
    static func shown(_ text: String) -> String {
        let limit = 200_000
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "\n…"
    }
}

/// A picture that pinches and double-taps to zoom.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> ZoomView { ZoomView(image: image) }
    func updateUIView(_ view: ZoomView, context: Context) {}

    final class ZoomView: UIScrollView, UIScrollViewDelegate {
        private let imageView: UIImageView

        init(image: UIImage) {
            imageView = UIImageView(image: image)
            super.init(frame: .zero)
            imageView.contentMode = .scaleAspectFit
            addSubview(imageView)
            delegate = self
            minimumZoomScale = 1
            maximumZoomScale = 8
            showsHorizontalScrollIndicator = false
            showsVerticalScrollIndicator = false
            let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
            tap.numberOfTapsRequired = 2
            addGestureRecognizer(tap)
        }

        required init?(coder: NSCoder) { nil }

        override func layoutSubviews() {
            super.layoutSubviews()
            if zoomScale == 1 { imageView.frame = bounds }
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc private func doubleTap(_ g: UITapGestureRecognizer) {
            if zoomScale > 1 {
                setZoomScale(1, animated: true)
            } else {
                let p = g.location(in: imageView)
                zoom(to: CGRect(x: p.x - bounds.width / 6, y: p.y - bounds.height / 6, width: bounds.width / 3, height: bounds.height / 3), animated: true)
            }
        }
    }
}

private struct PDFPreview: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.document = PDFDocument(data: data)
        return v
    }

    func updateUIView(_ v: PDFView, context: Context) {}
}
