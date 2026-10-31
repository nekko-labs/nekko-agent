import NekkoKit
import NekkoProtocol
import SwiftUI
import UIKit
import WebKit

// The isolated web view behind the preview window and the live thumbnails
// (#1095). What it shows is code the agent wrote, so it gets nothing of the
// app: a non-persistent data store, no script message handlers, no file
// access, and no network. Every load goes through the app's two schemes,
// served by the computer over the relay (`PreviewSchemeHandler`); a content
// rule list blocks everything else, and navigation off those schemes is
// cancelled (a tapped web link opens in Safari instead).

/// What a preview web view loads, and where it reads it from.
struct PreviewSource {
    let sessionId: String
    let loader: PreviewLoader
    /// The page in the app's scheme (`nekko-artifact:` or `nekko-preview:`).
    let url: URL
    /// A loopback page's link: the scheme, host and port its requests go to.
    let origin: URL?
}

enum PreviewWebState {
    case loading
    case loaded(WKWebView)
    case failed(String)
}

/// Serves `nekko-artifact:` through `artifact:read` and `nekko-preview:`
/// through `preview:fetch`, from the loader's cache when it has the bytes.
@MainActor
final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    private let sessionId: String
    private let loader: PreviewLoader
    private let origin: URL?
    /// Requests WebKit still wants an answer for.
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(sessionId: String, loader: PreviewLoader, origin: URL?) {
        self.sessionId = sessionId
        self.loader = loader
        self.origin = origin
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        running[key] = Task { [weak self] in
            guard let self else { return }
            let result: Result<PreviewLoader.Body, Error>
            do { result = .success(try await self.body(for: url)) } catch { result = .failure(error) }
            // Stopped meanwhile: answering now would raise in WebKit.
            guard self.running.removeValue(forKey: key) != nil else { return }
            switch result {
            case .success(let body):
                let type = body.charset.map { "\(body.mime); charset=\($0)" } ?? body.mime
                let headers = ["Content-Type": type, "Content-Length": String(body.data.count), "Cache-Control": "no-store"]
                let response: URLResponse = HTTPURLResponse(url: url, statusCode: body.status, httpVersion: "HTTP/1.1", headerFields: headers)
                    ?? URLResponse(url: url, mimeType: body.mime, expectedContentLength: body.data.count, textEncodingName: body.charset)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(body.data)
                urlSchemeTask.didFinish()
            case .failure(let error):
                urlSchemeTask.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }

    private func body(for url: URL) async throws -> PreviewLoader.Body {
        switch url.scheme?.lowercased() {
        case PreviewSchemes.artifact?:
            guard let path = PreviewSchemes.artifactPath(url) else { throw URLError(.badURL) }
            return try await loader.artifact(sessionId, path)
        case PreviewSchemes.preview?:
            // Only the linked origin: a page reaching for another port gets nothing.
            guard let origin, let upstream = PreviewSchemes.upstream(url, origin: origin) else { throw URLError(.unsupportedURL) }
            return try await loader.fetch(sessionId, upstream)
        default:
            throw URLError(.unsupportedURL)
        }
    }
}

@MainActor
enum PreviewWeb {
    private static var rules: WKContentRuleList?

    /// The rule list that blocks every load but the app's schemes, compiled once.
    static func ruleList() async throws -> WKContentRuleList {
        if let rules { return rules }
        let list: WKContentRuleList = try await withCheckedThrowingContinuation { done in
            WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "nekko-preview-isolation-v1", encodedContentRuleList: PreviewSchemes.contentRules
            ) { list, error in
                if let list { done.resume(returning: list) } else { done.resume(throwing: error ?? URLError(.unknown)) }
            }
        }
        rules = list
        return list
    }

    static func configuration(_ handler: PreviewSchemeHandler, rules: WKContentRuleList) -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .nonPersistent()
        c.setURLSchemeHandler(handler, forURLScheme: PreviewSchemes.artifact)
        c.setURLSchemeHandler(handler, forURLScheme: PreviewSchemes.preview)
        c.userContentController.add(rules)
        // Prototypes are interactive; nothing from the app is exposed to their scripts.
        c.defaultWebpagePreferences.allowsContentJavaScript = true
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.allowsInlineMediaPlayback = true
        c.mediaTypesRequiringUserActionForPlayback = .all
        c.dataDetectorTypes = []
        return c
    }
}

/// The isolated web view, once its rule list is ready (never before).
struct PreviewWebView: View {
    let source: PreviewSource
    var interactive = true
    var onState: (PreviewWebState) -> Void = { _ in }
    @State private var rules: WKContentRuleList?

    var body: some View {
        Group {
            if let rules {
                PreviewWebHost(source: source, rules: rules, interactive: interactive, onState: onState)
            } else {
                Color.clear
            }
        }
        .task {
            do {
                rules = try await PreviewWeb.ruleList()
            } catch {
                // Without the block list the page could reach the network: don't open it.
                onState(.failed("The preview couldn’t be isolated on this iPhone, so it wasn’t opened."))
            }
        }
    }
}

private struct PreviewWebHost: UIViewRepresentable {
    let source: PreviewSource
    let rules: WKContentRuleList
    let interactive: Bool
    let onState: (PreviewWebState) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(interactive: interactive, loopback: source.origin != nil, onState: onState) }

    func makeUIView(context: Context) -> WKWebView {
        let handler = PreviewSchemeHandler(sessionId: source.sessionId, loader: source.loader, origin: source.origin)
        let web = WKWebView(frame: .zero, configuration: PreviewWeb.configuration(handler, rules: rules))
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = interactive
        web.isUserInteractionEnabled = interactive
        if !interactive {
            web.scrollView.isScrollEnabled = false
            web.accessibilityElementsHidden = true
        }
        web.load(URLRequest(url: source.url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.onState = onState
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.stopLoading()
        web.navigationDelegate = nil
        web.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let interactive: Bool
        let loopback: Bool
        var onState: (PreviewWebState) -> Void

        init(interactive: Bool, loopback: Bool, onState: @escaping (PreviewWebState) -> Void) {
            self.loopback = loopback
            self.interactive = interactive
            self.onState = onState
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
            let scheme = url.scheme?.lowercased()
            if scheme == PreviewSchemes.artifact || scheme == PreviewSchemes.preview || url.absoluteString.hasPrefix("about:") {
                if navigationAction.targetFrame == nil {
                    // `target=_blank`: no new windows, open it here.
                    webView.load(navigationAction.request)
                    return decisionHandler(.cancel)
                }
                return decisionHandler(.allow)
            }
            decisionHandler(.cancel)
            // Off the app's schemes: only a link the user tapped leaves, and only to Safari or Mail.
            guard interactive, navigationAction.navigationType == .linkActivated, case .web(let web) = ChatLinks.classify(url) else { return }
            UIApplication.shared.open(web)
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            onState(.loading)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onState(.loaded(webView))
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            failed(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            failed(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            onState(.failed("The preview stopped. Reload to try again."))
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            nil
        }

        private func failed(_ error: Error) {
            let e = error as NSError
            // A navigation replaced by another one, or cancelled by the policy above.
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
            if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
            onState(.failed(PreviewLoader.message(error, loopback: loopback)))
        }
    }
}
