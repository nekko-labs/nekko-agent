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
    /// The computer's owner turned off phones from before protocol 4 (no
    /// challenge in the HELLO): this app must be updated.
    case updateRequired = "update-required"
    public static func parse(_ s: String?) -> DenyReason { s.flatMap(DenyReason.init(rawValue:)) ?? .invalid }
}

public struct WelcomedDevice: Equatable, Sendable {
    public let id: String
    public let name: String
    public let platform: String
    /// The computer's phone protocol version (`PhoneProtocol`); 1 when it sent none.
    public var protocolVersion: Int = 1

    public init(id: String, name: String, platform: String, protocolVersion: Int = 1) {
        self.id = id
        self.name = name
        self.platform = platform
        self.protocolVersion = protocolVersion
    }
}

public struct RelayStatus: Equatable, Sendable {
    public let state: RelayState
    public let detail: String?
    public let denied: DenyReason?
    /// The relay address in use or being dialed (one of the computer's routes).
    public let route: String?

    public init(_ state: RelayState, detail: String? = nil, denied: DenyReason? = nil, route: String? = nil) {
        self.state = state
        self.detail = detail
        self.denied = denied
        self.route = route
    }
}

public struct RelayError: Error, Equatable, LocalizedError, Sendable {
    public let message: String
    /// The computer answered with this error (it refused the call). False when
    /// the call never got an answer (offline, timed out, connection lost), so
    /// it may or may not have arrived.
    public let fromComputer: Bool
    public init(_ message: String, fromComputer: Bool = false) {
        self.message = message
        self.fromComputer = fromComputer
    }
    public var errorDescription: String? { message }
    public static func == (a: RelayError, b: RelayError) -> Bool { a.message == b.message }
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
    /// Other addresses of the same relay (the pairing link's `alt` routes).
    /// With any, the client picks among them (`RouteSupervisor`).
    public var alternates: [String] = []
    public var routeRules = RouteRules()
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
    /// How long an open socket waits for the computer's sealed challenge
    /// before it takes the computer for one from before protocol 4 and sends
    /// a legacy HELLO (never once this client has seen a challenge).
    public var challengeWait: TimeInterval = 3
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

    /// Every address of the relay, the paired one first.
    public var routes: [String] { [relayUrl] + alternates }

    /// `<relay>/relay?role=client&room=…&key=…`
    public var dialURL: URL? { dialURL(for: relayUrl) }

    /// The same, for one of the relay's other addresses.
    public func dialURL(for relay: String) -> URL? {
        var base = relay
        while base.hasSuffix("/") { base.removeLast() }
        guard var c = URLComponents(string: base + "/relay") else { return nil }
        c.queryItems = [URLQueryItem(name: "role", value: "client"), URLQueryItem(name: "room", value: room),
                        URLQueryItem(name: "key", value: key)]
        // URLComponents leaves `+` alone in queries; the relay reads it as a space.
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.url
    }
}

/// Relay v2 client: the phone side of the computer's relay agent (`crates/nekko-remote/src/agent.rs`).
///
/// Connects as `role=client`, then completes the sealed handshake (phone
/// protocol 4, replay protection):
///
/// 1. The computer seals `{type:'challenge', challenge}` (a fresh nonce) to the
///    connection when the relay announces it, and may send another at any
///    time on the same socket, which restarts the handshake.
/// 2. The phone answers each challenge once with the sealed HELLO
///    `{type:'hello', deviceId, name, platform, protocol: 4, challenge, pair?}`
///    (the one-time pairing code only while enrolling).
/// 3. After the welcome every request is `{type:'req', id, seq, challenge,
///    channel, args, proof?}`: `seq` starts at 1 after each welcome and goes up
///    by one per request, and `challenge` is the nonce the welcomed HELLO
///    answered. The computer drops a request with a stale seq or the wrong
///    challenge and challenges the connection again, so a recorded frame
///    replayed by the relay is worthless.
///
/// A computer from before protocol 4 never challenges: after `challengeWait`
/// without one the phone sends a legacy HELLO (`protocol: 3`, no challenge)
/// and its requests carry `seq` only. Once this client has seen a challenge it
/// never falls back; a socket that gets none is treated as a failed route.
///
/// Replies come back as `{type:'res'}` and `{type:'event', channel, payload}`,
/// all E2E-sealed. Reconnects with backoff until closed. A port of Android's
/// `RelayClient.kt` with the same state machine (pair code never resent, kick
/// 4001 / bad key are terminal, an offline computer is polled at a fixed pace).
///
/// A computer can have several addresses for its relay (TASKS.md IO-20): the
/// client dials the one `RouteSupervisor` picks, leaves it at once when it
/// fails, and while on a worse route probes the better one (`RouteProber`,
/// `/healthz`) and moves back at a quiet moment once the hysteresis allows.
public final class RelayClient: @unchecked Sendable {
    public let config: RelayConfig
    private let transport: WsTransport
    private let prober: RouteProber?
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "nekko.relay")
    /// Serializes numbering and sending requests, so seqs reach the socket in order.
    private let sendLock = NSLock()

    // Guarded by `lock`.
    private var conn: WsConnection?
    private var welcomed = false
    private var stopped = true
    private var retry = 0
    private var retryGeneration = 0
    private var retryPending = false
    private var pairCode: String?
    private var nextId: Int64 = 1
    /// The handshake on the current socket: a HELLO went out (and its welcome may be awaited).
    private var helloSent = false
    /// The nonce the last HELLO answered; nil for a legacy HELLO. Requests carry it once welcomed.
    private var challenge: String?
    /// The last request's seq since the welcome (the next request carries seq + 1).
    private var seq: Int64 = 0
    /// This client received a challenge at some point: never fall back to a legacy HELLO again.
    private var sawChallenge = false
    /// Bumped to cancel a pending wait for the challenge.
    private var challengeGeneration = 0
    private var pending: [Int64: CheckedContinuation<JSONValue, Error>] = [:]
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextWaiter = 0
    private var _status = RelayStatus(.idle)
    private var routes: RouteSupervisor
    /// One probe loop at a time; bumped to stop the running one.
    private var probeGeneration = 0
    private var probing = false

    /// Status changes, events and the welcome, delivered on a background queue in order.
    private let handlerLock = NSLock()
    private var _onStatus: (@Sendable (RelayStatus) -> Void)?
    private var _onEvent: (@Sendable (String, JSONValue) -> Void)?
    private var _onWelcome: (@Sendable (WelcomedDevice) -> Void)?
    private var _onControl: (@Sendable (RelayControl) -> Void)?

    public init(config: RelayConfig, transport: WsTransport, prober: RouteProber? = nil,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.config = config
        self.transport = transport
        self.prober = prober
        self.now = now
        self.pairCode = config.pairCode
        routes = RouteSupervisor(routes: config.routes, rules: config.routeRules, now: now())
    }

    /// The address in use (or being dialed).
    public var route: String { locked { routes.url } }

    /// The phone moved to another network: start again from the best route
    /// for it (the LAN only on Wi-Fi), and dial a fresh socket now.
    public func networkChanged(_ path: NetworkPath) {
        locked { _ = routes.pathChanged(path, now: now()) }
        reconnect()
    }

    /// Where the phone is, without having moved (the first network report, or
    /// before connecting): dial again only if that changes the route.
    public func setNetworkPath(_ path: NetworkPath) {
        let moved: Bool = locked {
            guard path != routes.path else { return false }
            return routes.pathChanged(path, now: now()) && !stopped
        }
        if moved { reconnect() }
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

    /// Frames from the relay itself: whether it can push, and dismissals.
    public func setControlHandler(_ f: (@Sendable (RelayControl) -> Void)?) {
        handlerLock.lock()
        _onControl = f
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
            stopProbesLocked()
            resetHandshakeLocked()
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
        try await call(channel, args, proof: nil, timeout: timeout)
    }

    /// `call`, with a signed Change proof beside the args (`ChangeProof`, IO-33).
    public func call(_ channel: String, _ args: [JSONValue], proof: JSONValue?, timeout: TimeInterval?) async throws -> JSONValue {
        try await awaitReady()
        let id: Int64 = locked {
            let id = nextId
            nextId += 1
            return id
        }
        var fields: [String: JSONValue] = ["type": "req", "id": .int(id), "channel": .string(channel), "args": .array(args)]
        if let proof { fields["proof"] = proof }
        let limit = timeout ?? config.requestTimeout
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<JSONValue, Error>) in
            locked { pending[id] = cont }
            guard sendRequest(fields) else {
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
    public func registerPush(token: String) async throws { try await registerPush(token: token, kinds: nil) }

    /// `kinds`: the pushes this phone wants (`PushKind` raw values); nil asks for all.
    /// The relay answers with `RelayControl.pushRegistered`.
    public func registerPush(token: String, kinds: [String]?) async throws {
        try await awaitReady()
        var frame: JSONValue = ["type": "register-push", "token": .string(token), "platform": .string(config.platform),
                                "deviceId": .string(config.deviceId)]
        if let app = config.app, case .object(var o) = frame { o["app"] = .string(app); frame = .object(o) }
        if let kinds, case .object(var o) = frame { o["kinds"] = .array(kinds.map { .string($0) }); frame = .object(o) }
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

    private func dial(detail: String? = nil) {
        let plan: (route: String, early: Bool)? = locked {
            if stopped { return nil }
            welcomed = false
            resetHandshakeLocked()
            stopProbesLocked()
            let route = routes.routeToDial(now: now())
            return (route, routes.fallbackExists)
        }
        guard let plan else { return }
        setStatus(RelayStatus(.connecting, detail: detail, route: plan.route))
        guard let url = config.dialURL(for: plan.route) else {
            routeFailed("bad relay address")
            return
        }
        let box = ConnBox()
        let handlers = WsHandlers(
            onOpen: { [weak self] in
                guard let self, let c = box.conn, self.isCurrent(c) else { return }
                box.markOpen()
                self.awaitChallenge(c)
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
            routeFailed(error.localizedDescription)
            return
        }
        box.set(c)
        let keep: Bool = locked {
            if stopped { return false }
            conn = c
            return true
        }
        // Published before it dials, so every callback finds it current.
        guard keep else { return }
        c.start()
        // A LAN address on another Wi-Fi doesn't refuse, it hangs: with a
        // fallback behind it, give it a few seconds, not the transport's 20.
        if plan.early {
            queue.asyncAfter(deadline: .now() + config.routeRules.openTimeout) { [weak self] in
                guard let self, !box.isOpen else { return }
                let mine: Bool = self.locked {
                    guard self.conn === c else { return false }
                    self.conn = nil
                    return true
                }
                guard mine else { return }
                c.close(code: 1000, reason: "route timed out")
                self.routeFailed("\(Pairing.relayHost(plan.route)) didn’t answer")
            }
        }
    }

    /// The route in use didn't open or dropped: with another, move to it (at
    /// once when it isn't cooling down); else back off as before.
    private func routeFailed(_ detail: String?) {
        let next: (changed: Bool, ready: Bool) = locked {
            if stopped { return (false, false) }
            return routes.failed(now: now())
        }
        if next.changed && next.ready {
            locked { cancelRetryLocked() }
            dial(detail: detail)
        } else {
            scheduleRetry(detail)
        }
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
            // The relay answered on this route: the computer is away, not the path.
            setStatus(RelayStatus(.offline, route: route))
            scheduleRetry(nil, offline: true)
        } else {
            routeFailed(reason.trimmingCharacters(in: .whitespaces).isEmpty ? "closed (\(code))" : reason)
        }
    }

    // MARK: - Handshake

    /// Forget the current socket's handshake (a new socket, closed, or the computer left).
    private func resetHandshakeLocked() {
        helloSent = false
        challenge = nil
        seq = 0
        challengeGeneration += 1
    }

    /// The socket opened, or the computer (re)joined: wait for its challenge.
    /// None within `challengeWait` means a computer from before protocol 4
    /// (legacy HELLO), unless this client has seen a challenge before: then
    /// the socket is dropped and dialed again, so the relay announces a fresh
    /// connection to the computer.
    private func awaitChallenge(_ c: WsConnection) {
        let gen: Int = locked {
            challengeGeneration += 1
            return challengeGeneration
        }
        queue.asyncAfter(deadline: .now() + config.challengeWait) { [weak self] in
            guard let self else { return }
            let next: (legacy: Bool, drop: Bool) = self.locked {
                guard self.challengeGeneration == gen, self.conn === c, !self.stopped, !self.welcomed, !self.helloSent else {
                    return (false, false)
                }
                if self.sawChallenge {
                    self.conn = nil
                    self.resetHandshakeLocked()
                    return (false, true)
                }
                self.helloSent = true
                self.challenge = nil
                return (true, false)
            }
            if next.legacy {
                self.hello(challenge: nil)
            } else if next.drop {
                // conn is already nil, so this socket's late onClosed is ignored.
                c.close(code: 1000, reason: "no challenge")
                self.failPending("connection lost")
                self.routeFailed("\(Pairing.relayHost(self.route)) sent no handshake")
            }
        }
    }

    /// The computer refused a legacy HELLO this client sent (`update-required`):
    /// never fall back again, and hand back the socket to drop. Nil when the
    /// refused HELLO answered a challenge (then the denial stands).
    private func lockedLegacyDrop() -> WsConnection? {
        locked {
            guard helloSent, challenge == nil, let c = conn else { return nil }
            sawChallenge = true
            conn = nil
            welcomed = false
            resetHandshakeLocked()
            return c
        }
    }

    /// A sealed challenge from the computer: answer it with a HELLO. While
    /// online it means the computer reset the handshake (it refused a stale
    /// HELLO or request): not welcomed until it welcomes again, and calls in
    /// flight stay pending, since their replies may still arrive.
    private func onChallenge(_ nonce: String) {
        let wasOnline: Bool? = locked {
            if stopped || conn == nil { return nil }
            let was = welcomed
            sawChallenge = true
            challengeGeneration += 1
            welcomed = false
            seq = 0
            helloSent = true
            challenge = nonce
            return was
        }
        guard let wasOnline else { return }
        if wasOnline { setStatus(RelayStatus(.connecting)) }
        hello(challenge: nonce)
    }

    /// The sealed HELLO: protocol 4 with the challenge it answers, or a legacy
    /// HELLO (protocol 3, no challenge) for a computer that never challenges.
    private func hello(challenge nonce: String?) {
        var o: [String: JSONValue] = ["type": "hello", "deviceId": .string(config.deviceId), "name": .string(config.deviceName),
                                      "platform": .string(config.platform)]
        if let nonce {
            o["protocol"] = .int(Int64(PhoneProtocol.version))
            o["challenge"] = .string(nonce)
        } else {
            o["protocol"] = .int(Int64(PhoneProtocol.legacyVersion))
        }
        if let code = locked({ pairCode }) { o["pair"] = .string(code) }
        sendSealed(.object(o))
    }

    /// Number a request and send it, under `sendLock` so seqs leave in order.
    /// False when not welcomed (the handshake restarted) or the socket is gone.
    private func sendRequest(_ fields: [String: JSONValue]) -> Bool {
        sendLock.lock()
        defer { sendLock.unlock() }
        let next: (c: WsConnection, seq: Int64, challenge: String?)? = locked {
            guard let c = conn, welcomed else { return nil }
            seq += 1
            return (c, seq, challenge)
        }
        guard let next else { return false }
        var f = fields
        f["seq"] = .int(next.seq)
        if let ch = next.challenge { f["challenge"] = .string(ch) }
        guard let sealed = try? E2E.seal(key: config.keyBytes, value: .object(f)) else { return false }
        return next.c.send(JSONValue.object(["enc": .string(sealed)]).serialized())
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
            locked {
                welcomed = false
                resetHandshakeLocked()
            }
            setStatus(RelayStatus(.offline))
        case "agent-online":
            // The computer (re)joined after us: repeat the handshake, unless
            // its challenge already came and was answered.
            let c: WsConnection? = locked { welcomed || helloSent ? nil : conn }
            if let c {
                setStatus(RelayStatus(.connecting))
                awaitChallenge(c)
            }
        default:
            if let control = RelayControl.parse(env) { emit { $0._onControl?(control) } }
        }
    }

    private func onFrame(_ frame: JSONValue) {
        switch frame.str("type") {
        case "challenge":
            guard let nonce = frame.str("challenge"), !nonce.isEmpty else { return }
            onChallenge(nonce)
        case "welcome":
            locked {
                welcomed = true
                retry = 0
                seq = 0 // the first request after each welcome is seq 1
                pairCode = nil // enrollment done; never resend the code
            }
            let d = frame["device"]
            setStatus(RelayStatus(.online))
            startProbes()
            let device = WelcomedDevice(id: d?.str("id") ?? config.deviceId, name: d?.str("name") ?? config.deviceName,
                                        platform: d?.str("platform") ?? config.platform,
                                        protocolVersion: PhoneProtocol.of(welcome: frame))
            emit { $0._onWelcome?(device) }
        case "denied":
            let reason = DenyReason.parse(frame.str("reason"))
            if reason == .updateRequired, let c = lockedLegacyDrop() {
                // Our legacy HELLO raced a challenge that was slow to come:
                // this computer speaks protocol 4, so wait for its challenge
                // on a fresh socket instead of giving up.
                c.close(code: 1000, reason: "legacy refused")
                failPending("connection lost")
                routeFailed("waiting for \(Pairing.relayHost(route)) to challenge")
                return
            }
            deny(reason)
        case "res":
            guard let id = frame.long("id"), let p = takePending(id) else { return }
            if let err = frame["error"], !err.isNull {
                p.resume(throwing: RelayError(err.string ?? err.serialized(), fromComputer: true))
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
            resetHandshakeLocked()
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

    private func setStatus(_ status: RelayStatus) {
        let (s, woken): (RelayStatus, [CheckedContinuation<Void, Never>]) = locked {
            // Every status but idle names the route it is about.
            let s = status.route == nil && status.state != .idle
                ? RelayStatus(status.state, detail: status.detail, denied: status.denied, route: routes.url) : status
            _status = s
            guard [.online, .denied, .idle].contains(s.state) else { return (s, []) }
            let w = Array(waiters.values)
            waiters.removeAll()
            return (s, w)
        }
        woken.forEach { $0.resume() }
        emit { $0._onStatus?(s) }
    }

    // MARK: - Routes

    /// While online on a worse route, probe the better one every
    /// `probeInterval`; move back once the supervisor's hysteresis allows and
    /// no request is in flight (a running turn is never cut to change route).
    private func startProbes() {
        guard prober != nil else { return }
        let gen: Int? = locked {
            guard !probing, !stopped, !routes.onBest else { return nil }
            probing = true
            probeGeneration += 1
            return probeGeneration
        }
        if let gen { scheduleProbe(gen) }
    }

    private func stopProbesLocked() {
        probeGeneration += 1
        probing = false
    }

    private func scheduleProbe(_ gen: Int) {
        queue.asyncAfter(deadline: .now() + config.routeRules.probeInterval) { [weak self] in
            guard let self, let prober = self.prober else { return }
            let step: (go: Bool, target: (Int, String)?) = self.locked {
                guard self.probeGeneration == gen, !self.stopped, self.welcomed, !self.routes.onBest else {
                    if self.probeGeneration == gen { self.probing = false }
                    return (false, nil)
                }
                // The better route may still be cooling down: wait it out.
                guard let t = self.routes.probeTarget(now: self.now()) else { return (true, nil) }
                return (true, (t, self.routes.routes[t]))
            }
            guard step.go else { return }
            guard let target = step.target else { return self.scheduleProbe(gen) }
            let timeout = min(3, max(0.5, self.config.routeRules.probeInterval))
            Task {
                let ok = await prober.reachable(target.1, timeout: timeout)
                let move: Bool = self.locked {
                    guard self.probeGeneration == gen, !self.stopped else { return false }
                    self.routes.probed(target.0, ok: ok, now: self.now())
                    guard self.welcomed, self.pending.isEmpty, self.routes.shouldMoveBack(now: self.now()) else { return false }
                    self.routes.moveBack(now: self.now())
                    return true
                }
                if move {
                    self.moveRoute(detail: "Moving to \(Pairing.relayHost(target.1))")
                } else if self.locked({ self.probeGeneration == gen && !self.stopped }) {
                    self.scheduleProbe(gen)
                }
            }
        }
    }

    /// The supervisor chose another route: drop this socket and dial it.
    private func moveRoute(detail: String) {
        let old: WsConnection? = locked {
            cancelRetryLocked()
            retry = 0
            let c = conn
            conn = nil
            welcomed = false
            return c
        }
        // conn is already nil, so this socket's late onClosed is ignored.
        old?.close(code: 1000, reason: "route changed")
        failPending("connection lost")
        dial(detail: detail)
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
    private var _open = false
    var conn: WsConnection? {
        lock.lock()
        defer { lock.unlock() }
        return _conn
    }

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _open
    }

    func markOpen() {
        lock.lock()
        _open = true
        lock.unlock()
    }

    func set(_ c: WsConnection) {
        lock.lock()
        _conn = c
        lock.unlock()
    }
}
