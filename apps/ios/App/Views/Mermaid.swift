import NekkoProtocol
import SwiftUI
import UIKit
import WebKit

/// A ```` ```mermaid ```` fence drawn as its diagram (MM-2): an image scaled to
/// the bubble, tap for full screen. While the reply streams the fence shows as
/// source; a diagram that fails falls back to its source with Mermaid's error.
struct MermaidBlock: View {
    let source: String
    /// Whether the fence has closed (a streaming reply may not have written it yet).
    let closed: Bool
    let style: MarkdownStyle
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale
    @State private var width: CGFloat = 0
    @State private var phase: Phase = .waiting
    @State private var full = false
    @State private var showSource = false

    enum Phase {
        case waiting
        case drawn(MermaidRenderer.Drawing)
        case failed(String)
    }

    var body: some View {
        let decision = MermaidRules.decide(source: source, closed: closed)
        VStack(alignment: .leading, spacing: 6) {
            switch decision {
            case .waitForFence:
                CodeBlock(language: "mermaid", code: source, style: style)
                Label("Drawing when the reply finishes…", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.caption).foregroundStyle(style.faint)
            case .tooLarge:
                fallback("Too large to draw on the phone")
            case .draw:
                switch phase {
                case .drawn(let drawing):
                    Button { full = true } label: {
                        Image(uiImage: drawing.image).resizable().scaledToFit()
                            .frame(maxWidth: drawing.image.size.width, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Diagram, \(MermaidRules.kind(source))")
                    .accessibilityHint("Opens it full screen")
                    .accessibilityAction(named: "Show source") { showSource.toggle() }
                    .accessibilityIdentifier("mermaid.diagram")
                    .contextMenu {
                        Button { UIPasteboard.general.string = source } label: { Label("Copy source", systemImage: "doc.on.doc") }
                        Button { showSource.toggle() } label: { Label(showSource ? "Hide source" : "Show source", systemImage: "chevron.left.forwardslash.chevron.right") }
                    }
                    if showSource { CodeBlock(language: "mermaid", code: source, style: style) }
                case .failed(let message):
                    fallback(message)
                case .waiting:
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Drawing diagram…").font(.caption).foregroundStyle(style.faint)
                    }
                    .frame(minHeight: 44)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { g in
            Color.clear
                .onAppear { width = g.size.width }
                .onChange(of: g.size.width) { _, w in width = w }
        })
        .task(id: taskKey(decision)) { await draw(decision) }
        .fullScreenCover(isPresented: $full) {
            if case .drawn(let drawing) = phase { MermaidScreen(source: source, drawing: drawing) }
        }
    }

    private func fallback(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(style.soft)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("mermaid.error")
            CodeBlock(language: "mermaid", code: source, style: style)
        }
    }

    private var dark: Bool { scheme == .dark }

    private func taskKey(_ decision: MermaidRules.Decision) -> String {
        "\(decision)|\(dark)|\(MermaidRules.drawWidth(Double(width)))|\(source.count)|\(source.hashValue)"
    }

    private func draw(_ decision: MermaidRules.Decision) async {
        guard decision == .draw, width > 0 else { return }
        let w = MermaidRules.drawWidth(Double(width))
        let renderer = MermaidRenderer.shared
        if let hit = renderer.cached(source: source, dark: dark, width: w, scale: scale) {
            phase = .drawn(hit)
            return
        }
        phase = .waiting
        switch await renderer.draw(source: source, dark: dark, width: w, scale: scale) {
        case .success(let d): phase = .drawn(d)
        case .failure(let f): phase = .failed(f.message)
        }
    }
}

/// A diagram full screen: pinch to zoom and pan the SVG (in a web view with
/// JavaScript off and every load blocked), Copy source, Share image, Save to
/// Photos and Show source.
struct MermaidScreen: View {
    let source: String
    let drawing: MermaidRenderer.Drawing
    @Environment(\.dismiss) private var dismiss
    @Environment(\.palette) private var palette
    @Environment(\.colorScheme) private var scheme
    @State private var showSource = false
    @State private var note: String?

    var body: some View {
        NavigationStack {
            Group {
                if showSource {
                    ScrollView([.vertical, .horizontal]) {
                        Text(source).font(.system(.footnote, design: .monospaced)).foregroundStyle(palette.ink)
                            .textSelection(.enabled).padding(16)
                    }
                } else {
                    LockedSVGView(svg: drawing.svg, dark: scheme == .dark)
                        .accessibilityLabel("Diagram, \(MermaidRules.kind(source))")
                }
            }
            .background(palette.paper)
            .overlay(alignment: .bottom) {
                if let note {
                    Text(note).font(.footnote).padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.regularMaterial, in: Capsule()).padding(.bottom, 24)
                }
            }
            .navigationTitle("Diagram")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("mermaid.done")
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { UIPasteboard.general.string = source; show("Copied the source") } label: {
                            Label("Copy source", systemImage: "doc.on.doc")
                        }
                        ShareLink(item: Image(uiImage: drawing.image), preview: SharePreview("Diagram", image: Image(uiImage: drawing.image))) {
                            Label("Share image", systemImage: "square.and.arrow.up")
                        }
                        Button { save() } label: { Label("Save to Photos", systemImage: "photo.badge.arrow.down") }
                        Button { showSource.toggle() } label: {
                            Label(showSource ? "Show diagram" : "Show source", systemImage: "chevron.left.forwardslash.chevron.right")
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("Diagram actions")
                    .accessibilityIdentifier("mermaid.actions")
                }
            }
        }
    }

    private func save() {
        UIImageWriteToSavedPhotosAlbum(drawing.image, nil, nil, nil)
        show("Saved to Photos")
    }

    private func show(_ s: String) {
        note = s
        AccessibilityNotification.Announcement(s).post()
        Task { try? await Task.sleep(nanoseconds: 1_500_000_000); note = nil }
    }
}

/// The SVG shown crisp at any zoom: a web view with JavaScript off, no
/// navigation and every load blocked, holding only the SVG text.
struct LockedSVGView: UIViewRepresentable {
    let svg: String
    let dark: Bool

    func makeCoordinator() -> MermaidRenderer.Lockdown { MermaidRenderer.Lockdown() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.minimumZoomScale = 0.25
        web.scrollView.maximumZoomScale = 8
        let html = """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
        <meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.25, maximum-scale=8, user-scalable=yes">
        <style>html,body{margin:0;background:\(dark ? "#0C0C11" : "#FFFFFF")}body{display:flex;justify-content:center;padding:16px}svg{max-width:100%;height:auto}</style>
        </head><body>\(svg)</body></html>
        """
        Task { @MainActor in
            if let rules = try? await MermaidRenderer.blockingRules() { web.configuration.userContentController.add(rules) }
            context.coordinator.allowNext = true
            web.loadHTMLString(html, baseURL: nil)
        }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}
}

/// The diagram renderer (MM-1): one shared, off-screen web view running the
/// bundled Mermaid, created on first use. It has the non-persistent data
/// store, a content rule list that blocks every network load, refuses every
/// navigation and window, and runs Mermaid with `securityLevel: 'strict'` and
/// `htmlLabels: false`. Diagrams render one at a time; each result is cached
/// in memory and on disk as an image (keyed by source, theme and width) with
/// its SVG, so scrolling and reopening a chat never draw again.
@MainActor
final class MermaidRenderer {
    static let shared = MermaidRenderer()

    struct Drawing {
        let image: UIImage
        let svg: String
    }

    enum Failure: Error {
        case parse(String)
        case tooLarge
        case unavailable(String)

        var message: String {
            switch self {
            case .parse(let m): return m
            case .tooLarge: return "Too large to draw on the phone"
            case .unavailable(let m): return "The diagram couldn’t be drawn: \(m)"
            }
        }
    }

    /// The bundled Mermaid's version (vendor/mermaid/pin.json), part of every cache key.
    static let version: String = {
        guard let url = Bundle.main.url(forResource: "pin", withExtension: "json", subdirectory: "mermaid"),
              let data = try? Data(contentsOf: url),
              let pin = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "unknown" }
        return pin["version"] as? String ?? "unknown"
    }()

    /// Render times in milliseconds, newest last (the Debug fixture screen shows them for the perf log).
    private(set) var timings: [Double] = []

    private var web: WKWebView?
    private var lockdown = Lockdown()
    private var tail: Task<Void, Never>?
    private let memory: NSCache<NSString, CachedDrawing> = {
        let c = NSCache<NSString, CachedDrawing>()
        c.countLimit = 120
        return c
    }()

    private final class CachedDrawing {
        let drawing: Drawing
        init(_ drawing: Drawing) { self.drawing = drawing }
    }

    private static let folder: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = caches.appendingPathComponent("mermaid", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private func key(_ source: String, _ dark: Bool, _ width: Int, _ scale: CGFloat) -> String {
        MermaidRules.cacheKey(source: source, dark: dark, width: width, version: Self.version) + "@\(Int(scale))x"
    }

    /// A drawing already made, from memory or disk.
    func cached(source: String, dark: Bool, width: Int, scale: CGFloat) -> Drawing? {
        let k = key(source, dark, width, scale)
        if let hit = memory.object(forKey: k as NSString) { return hit.drawing }
        let png = Self.folder.appendingPathComponent(k + ".png"), svg = Self.folder.appendingPathComponent(k + ".svg")
        guard let data = try? Data(contentsOf: png), let image = UIImage(data: data, scale: scale),
              let text = try? String(contentsOf: svg, encoding: .utf8) else { return nil }
        let d = Drawing(image: image, svg: text)
        memory.setObject(CachedDrawing(d), forKey: k as NSString)
        return d
    }

    /// Draw a diagram, after any already in the queue.
    func draw(source: String, dark: Bool, width: Int, scale: CGFloat) async -> Result<Drawing, Failure> {
        if let hit = cached(source: source, dark: dark, width: width, scale: scale) { return .success(hit) }
        let previous = tail
        let job = Task { @MainActor () -> Result<Drawing, Failure> in
            await previous?.value
            if let hit = self.cached(source: source, dark: dark, width: width, scale: scale) { return .success(hit) }
            return await self.render(source: source, dark: dark, width: width, scale: scale)
        }
        tail = Task { _ = await job.value }
        return await job.value
    }

    private struct TimedOut: Error {}

    private func render(source: String, dark: Bool, width: Int, scale: CGFloat) async -> Result<Drawing, Failure> {
        let started = Date()
        do {
            let web = try await webView()
            let value: Any = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any, Error>) in
                var finished = false
                web.callAsyncJavaScript("return await window.nekkoRender(source, dark, width, scale)",
                                        arguments: ["source": source, "dark": dark, "width": width, "scale": Double(scale)],
                                        in: nil, in: .page) { result in
                    guard !finished else { return }
                    finished = true
                    cont.resume(with: result)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + MermaidRules.timeout) {
                    guard !finished else { return }
                    finished = true
                    cont.resume(throwing: TimedOut())
                }
            }
            guard let out = value as? [String: Any] else { return .failure(.unavailable("no result")) }
            if let error = out["error"] as? String { return .failure(.parse(error)) }
            guard let png = out["png"] as? String, let svg = out["svg"] as? String,
                  let comma = png.firstIndex(of: ","), let data = Data(base64Encoded: String(png[png.index(after: comma)...])),
                  let image = UIImage(data: data, scale: scale) else { return .failure(.unavailable("no image")) }
            let drawing = Drawing(image: image, svg: svg)
            let k = key(source, dark, width, scale)
            memory.setObject(CachedDrawing(drawing), forKey: k as NSString)
            try? data.write(to: Self.folder.appendingPathComponent(k + ".png"), options: .atomic)
            try? svg.write(to: Self.folder.appendingPathComponent(k + ".svg"), atomically: true, encoding: .utf8)
            timings.append(Date().timeIntervalSince(started) * 1000)
            return .success(drawing)
        } catch is TimedOut {
            // A runaway render keeps the web view busy: start a fresh one for the next diagram.
            teardown()
            return .failure(.tooLarge)
        } catch {
            return .failure(.unavailable(error.localizedDescription))
        }
    }

    private func teardown() {
        web?.stopLoading()
        web?.removeFromSuperview()
        web = nil
    }

    /// For the Debug fixture screen: whether the renderer's page can reach the network (it must not).
    func networkProbe() async -> String {
        guard let web = try? await webView() else { return "renderer unavailable" }
        let js = "try { await fetch('https://example.com/', { cache: 'no-store' }); return 'reached'; } catch (e) { return 'blocked'; }"
        let r = try? await web.callAsyncJavaScript(js, arguments: [:], in: nil, contentWorld: .page)
        return (r as? String) ?? "blocked"
    }

    // MARK: The locked web view

    private func webView() async throws -> WKWebView {
        if let web { return web }
        guard let url = Bundle.main.url(forResource: "mermaid.min", withExtension: "js", subdirectory: "mermaid"),
              let script = try? String(contentsOf: url, encoding: .utf8) else {
            throw NSError(domain: "Mermaid", code: 1, userInfo: [NSLocalizedDescriptionKey: "Mermaid isn’t in this build."])
        }
        let rules = try await Self.blockingRules()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(rules)
        config.userContentController.addUserScript(WKUserScript(source: script + "\n;" + Self.bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        let web = WKWebView(frame: CGRect(x: -4000, y: 0, width: 1024, height: 768), configuration: config)
        web.navigationDelegate = lockdown
        web.uiDelegate = lockdown
        web.isUserInteractionEnabled = false
        web.accessibilityElementsHidden = true
        // In a window but off-screen, so WebKit doesn't throttle a page it thinks nobody sees.
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow }
        window?.addSubview(web)
        window?.sendSubviewToBack(web)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lockdown.loaded = { cont.resume(with: $0) }
            lockdown.allowNext = true
            web.loadHTMLString(Self.page, baseURL: nil)
        }
        self.web = web
        return web
    }

    /// Blocks every load except the page's own `data:` images (an SVG drawn to a canvas).
    static func blockingRules() async throws -> WKContentRuleList {
        let json = """
        [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}}]
        """
        guard let list = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "nekko.mermaid.block-network", encodedContentRuleList: json) else {
            throw NSError(domain: "Mermaid", code: 2, userInfo: [NSLocalizedDescriptionKey: "The network block didn’t compile."])
        }
        return list
    }

    static let page = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'">
    </head><body></body></html>
    """

    /// Renders with Mermaid, then draws the SVG onto a canvas at the bubble's width and returns both.
    static let bridge = """
    window.nekkoCount = 0;
    window.nekkoRender = async function (source, dark, width, scale) {
      const m = globalThis.mermaid;
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default',
        htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 50000, suppressErrorRendering: true,
        fontFamily: '-apple-system, system-ui, sans-serif' });
      let svg;
      try {
        await m.parse(source);
        svg = (await m.render('nekko' + (++window.nekkoCount), source)).svg;
      } catch (e) {
        const text = String((e && (e.message || e.str)) || e);
        const line = text.split('\\n').map(l => l.trim()).find(l => l.length) || 'Mermaid couldn’t read this diagram.';
        return { error: line.slice(0, 240) };
      }
      const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      const vb = (el.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
      let w = vb[2], h = vb[3];
      if (!(w > 0 && h > 0)) { w = 800; h = 600; }
      el.setAttribute('width', String(w));
      el.setAttribute('height', String(h));
      el.removeAttribute('style');
      const fixed = new XMLSerializer().serializeToString(el);
      const drawW = Math.min(width, w * 1.25);
      const drawH = h * drawW / w;
      let s = scale;
      while (drawW * s * drawH * s > 16000000 && s > 0.5) s -= 0.5;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(fixed);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(drawW * s));
      c.height = Math.max(1, Math.round(drawH * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { svg: fixed, png: c.toDataURL('image/png') };
    };
    """

    /// Refuses every navigation but the one page load asked for, and every new window.
    @MainActor
    final class Lockdown: NSObject, WKNavigationDelegate, WKUIDelegate {
        var allowNext = false
        var loaded: ((Result<Void, Error>) -> Void)?

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if allowNext && action.request.url?.absoluteString == "about:blank" {
                allowNext = false
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded?(.success(()))
            loaded = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loaded?(.failure(error))
            loaded = nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loaded?(.failure(error))
            loaded = nil
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}
