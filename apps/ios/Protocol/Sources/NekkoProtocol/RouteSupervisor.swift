import Foundation

/// The network the phone is on, as far as choosing a relay route goes.
public enum NetworkPath: String, Sendable, Equatable {
    /// Wi-Fi or Ethernet: a LAN route can work.
    case local
    /// Cellular only: a LAN address is someone else's network, skip it.
    case cellular
    /// Not known yet (before the first path update), or something else: try everything.
    case unknown
}

/// Hysteresis knobs (Orca's `mobile-endpoint-hysteresis`); tests shrink them.
public struct RouteRules: Sendable, Equatable {
    /// Successful probes of the better route in a row before moving back to it.
    public var successesToReturn = 3
    /// After a route fails, it isn't chosen again (nor probed) for this long.
    public var failureCooldown: TimeInterval = 60
    /// Stay at least this long on a route before moving back up.
    public var minDwell: TimeInterval = 30
    /// How often the better route is probed while on a worse one.
    public var probeInterval: TimeInterval = 10
    /// A dial to a route with a fallback behind it gets this long to open.
    public var openTimeout: TimeInterval = 4

    public init() {}
}

/// Which of a computer's relay addresses to dial (TASKS.md IO-20). The relay
/// on the computer listens on its LAN addresses next to the tailnet one; the
/// phone prefers the LAN when it can reach it (same Wi-Fi), else the tailnet,
/// else a hosted relay. Moving down is immediate: a route that fails is left
/// at once and cools down. Moving back up takes hysteresis, as Orca's
/// `mobile-endpoint-supervisor` does: several successful probes in a row, no
/// cooldown, and a minimum dwell on the current route. A network change
/// clears the history and starts again from the best route.
///
/// Pure and clock-free (every call takes `now`), so it is tested without
/// sockets; `RelayClient` drives it.
public struct RouteSupervisor: Sendable, Equatable {
    /// Every address, best first.
    public let routes: [String]
    public let rules: RouteRules
    /// The route in use (or being dialed), an index into `routes`.
    public private(set) var current: Int
    public private(set) var path: NetworkPath
    private var since: Date
    private var cooldownUntil: [Int: Date] = [:]
    private var successes = 0

    public init(routes: [String], rules: RouteRules = RouteRules(), path: NetworkPath = .unknown, now: Date = Date()) {
        let ordered = Self.order(routes)
        self.routes = ordered.isEmpty ? [""] : ordered
        self.rules = rules
        self.path = path
        current = 0
        since = now
        current = best(now: now) ?? 0
    }

    /// Best first: the phone's own network (LAN, loopback), then the tailnet,
    /// then the internet; ties keep the link's order. No repeats.
    public static func order(_ urls: [String]) -> [String] {
        var seen = Set<String>()
        let unique = urls.filter { seen.insert($0).inserted }
        return unique.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element), rank(b.element))
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    static func rank(_ url: String) -> Int {
        switch RelayRoute.of(url) {
        case .lan, .loopback: 0
        case .tailscale: 1
        case .internet: 2
        }
    }

    public var url: String { routes[current] }
    public var kind: RelayRoute { RelayRoute.of(url) }
    public var hasAlternatives: Bool { routes.count > 1 }

    /// A LAN address is no use on cellular.
    public func eligible(_ i: Int) -> Bool {
        path != .cellular || RelayRoute.of(routes[i]) != .lan
    }

    func cooling(_ i: Int, _ now: Date) -> Bool { (cooldownUntil[i] ?? .distantPast) > now }

    /// The best eligible route that isn't cooling down.
    func best(now: Date) -> Int? { routes.indices.first { eligible($0) && !cooling($0, now) } }

    /// Whether a dial to the current route should give up early: there is a
    /// worse eligible route to fall back to. The last resort gets the
    /// transport's own, longer timeout.
    public var fallbackExists: Bool { routes.indices.contains { $0 > current && eligible($0) } }

    /// The route to dial now. A route that stopped being eligible (the phone
    /// left Wi-Fi) is swapped for the best one.
    public mutating func routeToDial(now: Date) -> String {
        if !eligible(current), let b = best(now: now) ?? routes.indices.first(where: eligible) { move(to: b, now: now) }
        return url
    }

    /// The current route failed: it didn't open, or dropped. With another
    /// eligible route, it cools down and the next one is used. Returns whether
    /// the route changed and the new one can be dialed at once (not cooling).
    @discardableResult
    public mutating func failed(now: Date) -> (changed: Bool, ready: Bool) {
        let others = routes.indices.filter { $0 != current && eligible($0) }
        guard !others.isEmpty else { return (false, false) }
        cooldownUntil[current] = now.addingTimeInterval(rules.failureCooldown)
        successes = 0
        // The next not cooling down, best first; else the one that cools off first.
        let next = others.first { !cooling($0, now) }
            ?? others.min { (cooldownUntil[$0] ?? .distantPast) < (cooldownUntil[$1] ?? .distantPast) }!
        let ready = !cooling(next, now)
        move(to: next, now: now)
        return (true, ready)
    }

    /// On the best route this network allows: nothing to move back to.
    public var onBest: Bool { !routes.indices.contains { $0 < current && eligible($0) } }

    /// The better route to probe while on a worse one, if any.
    public func probeTarget(now: Date) -> Int? {
        guard let b = best(now: now), b < current else { return nil }
        return b
    }

    /// A probe of `route` came back.
    public mutating func probed(_ route: Int, ok: Bool, now: Date) {
        guard route == probeTarget(now: now) else { return }
        if ok {
            successes += 1
        } else {
            successes = 0
            cooldownUntil[route] = now.addingTimeInterval(rules.failureCooldown)
        }
    }

    /// Enough evidence to move back up: the better route answered
    /// `successesToReturn` times in a row and the current one has had its dwell.
    public func shouldMoveBack(now: Date) -> Bool {
        probeTarget(now: now) != nil && successes >= rules.successesToReturn && now.timeIntervalSince(since) >= rules.minDwell
    }

    /// Take the better route. Returns its address.
    @discardableResult
    public mutating func moveBack(now: Date) -> String {
        if let b = probeTarget(now: now) { move(to: b, now: now) }
        return url
    }

    /// The phone moved to another network: forget what failed where, and
    /// start again from the best route for this path. Returns whether the
    /// route changed.
    @discardableResult
    public mutating func pathChanged(_ next: NetworkPath, now: Date) -> Bool {
        path = next
        cooldownUntil = [:]
        successes = 0
        let b = best(now: now) ?? current
        guard b != current else { return false }
        move(to: b, now: now)
        return true
    }

    private mutating func move(to i: Int, now: Date) {
        if i != current { since = now }
        current = i
        successes = 0
    }
}
