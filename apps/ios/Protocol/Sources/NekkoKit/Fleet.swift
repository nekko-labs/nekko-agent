import Foundation
import NekkoProtocol

/// The fleet (2026-11-04): with `stayConnected`, every paired computer other
/// than the active one keeps a link of its own, so the chat list can show every
/// computer's chats at once and nothing waits on a Connect button. A link reads
/// only what the list needs (the chats, their folders, what needs you) and
/// follows the event stream for who is running. Making a computer active takes
/// its link over as it is; the computer left behind hands its link back.
/// Each link reconnects by itself, as the active connection does.

/// What the phone knows about one fleet computer.
public struct Peer: Equatable, Sendable {
    public var conn: RelayState = .connecting
    public var detail: String?
    public var denied: DenyReason?
    public var summaries: [SessionSummary] = []
    public var activity: [String: Activity] = [:]
    public var workspaces: [WorkspaceFolder] = []
    /// The computer answered on this link (not only a saved list).
    public var loaded = false
    /// The list shown is the phone's saved copy, from then.
    public var savedAt: Int64?
    public var hostProtocol: Int?
}

/// One fleet computer's live link.
@MainActor
final class PeerLink {
    let client: RemoteConnection
    var pump: Task<Void, Never>?
    var summariesTask: Task<Void, Never>?
    var summariesDirty = false
    /// Closed while the app is in the background; `resumeFleet` dials again.
    var suspended = false

    init(client: RemoteConnection) { self.client = client }

    func stop() {
        pump?.cancel()
        pump = nil
        summariesTask?.cancel()
        summariesTask = nil
    }
}

private enum PeerSignal: Sendable {
    case status(RelayStatus)
    case event(String, JSONValue)
    case welcome(Int)
    case control(RelayControl)
}

extension ComputersStore {
    // MARK: Reading the fleet (views)

    /// A computer's connection state, active or not.
    public func state(of computerId: String) -> RelayState {
        computerId == activeId ? conn : peers[computerId]?.conn ?? .idle
    }

    /// The computer a chat is on, from the lists the phone holds.
    public func computerId(ofChat sessionId: String) -> String? {
        if summaries.contains(where: { $0.id == sessionId }) { return activeId }
        return peers.first { $0.value.summaries.contains { $0.id == sessionId } }?.key
    }

    /// The chats on one computer, or on every paired computer (nil): the active one's first.
    public func chats(on computerId: String?) -> [SessionSummary] {
        if let computerId { return computerId == activeId ? summaries : peers[computerId]?.summaries ?? [] }
        return summaries + fleetOrder.flatMap { peers[$0]?.summaries ?? [] }
    }

    /// Which chats run or need you, on one computer or every one (nil).
    public func activity(on computerId: String?) -> [String: Activity] {
        if let computerId { return computerId == activeId ? activity : peers[computerId]?.activity ?? [:] }
        return fleetOrder.reduce(activity) { all, id in all.merging(peers[id]?.activity ?? [:]) { a, _ in a } }
    }

    /// The project folders, on one computer or every one (nil), each once.
    public func folders(on computerId: String?) -> [WorkspaceFolder] {
        if let computerId { return computerId == activeId ? workspaces : peers[computerId]?.workspaces ?? [] }
        var seen = Set(workspaces.map(\.id))
        var all = workspaces
        for id in fleetOrder {
            for w in peers[id]?.workspaces ?? [] where seen.insert(w.id).inserted { all.append(w) }
        }
        return all
    }

    /// Chats needing you on every paired computer.
    public var fleetNeedsYouCount: Int { computers.reduce(0) { $0 + (attention[$1.id]?.pending.count ?? 0) } }

    /// Opening a chat that is on another computer makes that computer active
    /// first, so the chat screen talks to it. Its link is taken over: no wait.
    public func focus(chat sessionId: String) {
        guard let id = computerId(ofChat: sessionId), id != activeId else { return }
        connect(id)
    }

    /// Dial a computer again now, active or not (the Reconnect button). A fleet
    /// link is opened afresh, keeping the list it showed meanwhile.
    public func reconnect(computer id: String) {
        if id == activeId {
            if conn == .denied || client == nil { connect(id) } else { reconnect() }
            return
        }
        guard stayConnected, computers.contains(where: { $0.id == id }) else { return }
        let kept = peers[id]
        dropLink(id)
        openLink(id)
        if let kept, var peer = peers[id], peer.savedAt == nil || kept.loaded {
            peer.summaries = kept.summaries
            peer.workspaces = kept.workspaces
            peer.activity = kept.activity
            peers[id] = peer
        }
    }

    /// Re-read every fleet computer that is online (pull to refresh).
    public func refreshFleet() async {
        for id in fleetOrder where peers[id]?.conn == .online { await refreshPeer(id) }
    }

    /// Paired computers other than the active one, in the order they were paired.
    private var fleetOrder: [String] { computers.map(\.id).filter { $0 != activeId } }

    // MARK: Keeping the links

    /// A link for every paired computer but the active one; none for a forgotten one.
    func syncFleet() {
        guard stayConnected else { return }
        let wanted = Set(fleetOrder)
        for id in Set(links.keys).union(peers.keys) where !wanted.contains(id) { dropLink(id) }
        for id in fleetOrder where links[id] == nil && peers[id] == nil { openLink(id) }
    }

    /// Dial one fleet computer, showing its saved list until it answers.
    func openLink(_ id: String) {
        invalidateAttention(id)
        guard let computer = computers.first(where: { $0.id == id }), let secret = secret(id),
              let keyBytes = E2E.fromHex(secret.keyHex) else { return }
        var peer = Peer()
        if let saved = chatListCache?.load(id) {
            peer.summaries = saved.summaries
            peer.workspaces = saved.folders
            peer.savedAt = saved.savedAt
        }
        guard let hostKey = secret.pinned else {
            // Paired before the computer could prove itself: only a fresh QR helps (as `connect`).
            peer.conn = .denied
            peer.denied = .badKey
            peers[id] = peer
            return
        }
        peers[id] = peer
        let c = makeConnection(relayConfig(computer, secret, hostKey: hostKey, keyBytes: keyBytes))
        if networkPath != .unknown { c.setNetworkPath(networkPath) }
        let link = PeerLink(client: c)
        listen(id, link, hadCode: secret.pair != nil)
        if suspended { link.suspended = true } else { c.connect() }
    }

    /// The active computer's connection, kept in the fleet as `peer` says it was.
    func adopt(_ id: String, _ client: RemoteConnection, as peer: Peer, suspended: Bool) {
        let keptAttention = attention[id]
        dropLink(id)
        attention[id] = keptAttention
        peers[id] = peer
        let link = PeerLink(client: client)
        link.suspended = suspended
        listen(id, link, hadCode: false)
    }

    /// Hand a fleet link to the active connection: its client, still open, and what it knew.
    func takeLink(_ id: String) -> (client: RemoteConnection, peer: Peer, suspended: Bool)? {
        guard let link = links.removeValue(forKey: id) else { return nil }
        link.stop()
        let peer = peers.removeValue(forKey: id) ?? Peer()
        return (link.client, peer, link.suspended)
    }

    /// Close and forget one fleet link.
    func dropLink(_ id: String) {
        if let link = links.removeValue(forKey: id) {
            link.stop()
            link.client.close()
        }
        peers[id] = nil
        invalidateAttention(id)
    }

    func suspendFleet() {
        for (id, link) in links where !link.suspended {
            invalidateAttention(id)
            link.suspended = true
            link.client.close()
        }
    }

    func resumeFleet() {
        for link in links.values where link.suspended {
            link.suspended = false
            if networkPath != .unknown { link.client.setNetworkPath(networkPath) }
            link.client.connect()
        }
    }

    /// Back in the foreground: dial now, and re-read the lists of the computers already online.
    func nudgeFleet() {
        for (id, link) in links {
            link.client.nudge()
            if peers[id]?.conn == .online { Task { await refreshPeer(id) } }
        }
    }

    private func listen(_ id: String, _ link: PeerLink, hadCode: Bool) {
        links[id] = link
        let (stream, sink) = AsyncStream<PeerSignal>.makeStream(bufferingPolicy: .unbounded)
        link.client.setHandlers(
            onStatus: { sink.yield(.status($0)) },
            onEvent: { sink.yield(.event($0, $1)) },
            onWelcome: { sink.yield(.welcome($0.protocolVersion)) })
        link.client.setControlHandler { sink.yield(.control($0)) }
        link.pump = Task { @MainActor [weak self, weak link] in
            for await signal in stream {
                guard let self, let link, self.links[id] === link else { return }
                self.handle(signal, peer: id, hadCode: hadCode)
            }
        }
    }

    private func handle(_ signal: PeerSignal, peer id: String, hadCode: Bool) {
        guard peers[id] != nil else { return }
        switch signal {
        case .status(let s):
            if s.state != .online { invalidateAttention(id) }
            peers[id]?.conn = s.state
            peers[id]?.detail = s.detail
            if let d = s.denied { peers[id]?.denied = d } else if s.state == .online { peers[id]?.denied = nil }
            if s.state == .online {
                Task { await refreshPeer(id) }
                registerPush(peer: id)
            }
        case .welcome(let version):
            peers[id]?.hostProtocol = version
            if hadCode { dropPairCode(id) }
        case .control(.dismiss(let tag)):
            dismissAttention(tag: tag, on: id)
        case .control:
            break
        case .event(let channel, let payload):
            guard channel == Events.agentEvent, let e = AgentEvent.from(payload), let before = peers[id]?.activity else { return }
            let next = ActivityTracker.next(before, e)
            if next != before { peers[id]?.activity = next }
            receiveAttention(e, on: id)
            onComputerEvent?(id, e)
            // The list stays fresh when a turn ends there, as the active computer's does.
            switch e {
            case .done, .sessionMeta: schedulePeerSummaries(id)
            default: break
            }
        }
    }

    /// Read what the list shows from one fleet computer.
    func refreshPeer(_ id: String) async {
        guard peers[id]?.conn == .online, let c = links[id]?.client else { return }
        let ticket = beginAttention(id)
        async let list = orNil { try await c.call(Channels.sessionsSummaries) }
        async let folders = orNil { try await c.call(Channels.workspaceList) }
        async let pending = orNil { try await c.call(Channels.chatPending, [], timeout: 5) }
        async let info = orNil { try await c.call(Channels.appInfo) }
        let r = (await list, await folders, await pending, await info)
        guard links[id]?.client === c, peers[id] != nil else { return }
        if let l = r.0 {
            peers[id]?.summaries = SessionSummary.visible(l)
            peers[id]?.loaded = true
            peers[id]?.savedAt = nil
        }
        if r.1 != nil { peers[id]?.workspaces = WorkspaceFolder.list(r.1) }
        // Approvals and questions already waiting when the link (re)connects.
        replaceAttention(r.2, on: id, ticket: ticket)
        if r.3 != nil {
            let appInfo = AppInfo.from(r.3)
            learnPlatform(appInfo.platform, for: id)
            learnIcon(appInfo.machineIcon, for: id)
        }
        savePeerList(id)
    }

    private func schedulePeerSummaries(_ id: String) {
        guard let link = links[id] else { return }
        link.summariesDirty = true
        guard link.summariesTask == nil else { return }
        let delay = summariesDebounce
        link.summariesTask = Task { @MainActor [weak self] in
            defer { link.summariesTask = nil }
            repeat {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1e9))
                guard let self, self.links[id] === link, !Task.isCancelled else { return }
                link.summariesDirty = false
                let list = try? await link.client.call(Channels.sessionsSummaries)
                guard self.links[id] === link, !Task.isCancelled else { return }
                if let list {
                    self.peers[id]?.summaries = SessionSummary.visible(list)
                    self.peers[id]?.loaded = true
                    self.peers[id]?.savedAt = nil
                    self.savePeerList(id)
                }
            } while link.summariesDirty
        }
    }

    /// A fleet computer's live list, as the phone's saved copy (only when the user keeps one).
    private func savePeerList(_ id: String) {
        guard let cache = chatListCache, let peer = peers[id], peer.loaded else { return }
        cache.save(id, SavedChatList(savedAt: now(), summaries: peer.summaries, folders: peer.workspaces))
    }
}
