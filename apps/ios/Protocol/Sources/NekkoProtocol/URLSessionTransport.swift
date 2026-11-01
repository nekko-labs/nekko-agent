import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// `URLSessionWebSocketTask` transport. Each connection gets its own
/// ephemeral session (no cookies, no cache) so a dropped socket can't take a
/// sibling down, and pings every 25 s so a dead path is noticed quickly.
/// `ws://` is subject to App Transport Security: the app allows it only toward
/// `ts.net` and local networks (see `Info.plist` and `RelayRoute`).
public struct URLSessionTransport: WsTransport {
    public var pingInterval: TimeInterval

    public init(pingInterval: TimeInterval = 25) { self.pingInterval = pingInterval }

    public func open(url: URL, handlers: WsHandlers) throws -> WsConnection {
        guard let scheme = url.scheme?.lowercased(), scheme == "ws" || scheme == "wss" else {
            throw RelayError("Relay address must start with ws:// or wss://")
        }
        return URLSessionConnection(url: url, handlers: handlers, pingInterval: pingInterval)
    }

    /// The close reason for a failed socket. A name that doesn't resolve gets
    /// `RelayStatus.hostNotFound` whatever the phone's language, so the app can
    /// say the paired address is gone instead of "Connecting…" forever.
    static func reason(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCannotFindHost || ns.code == NSURLErrorDNSLookupFailed {
            return RelayStatus.hostNotFound
        }
        return error.localizedDescription
    }
}

final class URLSessionConnection: NSObject, WsConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let url: URL
    private let handlers: WsHandlers
    private let pingInterval: TimeInterval
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var open = false
    private var closed = false
    private var pingTimer: DispatchSourceTimer?

    init(url: URL, handlers: WsHandlers, pingInterval: TimeInterval) {
        self.url = url
        self.handlers = handlers
        self.pingInterval = pingInterval
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 20
        #if canImport(Darwin)
        config.waitsForConnectivity = false // fail fast; the client's backoff retries
        #endif
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        let s = URLSession(configuration: config, delegate: self, delegateQueue: q)
        let t = s.webSocketTask(with: url)
        t.maximumMessageSize = 16 * 1024 * 1024
        lock.lock()
        session = s
        task = t
        lock.unlock()
        t.resume()
        receive(t)
    }

    func send(_ text: String) -> Bool {
        lock.lock()
        let t = open && !closed ? task : nil
        lock.unlock()
        guard let t else { return false }
        t.send(.string(text)) { [weak self] error in
            if let error { self?.finish(1006, error.localizedDescription) }
        }
        return true
    }

    func close(code: Int, reason: String) {
        lock.lock()
        let t = task
        lock.unlock()
        let c = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        t?.cancel(with: c, reason: Data(reason.prefix(120).utf8))
        finish(code, reason)
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.string(let s)):
                self.handlers.onMessage(s)
                self.receive(t)
            case .success(.data(let d)):
                if let s = String(data: d, encoding: .utf8) { self.handlers.onMessage(s) }
                self.receive(t)
            case .success:
                self.receive(t)
            case .failure(let e):
                // A clean close arrives through didCloseWith first; this is a lost path.
                let code = t.closeCode == .invalid ? 1006 : t.closeCode.rawValue
                let reason = t.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? URLSessionTransport.reason(e)
                self.finish(code, reason)
            }
        }
    }

    private func startPings(_ t: URLSessionWebSocketTask) {
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        timer.setEventHandler { [weak self] in
            guard let me = self else { return }
            t.sendPing { error in
                if let error { me.finish(1006, error.localizedDescription) }
            }
        }
        lock.lock()
        pingTimer = timer
        lock.unlock()
        timer.resume()
    }

    /// Exactly one `onClosed` per connection.
    private func finish(_ code: Int, _ reason: String) {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let timer = pingTimer
        pingTimer = nil
        let t = task
        let s = session
        lock.unlock()
        timer?.cancel()
        t?.cancel()
        s?.invalidateAndCancel()
        handlers.onClosed(code, reason)
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock()
        open = true
        let done = closed
        lock.unlock()
        guard !done else { return }
        startPings(webSocketTask)
        handlers.onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(closeCode.rawValue, reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(1006, error.map(URLSessionTransport.reason) ?? "connection closed")
    }
}
