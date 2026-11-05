import Foundation
import NekkoProtocol

/// New chat's Auto (2026-11-05): a chat on a local model starts on a paired
/// computer that is free, so nobody has to know which one is. The user can
/// still pick one. Only local-model chats: a cloud model's work happens at the
/// provider, so the computer matters less there.

/// One paired computer as Auto sees it.
public struct MachineCandidate: Equatable, Sendable {
    public var id: String
    public var conn: RelayState
    /// Chats replying there now, from the fleet's event streams.
    public var running: Int
    /// What the computer said about its use; nil when it didn't (an older build, or the read failed).
    public var use: ComputerUse?
    /// It has an enabled model server (Ollama, LM Studio, llama.cpp, vLLM).
    public var hasLocalModel: Bool

    public init(id: String, conn: RelayState, running: Int = 0, use: ComputerUse? = nil, hasLocalModel: Bool = true) {
        self.id = id
        self.conn = conn
        self.running = running
        self.use = use
        self.hasLocalModel = hasLocalModel
    }

    /// Lower is freer: 0 nobody uses it, 1 no chat of ours but it didn't say
    /// whether someone is there, 2 someone is at it, 3 a chat is replying.
    var busyness: Int {
        if running > 0 || use?.chatActive == true { return 3 }
        if use?.userActive == true { return 2 }
        return use == nil ? 1 : 0
    }
}

/// Where Auto starts a chat, and why.
public struct MachinePick: Equatable, Sendable {
    public enum Reason: Equatable, Sendable {
        /// The computer is free.
        case free
        /// Every computer that can run it is busy: the one used last, as before Auto.
        case allBusy
        /// No computer that can run a local model is online: the one used last.
        case noneAvailable
    }

    public var computerId: String?
    public var reason: Reason
    /// Computers passed over because they were busy, by id (for the line under Run on).
    public var skipped: [String]

    public init(computerId: String?, reason: Reason, skipped: [String] = []) {
        self.computerId = computerId
        self.reason = reason
        self.skipped = skipped
    }
}

public enum MachinePicker {
    /// The freest online computer with a local model. Ties go to the one used
    /// last, then to one not on battery or hot, then to pairing order. With
    /// none free, the one used last.
    public static func pick(_ candidates: [MachineCandidate], lastUsed: String?) -> MachinePick {
        let able = candidates.filter { $0.conn == .online && $0.hasLocalModel }
        let fallback = lastUsed ?? candidates.first?.id
        guard !able.isEmpty else { return MachinePick(computerId: fallback, reason: .noneAvailable, skipped: []) }
        let order = Dictionary(uniqueKeysWithValues: able.enumerated().map { ($1.id, $0) })
        let ranked = able.sorted { a, b in
            if a.busyness != b.busyness { return a.busyness < b.busyness }
            if (a.id == lastUsed) != (b.id == lastUsed) { return a.id == lastUsed }
            let sa = a.use?.strained == true, sb = b.use?.strained == true
            if sa != sb { return !sa }
            return order[a.id, default: 0] < order[b.id, default: 0]
        }
        let best = ranked[0]
        if best.busyness <= 1 {
            let skipped = lastUsed.flatMap { id in able.first { $0.id == id && $0.busyness > 1 } }.map { [$0.id] } ?? []
            return MachinePick(computerId: best.id, reason: .free, skipped: skipped)
        }
        let back = able.contains { $0.id == lastUsed } ? lastUsed : best.id
        return MachinePick(computerId: back, reason: .allBusy, skipped: [])
    }
}

extension ComputersStore {
    /// Ask every online computer whether it is in use and whether it has a
    /// local model, in parallel, and pick one (New chat's Auto). A computer
    /// that doesn't answer in time counts as not saying.
    public func pickMachine(lastUsed: String?, timeout: TimeInterval = 4) async -> MachinePick {
        let probes = computers.map { c in
            (c.id, Task { @MainActor in await self.probe(c.id, timeout: timeout) })
        }
        var candidates: [MachineCandidate] = []
        for (id, task) in probes {
            let (use, local) = await task.value
            let running = activity(on: id).values.filter { $0 == .running }.count
            candidates.append(MachineCandidate(id: id, conn: state(of: id), running: running, use: use, hasLocalModel: local))
        }
        return MachinePicker.pick(candidates, lastUsed: lastUsed)
    }

    /// A local model to start with on `id`, read over its link before it
    /// becomes active: the first of `prefer` it has, else a model already
    /// loaded on one of its model servers, else the first one listed.
    public func localModel(on id: String, prefer: [(String, String)], timeout: TimeInterval = 6) async -> (String, String)? {
        guard let c = connection(to: id) else { return nil }
        let providers = PublicProvider.list(await orNil { try await c.call(Channels.providersList, [], timeout: timeout) })
            .filter { $0.enabled && $0.isLocal }
        var lists: [String: [ModelInfo]] = [:]
        func models(_ p: String) async -> [ModelInfo] {
            if let known = lists[p] { return known }
            let got = ModelInfo.list(await orNil { try await c.call(Channels.modelsList, [.string(p)], timeout: timeout) })
            lists[p] = got
            return got
        }
        for (p, m) in prefer where providers.contains(where: { $0.id == p }) {
            if await models(p).contains(where: { $0.id == m }) { return (p, m) }
        }
        var first: (String, String)?
        for p in providers {
            let list = await models(p.id)
            if let loaded = list.first(where: \.loaded) { return (p.id, loaded.id) }
            if first == nil, let m = list.first { first = (p.id, m.id) }
        }
        return first
    }

    /// The live connection to a computer: the active one's, or its fleet link.
    func connection(to id: String) -> RemoteConnection? {
        id == activeId ? client : links[id]?.client
    }

    private func probe(_ id: String, timeout: TimeInterval) async -> (ComputerUse?, Bool) {
        guard state(of: id) == .online, let c = connection(to: id) else { return (nil, false) }
        async let use = orNil { try await c.call(Channels.activityState, [], timeout: timeout) }
        async let list = orNil { try await c.call(Channels.providersList, [], timeout: timeout) }
        let (u, l) = (await use, await list)
        // Not read in time: the active computer's own list, else assume it has one (the pick says why later).
        let providers = l.map(PublicProvider.list) ?? (id == activeId ? self.providers : nil)
        let local = providers.map { $0.contains { $0.enabled && $0.isLocal } } ?? true
        return (ComputerUse.from(u), local)
    }
}
