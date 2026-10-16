import Foundation

/// Connection state, same meanings as `apps/mobile/src/lib/relayClient.ts` and Android's `RelayState`.
public enum RelayState: String, Sendable, Equatable {
    /// Not started, or closed by the app.
    case idle
    /// Dialing the relay, or waiting for the agent's welcome.
    case connecting
    /// Welcomed by the agent; requests flow.
    case online
    /// Relay reachable but the computer isn't connected to it.
    case offline
    /// The computer refused this device. Terminal until re-paired.
    case denied
}

public enum DenyReason: String, Sendable, Equatable {
    case unknownDevice = "unknown-device", revoked, badCode = "bad-code", invalid, kicked, badKey = "bad-key"
    public static func parse(_ s: String?) -> DenyReason { s.flatMap(DenyReason.init(rawValue:)) ?? .invalid }
}

public struct WelcomedDevice: Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
}

public struct RelayStatus: Equatable, Sendable {
    public let state: RelayState
    public let detail: String?
    public let denied: DenyReason?

    public init(_ state: RelayState, detail: String? = nil, denied: DenyReason? = nil) {
        self.state = state
        self.detail = detail
        self.denied = denied
    }
}

public struct RelayError: Error, Equatable, LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// One WebSocket. Created idle by `WsTransport.open`; `start()` dials, and no
/// callback fires before it. `send` returns false when the socket is not open
/// (the frame is dropped).
public protocol WsConnection: AnyObject, Sendable {
    func start()
    @discardableResult func send(_ text: String) -> Bool
    func close(code: Int, reason: String)
}

/// Callbacks for one connection. `onClosed` is called exactly once, for a clean close or a failure.
public struct WsHandlers: Sendable {
    public let onOpen: @Sendable () -> Void
    public let onMessage: @Sendable (String) -> Void
    public let onClosed: @Sendable (Int, String) -> Void

    public init(onOpen: @escaping @Sendable () -> Void, onMessage: @escaping @Sendable (String) -> Void,
                onClosed: @escaping @Sendable (Int, String) -> Void) {
        self.onOpen = onOpen
        self.onMessage = onMessage
        self.onClosed = onClosed
    }
}

/// A minimal WebSocket the client drives: `URLSessionTransport` in the app, fakes in tests.
public protocol WsTransport: Sendable {
    func open(url: URL, handlers: WsHandlers) throws -> WsConnection
}

public struct RelayConfig: Sendable {
    public var relayUrl: String
    public var room: String
    /// Pairing secret: relay transport auth (the relay hashes it; never decrypts).
    public var key: String
    /// AES key derived from (key, room) with `E2E.deriveKey`.
    public var keyBytes: Data
    public var deviceId: String
    public var deviceName: String
    /// One-time enrollment code from the QR; dropped once welcomed.
    public var pairCode: String?
    public var platform: String
    /// The iPhone app's bundle id, so a relay serving several apps pushes to the right one.
    public var app: String?
    public var handshakeTimeout: TimeInterval = 15
    public var requestTimeout: TimeInterval = 120
    /// Backoff knobs; tests shrink them.
    public var retryBase: TimeInterval = 1
    public var retryMax: TimeInterval = 30
    public var offlinePoll: TimeInterval = 15

    public init(relayUrl: String, room: String, key: String, keyBytes: Data, deviceId: String, deviceName: String,
                pairCode: String? = nil, platform: String = "ios") {
        self.relayUrl = relayUrl
        self.room = room
        self.key = key
        self.keyBytes = keyBytes
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.pairCode = pairCode
        self.platform = platform
    }

    /// `<relay>/relay?role=client&room=…&key=…`
    public var dialURL: URL? {
        var base = relayUrl
        while base.hasSuffix("/") { base.removeLast() }
        guard var c = URLComponents(string: base + "/relay") else { return nil }
        c.queryItems = [URLQueryItem(name: "role", value: "client"), URLQueryItem(name: "room", value: room),
                        URLQueryItem(name: "key", value: key)]
        // URLComponents leaves `+` alone in queries; the relay reads it as a space.
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.url
    }
}

/// Relay v2 client: the phone side of `packages/host/src/relay.ts`.
///
/// Connects as `role=client`, completes the sealed HELLO handshake (device id +
/// optional one-time pairing code), then speaks the host's request protocol:
/// `{type:'req', id, channel, args}` out, `{type:'res'}` and
/// `{type:'event', channel, payload}` back, all E2E-sealed. Reconnects with
/// backoff until closed. A port of Android's `RelayClient.kt` with the same
/// state machine (pair code never resent, kick 4001 / bad key are terminal,
/// an offline computer is polled at a fixed pace).
public final class RelayClient: @unchecked Sendable {
    public let config: RelayConfig
    private let transport: WsTransport
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "nekko.relay")

    // Guarded by `lock`.
    private var conn: WsConnection?
    private var welcomed = false
    private var stopped = true
    private var retry = 0
    private var retryGeneration = 0
    private var retryPending = false
    private var pairCode: String?
    private var nextId: Int64 = 1
    private var pending: [Int64: CheckedContinuation<JSONValue, Error>] = [:]
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextWaiter = 0
    private var _status = RelayStatus(.idle)

    /// Status changes, events and the welcome, delivered on a background queue in order.
    private let handlerLock = NSLock()
    private var _onStatus: (@Sendable (RelayStatus) -> Void)?
    private var _onEvent: (@Sendable (String, JSONValue) -> Void)?
    private var _onWelcome: (@Sendable (WelcomedDevice) -> Void)?

    public init(config: RelayConfig, transport: WsTransport) {
        self.config = config
        self.transport = transport
        self.pairCode = config.pairCode
    }

    public func setHandlers(onStatus: (@Sendable (RelayStatus) -> Void)? = nil,
                            onEvent: (@Sendable (String, JSONValue) -> Void)? = nil,
                            onWelcome: (@Sendable (WelcomedDevice) -> Void)? = nil) {
        handlerLock.lock()
        _onStatus = onStatus
        _onEvent = onEvent
        _onWelcome = onWelcome
        handlerLock.unlock()
    }

    public var status: RelayStatus { locked { _status } }
    public var state: RelayState { status.state }

    // MARK: - Lifecycle

    public func connect() {
        let start: Bool = locked {
            guard stopped else { return false }
            stopped = false
            retry = 0
            return true
        }
        if start { dial() }
    }

    public func close() {
        let c: WsConnection? = locked {
            stopped = true
            cancelRetryLocked()
            let c = conn
            conn = nil
            welcomed = false
            return c
        }
        c?.close(code: 1000, reason: "closed by app")
        failPending("disconnected")
        setStatus(RelayStatus(.idle))
    }

    /// Reconnect now instead of waiting out the backoff (app foregrounded).
    public func nudge() {
        let go: Bool = locked {
            if stopped || _status.state == .denied || _status.state == .online { return false }
            cancelRetryLocked()
            retry = 0
            return conn == nil
        }
        if go { dial() }
    }

    /// The phone moved to another network: the open socket, if any, is bound
    /// to the old one and would only be noticed dead at the next ping. Drop it
    /// and dial again now, even if it looks online.
    public func reconnect() {
        let result: (go: Bool, old: WsConnection?) = locked {
            if stopped || _status.state == .denied { return (false, nil) }
            cancelRetryLocked()
            retry = 0
            let c = conn
            conn = nil
            welcomed = false
            return (true, c)
        }
        guard result.go else { return }
        if let old = result.old {
            // conn is already nil, so this socket's late onClosed is ignored.
            old.close(code: 1000, reason: "network changed")
            failPending("connection lost")
        }
        dial()
    }

    // MARK: - Requests

    /// Call a host IPC channel. Waits (briefly) for the handshake if needed.
    /// `chat:send` replies only when the whole turn is over: pass hours.
    public func call(_ channel: String, _ args: [JSONValue] = [], timeout: TimeInterval? = nil) async throws -> JSONValue {
        try await awaitReady()
        let id: Int64 = locked {
            let id = nextId
            nextId += 1
            return id
        }
        let frame: JSONValue = ["type": "req", "id": .int(id), "channel": .string(channel), "args": .array(args)]
        let limit = timeout ?? config.requestTimeout
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<JSONValue, Error>) in
            locked { pending[id] = cont }
            guard sendSealed(frame) else {
                takePending(id)?.resume(throwing: RelayError("Could not reach your computer."))
                return
            }
            queue.asyncAfter(deadline: .now() + limit) { [weak self] in
                self?.takePending(id)?.resume(throwing: RelayError("\(channel): timed out"))
            }
        }
    }

    /// Hand the relay this phone's push token (content-free "finished" pings).
    /// An unsealed control frame: the relay itself keeps the token.
    public func registerPush(token: String) async throws {
        try await awaitReady()
        var frame: JSONValue = ["type": "register-push", "token": .string(token), "platform": .string(config.platform),
                                "deviceId": .string(config.deviceId)]
        if let app = config.app, case .object(var o) = frame { o["app"] = .string(app); frame = .object(o) }
        guard let c = locked({ conn }), c.send(frame.serialized()) else { throw RelayError("Could not reach your computer.") }
    }

    /// Hand the relay a Live Activity's ActivityKit push token under the chat's
    /// opaque tag (`E2E.activityTag`), so the computer's content-free `activity`
    /// frames can update it while iOS has suspended the app.
    public func registerActivity(tag: String, token: String) async throws {
        try await awaitReady()
        var o: [String: JSONValue] = ["type": "register-activity", "tag": .string(tag), "token": .string(token),
                                      "deviceId": .string(config.deviceId)]
        if let app = config.app { o["app"] = .string(app) }
        guard let c = locked({ conn }), c.send(JSONValue.object(o).serialized()) else { throw RelayError("Could not reach your computer.") }
    }

    private func awaitReady() async throws {
        if isReady { return }
        let (denied, isStopped) = locked { (_status.state == .denied, stopped) }
        if denied { throw RelayError("This phone is no longer paired.") }
        if isStopped { throw RelayError("Not connected.") }
        let settled = await waitForSettledStatus(timeout: config.handshakeTimeout)
        if isReady { return }
        let s = state
        if !settled { throw RelayError(s == .offline ? "Your computer is offline." : "Could not reach your computer.") }
        throw RelayError(s == .denied ? "This phone is no longer paired." : "Not connected.")
    }

    /// Resolves true when the state becomes online, denied or idle; false on timeout.
    private func waitForSettledStatus(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let id: Int? = locked {
                if [.online, .denied, .idle].contains(_status.state) { return nil }
                let id = nextWaiter
                nextWaiter += 1
                waiters[id] = cont
                return id
            }
            guard let id else { cont.resume(); return }
            queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self else { return }
                let w: CheckedContinuation<Void, Never>? = self.locked { self.waiters.removeValue(forKey: id) }
                w?.resume()
            }
        }
        return [.online, .denied, .idle].contains(state)
    }

    private var isReady: Bool { locked { welcomed && conn != nil } }

    // MARK: - Socket

    private func dial() {
        guard locked({ () -> Bool in
            if stopped { return false }
            welcomed = false
            return true
        }) else { return }
        setStatus(RelayStatus(.connecting))
        guard let url = config.dialURL else {
            scheduleRetry("bad relay address")
            return
        }
        let box = ConnBox()
        let handlers = WsHandlers(
            onOpen: { [weak self] in
                guard let self, let c = box.conn, self.isCurrent(c) else { return }
                self.hello()
            },
            onMessage: { [weak self] text in
                guard let self, let c = box.conn, self.isCurrent(c) else { return }
                self.onRaw(text)
            },
            onClosed: { [weak self] code, reason in
                guard let self, let c = box.conn else { return }
                self.onSocketClosed(c, code: code, reason: reason)
            })
        let c: WsConnection
        do {
            c = try transport.open(url: url, handlers: handlers)
        } catch {
            scheduleRetry(error.localizedDescription)
            return
        }
        box.set(c)
        let keep: Bool = locked {
            if stopped { return false }
            conn = c
            return true
        }
        // Published before it dials, so every callback finds it current.
        if keep { c.start() }
    }

    private func isCurrent(_ c: WsConnection) -> Bool { locked { conn === c } }

    private func onSocketClosed(_ c: WsConnection, code: Int, reason: String) {
        let mine: Bool = locked {
            guard conn === c else { return false }
            conn = nil
            welcomed = false
            return true
        }
        guard mine else { return }
        failPending("connection lost")
        if locked({ stopped }) || state == .denied { return }
        let r = reason.lowercased()
        if code == 4001 {
            deny(.kicked)
        } else if code == 1008 && r.contains("bad pairing key") {
            deny(.badKey)
        } else if code == 1008 && r.contains("agent offline") {
            setStatus(RelayStatus(.offline))
            scheduleRetry(nil, offline: true)
        } else {
            scheduleRetry(reason.trimmingCharacters(in: .whitespaces).isEmpty ? "closed (\(code))" : reason)
        }
    }

    private func hello() {
        var o: [String: JSONValue] = ["type": "hello", "deviceId": .string(config.deviceId), "name": .string(config.deviceName),
                                      "platform": .string(config.platform)]
        if let code = locked({ pairCode }) { o["pair"] = .string(code) }
        sendSealed(.object(o))
    }

    @discardableResult
    private func sendSealed(_ frame: JSONValue) -> Bool {
        guard let c = locked({ conn }), let sealed = try? E2E.seal(key: config.keyBytes, value: frame) else { return false }
        return c.send(JSONValue.object(["enc": .string(sealed)]).serialized())
    }

    private func onRaw(_ raw: String) {
        guard let env = try? JSONValue.parse(raw), env.object != nil else { return }
        if let enc = env.str("enc") {
            // Wrong key or tampered: drop silently, like the agent does.
            guard let frame = try? E2E.open(key: config.keyBytes, blob: enc), frame.object != nil else { return }
            onFrame(frame)
            return
        }
        switch env.str("type") {
        case "agent-offline":
            locked { welcomed = false }
            setStatus(RelayStatus(.offline))
        case "agent-online":
            if !locked({ welcomed }) {
                // The computer (re)joined after us: repeat the handshake.
                setStatus(RelayStatus(.connecting))
                hello()
            }
        default:
            break
        }
    }

    private func onFrame(_ frame: JSONValue) {
        switch frame.str("type") {
        case "welcome":
            locked {
                welcomed = true
                retry = 0
                pairCode = nil // enrollment done; never resend the code
            }
            let d = frame["device"]
            setStatus(RelayStatus(.online))
            let device = WelcomedDevice(id: d?.str("id") ?? config.deviceId, name: d?.str("name") ?? config.deviceName,
                                        platform: d?.str("platform") ?? config.platform)
            emit { $0._onWelcome?(device) }
        case "denied":
            deny(.parse(frame.str("reason")))
        case "res":
            guard let id = frame.long("id"), let p = takePending(id) else { return }
            if let err = frame["error"], !err.isNull {
                p.resume(throwing: RelayError(err.string ?? err.serialized()))
            } else {
                p.resume(returning: frame["result"] ?? .null)
            }
        case "event":
            guard let ch = frame.str("channel") else { return }
            let payload = frame["payload"] ?? .null
            emit { $0._onEvent?(ch, payload) }
        default:
            break
        }
    }

    private func deny(_ reason: DenyReason) {
        let c: WsConnection? = locked {
            welcomed = false
            stopped = true
            cancelRetryLocked()
            let c = conn
            conn = nil
            return c
        }
        failPending("This phone is no longer paired.")
        c?.close(code: 1000, reason: "denied")
        setStatus(RelayStatus(.denied, detail: reason.rawValue, denied: reason))
    }

    private func scheduleRetry(_ detail: String?, offline: Bool = false) {
        let plan: (gen: Int, delay: TimeInterval)? = locked {
            if stopped { return nil }
            // 1s, 2s, 4s … capped; an offline computer is polled at a fixed pace.
            let delay = offline ? config.offlinePoll : min(config.retryMax, config.retryBase * pow(2, Double(min(retry, 20))))
            if !offline { retry += 1 }
            retryGeneration += 1
            retryPending = true
            return (retryGeneration, delay)
        }
        guard let plan else { return }
        if !offline { setStatus(RelayStatus(.connecting, detail: detail)) }
        queue.asyncAfter(deadline: .now() + plan.delay) { [weak self] in
            guard let self else { return }
            let go: Bool = self.locked {
                guard self.retryPending, self.retryGeneration == plan.gen else { return false }
                self.retryPending = false
                return true
            }
            if go { self.dial() }
        }
    }

    private func cancelRetryLocked() {
        retryGeneration += 1
        retryPending = false
    }

    private func takePending(_ id: Int64) -> CheckedContinuation<JSONValue, Error>? {
        locked { pending.removeValue(forKey: id) }
    }

    private func failPending(_ message: String) {
        let all: [CheckedContinuation<JSONValue, Error>] = locked {
            let all = Array(pending.values)
            pending.removeAll()
            return all
        }
        all.forEach { $0.resume(throwing: RelayError(message)) }
    }

    private func setStatus(_ s: RelayStatus) {
        let woken: [CheckedContinuation<Void, Never>] = locked {
            _status = s
            guard [.online, .denied, .idle].contains(s.state) else { return [] }
            let w = Array(waiters.values)
            waiters.removeAll()
            return w
        }
        woken.forEach { $0.resume() }
        emit { $0._onStatus?(s) }
    }

    /// Deliver to handlers in order, off the caller's stack and outside the state lock.
    private func emit(_ body: @escaping @Sendable (RelayClient) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.handlerLock.lock()
            defer { self.handlerLock.unlock() }
            body(self)
        }
    }

    @discardableResult
    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

/// Lets a socket's callbacks find their own connection.
private final class ConnBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _conn: WsConnection?
    var conn: WsConnection? {
        lock.lock()
        defer { lock.unlock() }
        return _conn
    }

    func set(_ c: WsConnection) {
        lock.lock()
        _conn = c
        lock.unlock()
    }
}
