import Foundation
import NekkoProtocol

/// The account's computers (decision 0128): a computer of this phone's Nekko Cloud account publishes a sealed `reach`
/// record, and the phone reads it through `CloudSync`. A record whose room matches a paired computer adds that
/// computer's relay routes at connect time (the saved pairing is never rewritten). A record with no pairing becomes
/// a computer "from your account", dialled with the account HELLO. A tombstone or a vanished record takes either away.
extension ComputersStore {
    /// This computer with the routes its `reach` record adds, for dialing and for the route checks. The pairing is
    /// untouched, and the per-computer *Connect through* choice filters the merged routes as it does the saved ones.
    func withReach(_ computer: Computer) -> Computer {
        guard !computer.fromAccount, let room = secret(computer.id)?.room,
              let record = reachRecords.first(where: { $0.room == room }) else { return computer }
        let known = Set(computer.allRoutes)
        var merged = computer
        merged.alts += record.routes.filter { !known.contains($0) }
        return merged
    }

    /// The routes this phone would dial for a computer now: its pairing's, plus the account record's.
    public func dialRoutes(_ id: String) -> [String] {
        computers.first { $0.id == id }.map { withReach($0).routes } ?? []
    }

    /// Take the account's `reach` records (every time they change, and once at launch from what is kept).
    public func applyReach(_ records: [CloudSync.ReachRecord]) async {
        reachGeneration += 1
        let generation = reachGeneration
        var keys = reachKeys
        for r in records where keys[r.room + "\n" + r.secret] == nil {
            keys[r.room + "\n" + r.secret] = E2E.toHex(await deriveKey(r.secret, r.room))
        }
        // A newer call came in while the keys were made: it has the latest.
        guard generation == reachGeneration else { return }
        reachKeys = keys
        let before = Dictionary(uniqueKeysWithValues: computers.map { ($0.id, withReach($0).routes) })
        reachRecords = records
        rebuildAccountComputers(connecting: true)
        // A paired computer whose record changed its routes dials the new ones: the link is rebuilt as for a route choice.
        for c in computers where !c.fromAccount {
            guard let old = before[c.id], old != withReach(c).routes, connectionEnabled(c.id) else { continue }
            if c.id == activeId {
                connect(c.id)
            } else if stayConnected {
                dropLink(c.id)
                syncFleet()
            }
        }
    }

    /// Show a computer for each record that no pairing covers, and drop the ones that went away.
    func rebuildAccountComputers(connecting: Bool) {
        let pairedRooms = Set(computers.filter { !$0.fromAccount }.compactMap { secret($0.id)?.room })
        var secrets: [String: ComputerSecret] = [:]
        var wanted: [(computer: Computer, changed: Bool)] = []
        let existing = Dictionary(computers.filter(\.fromAccount).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for r in reachRecords where !pairedRooms.contains(r.room) {
            guard let keyHex = reachKeys[r.room + "\n" + r.secret] else { continue }
            let id = Computer.accountPrefix + r.deviceId
            secrets[id] = ComputerSecret(room: r.room, key: r.secret, keyHex: keyHex, pair: nil, hostKey: r.hostKey, v: E2E.pairingVersion)
            var c = existing[id] ?? Computer(id: id, name: r.name, relayUrl: r.routes[0], pairedAt: now(), alts: Array(r.routes.dropFirst()))
            let changed = existing[id].map { $0.relayUrl != r.routes[0] || $0.alts != Array(r.routes.dropFirst()) || accountSecrets[id] != secrets[id] } ?? false
            c.relayUrl = r.routes[0]
            c.alts = Array(r.routes.dropFirst())
            c.name = r.name
            wanted.append((c, changed))
        }
        let keep = Set(wanted.map(\.computer.id))
        // Gone: tombstoned, or the computer is paired now. `forget` also moves the active one along.
        for id in existing.keys where !keep.contains(id) { forget(id) }
        accountSecrets = secrets
        let fresh = wanted.map(\.computer).filter { existing[$0.id] == nil }
        for w in wanted {
            if let i = computers.firstIndex(where: { $0.id == w.computer.id }) { computers[i] = w.computer }
        }
        computers.append(contentsOf: fresh)
        guard connecting else { return }
        for w in wanted where w.changed && connectionEnabled(w.computer.id) {
            if w.computer.id == activeId {
                connect(w.computer.id)
            } else if stayConnected {
                dropLink(w.computer.id)
            }
        }
        // Nothing paired, or this was the one in use when the app last closed: open it.
        let last = store.get(Self.activeKey)
        for c in fresh {
            if activeId == nil || (last == c.id && activeId != c.id) { connect(c.id) }
        }
        if stayConnected { syncFleet() }
    }

    /// A connection status of one computer: a refusal an account device can clear by catching up is tried again,
    /// at most twice, after a sync (the computer reads the account again after `fleet-device` and `fleet-epoch`).
    func noteAccountStatus(_ id: String, _ status: RelayStatus) {
        guard id.hasPrefix(Computer.accountPrefix) else { return }
        if status.state == .online { accountRetries[id] = nil }
        guard status.state == .denied, let reason = status.denied, FleetLink.retryable(reason),
              accountRetries[id, default: 0] < 2, let catchUp = accountCatchUp else { return }
        accountRetries[id, default: 0] += 1
        Task { @MainActor [weak self] in
            await catchUp()
            try? await Task.sleep(for: .seconds(2))
            guard let self, self.computers.contains(where: { $0.id == id }) else { return }
            self.reconnect(computer: id)
        }
    }
}
