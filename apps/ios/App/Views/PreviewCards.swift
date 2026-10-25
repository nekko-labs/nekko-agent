import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit
import WebKit

/// An assistant reply in a chat: its Markdown, with links routed (a file or
/// a loopback page the agent linked opens the preview window, a web link
/// opens Safari), and a card under it for each file or page it links (#1095),
/// as the desktop's ChatArtifacts does.
struct AssistantReply: View {
    let text: String
    let streaming: Bool
    let sessionId: String
    @Environment(AppModel.self) private var app
    @Environment(\.palette) private var palette
    @State private var previewing: ChatPreviewLink?

    var body: some View {
        // Cards come once the reply is finished; a tapped link works meanwhile.
        let links = streaming ? [] : PreviewLinks.of(text)
        VStack(alignment: .leading, spacing: 10) {
            MarkdownText(text: text).foregroundStyle(palette.ink)
                .environment(\.openURL, OpenURLAction { url in route(url, links) })
            if !links.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(links) { link in
                        PreviewCard(link: link, sessionId: sessionId, loader: app.previews) { previewing = link }
                    }
                }
                .frame(maxWidth: 440, alignment: .leading)
            }
        }
        .fullScreenCover(item: $previewing) { link in
            PreviewWindow(link: link, sessionId: sessionId, loader: app.previews)
                .environment(\.palette, palette)
        }
    }

    private func route(_ url: URL, _ links: [ChatPreviewLink]) -> OpenURLAction.Result {
        switch ChatLinks.classify(url) {
        case .artifact, .loopback:
            guard let link = ChatLinks.preview(for: url, in: links) else { return .discarded }
            previewing = link
            return .handled
        case .web:
            return .systemAction
        case .unsupported:
            // A relative path or another scheme: nothing on this phone can open it.
            return .discarded
        }
    }
}

/// A reply's preview cards, worked out once per text.
@MainActor
enum PreviewLinks {
    private final class Box {
        let links: [ChatPreviewLink]
        init(_ links: [ChatPreviewLink]) { self.links = links }
    }

    private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 200
        return c
    }()

    static func of(_ text: String) -> [ChatPreviewLink] {
        let key = text as NSString
        if let hit = cache.object(forKey: key) { return hit.links }
        let links = ChatLinks.previews(in: text)
        cache.setObject(Box(links), forKey: key)
        return links
    }
}

/// One file or page the reply links: a thumbnail for pages and pictures, an
/// extension chip for the rest, its title and file name (or host and port).
struct PreviewCard: View {
    let link: ChatPreviewLink
    let sessionId: String
    let loader: PreviewLoader
    let open: () -> Void
    @Environment(\.palette) private var palette

    private var hasThumbnail: Bool { link.isWeb || link.kind == .image }

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                if hasThumbnail {
                    PreviewThumbnail(link: link, sessionId: sessionId, loader: loader)
                        .frame(height: 160)
                        .frame(maxWidth: .infinity)
                        .clipped()
                    Rectangle().fill(palette.line).frame(height: 1)
                }
                HStack(spacing: 10) {
                    if !hasThumbnail {
                        Text(chip)
                            .font(.caption2.monospaced().weight(.bold))
                            .foregroundStyle(palette.inkSoft)
                            .padding(.horizontal, 6).padding(.vertical, 4)
                            .background(palette.surface2, in: RoundedRectangle(cornerRadius: 6))
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(link.title).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(link.detail).font(.caption).foregroundStyle(palette.inkSoft)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(palette.accent)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .frame(minHeight: 44)
            }
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.line))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(link.title), \(link.detail)")
        .accessibilityHint("Opens a preview from your computer")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("preview.card")
    }

    /// `PDF`, `CSV`, `MD`.
    private var chip: String {
        guard let dot = link.detail.lastIndex(of: ".") else { return "FILE" }
        return String(link.detail[link.detail.index(after: dot)...]).uppercased()
    }
}

/// A card's picture. A page renders in the isolated web view at a phone's
/// width (390 pt), scaled down, without touches, and is then kept as a
/// snapshot so a long chat holds no live web views. Nothing loads until the
/// card is on screen, and only a few at a time (`PreviewLoader`).
private struct PreviewThumbnail: View {
    let link: ChatPreviewLink
    let sessionId: String
    let loader: PreviewLoader
    @Environment(\.palette) private var palette
    @State private var image: UIImage?
    @State private var source: PreviewSource?
    @State private var failed = false
    @State private var visible = false

    private static let viewport: CGFloat = 390
    private var key: String { "\(sessionId)|\(link.id)" }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                palette.surface2
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
                } else if let source, geo.size.width > 0 {
                    let scale = geo.size.width / Self.viewport
                    PreviewWebView(source: source, interactive: false) { state in
                        switch state {
                        case .loaded(let web): snapshot(web)
                        case .failed: failed = true; self.source = nil
                        case .loading: break
                        }
                    }
                    .frame(width: Self.viewport, height: geo.size.height / scale)
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                } else if failed {
                    Image(systemName: link.isWeb ? "globe" : "photo").font(.title2).foregroundStyle(palette.inkFaint)
                        .frame(width: geo.size.width, height: geo.size.height)
                } else if visible {
                    ProgressView().frame(width: geo.size.width, height: geo.size.height)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: visible) {
            guard visible, image == nil, source == nil, !failed else { return }
            await load()
        }
    }

    @MainActor private func load() async {
        if let hit = ThumbnailCache.images.object(forKey: key as NSString) {
            image = hit
            return
        }
        await loader.withThumbnailSlot {
            do {
                switch link.target {
                case .artifact(let path):
                    let body = try await loader.artifact(sessionId, path)
                    if link.kind == .image {
                        guard let full = UIImage(data: body.data) else { throw URLError(.cannotDecodeContentData) }
                        let thumb = await full.byPreparingThumbnail(ofSize: CGSize(width: 900, height: 900 * full.size.height / max(full.size.width, 1))) ?? full
                        keep(thumb)
                    } else if !body.truncated, let url = PreviewSchemes.url(artifact: path) {
                        source = PreviewSource(sessionId: sessionId, loader: loader, url: url, origin: nil)
                    } else {
                        failed = true
                    }
                case .loopback(let url):
                    guard let local = PreviewSchemes.url(preview: url), let first = PreviewSchemes.upstream(local, origin: url) else {
                        failed = true
                        return
                    }
                    _ = try await loader.fetch(sessionId, first)
                    source = PreviewSource(sessionId: sessionId, loader: loader, url: local, origin: url)
                }
            } catch {
                failed = true
            }
        }
    }

    /// Let the page's scripts draw for a moment, then keep a picture of it.
    @MainActor private func snapshot(_ web: WKWebView) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard source != nil, let picture = try? await web.takeSnapshot(configuration: nil) else { return }
            keep(picture)
            source = nil
        }
    }

    @MainActor private func keep(_ picture: UIImage) {
        ThumbnailCache.images.setObject(picture, forKey: key as NSString)
        image = picture
    }
}

@MainActor
enum ThumbnailCache {
    static let images: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 60
        return c
    }()
}
