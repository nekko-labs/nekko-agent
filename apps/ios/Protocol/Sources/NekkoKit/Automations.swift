import Foundation
import NekkoProtocol
import Observation

/// The computer's automations on the phone: its tasks and workflows, how each
/// last went, and Run now on one the owner already set up. Making, changing,
/// pausing or deleting them stays on the computer (the computer refuses it).
@MainActor
@Observable
public final class AutomationsModel {
    public private(set) var tasks: [AutomationTask] = []
    public private(set) var workflows: [AutomationWorkflow] = []
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var error: String?
    /// Automations Run now was sent for since the list was last read.
    public private(set) var started: Set<String> = []

    private let store: ComputersStore

    public init(store: ComputersStore) {
        self.store = store
    }

    /// The automations are paused on the computer: Run now still works, schedules don't fire.
    public var paused: Bool { store.pcSettings.automationsPaused }
    public var isEmpty: Bool { tasks.isEmpty && workflows.isEmpty }

    public func load() async {
        loading = true
        defer { loading = false }
        do {
            let r = try store.remote()
            async let t = r.call(Channels.tasksList)
            async let w = r.call(Channels.workflowsList)
            let (tasks, workflows) = (try await t, try await w)
            self.tasks = AutomationTask.list(tasks)
            self.workflows = AutomationWorkflow.list(workflows)
            started = []
            error = nil
        } catch {
            self.error = store.readable(error).localizedDescription
        }
        loaded = true
    }

    /// Run a task now, as the desktop's Run now does.
    public func run(task id: String) async throws {
        try await runNow(id) { r in _ = try await r.call(Channels.taskRunNow, [.string(id)]) }
    }

    /// Start a run of a workflow, as its Run button does.
    public func run(workflow id: String) async throws {
        try await runNow(id) { r in _ = try await r.call(Channels.workflowRun, [.string(id)]) }
    }

    private func runNow(_ id: String, _ call: (RemoteConnection) async throws -> Void) async throws {
        guard store.conn == .online else { throw RelayError("Reconnect to run it. Run now is never sent later.") }
        do {
            try await call(try store.remote())
        } catch {
            throw store.readable(error)
        }
        started.insert(id)
        // The run takes a while to finish; read the list again a few times so its result shows.
        Task { @MainActor [weak self] in
            for seconds in [1.5, 4, 10, 20, 40] as [Double] {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
                guard let self, self.store.conn == .online else { return }
                await self.reload()
            }
        }
    }

    private func reload() async {
        let keep = started
        await load()
        started = keep
    }
}

/// The computer's provider usage and plan limits, read only.
@MainActor
@Observable
public final class UsageModel {
    public private(set) var summary: UsageSummary?
    /// Plan limits by provider id, for the providers that have them.
    public private(set) var limits: [String: ProviderLimits] = [:]
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var error: String?

    private let store: ComputersStore

    public init(store: ComputersStore) {
        self.store = store
    }

    public struct Card: Identifiable, Sendable {
        public let provider: PublicProvider
        public let limits: ProviderLimits
        public var id: String { provider.id }
    }

    /// The enabled providers that reported limits, in the computer's order.
    public var limited: [Card] {
        store.providers.filter(\.enabled).compactMap { p in limits[p.id].map { Card(provider: p, limits: $0) } }
    }

    public func load() async {
        loading = true
        defer { loading = false }
        do {
            let r = try store.remote()
            summary = UsageSummary.from(try await r.call(Channels.usageSummary))
            error = nil
            var found: [String: ProviderLimits] = [:]
            // A provider without limits answers null; one that fails to read leaves no card.
            await withTaskGroup(of: (String, ProviderLimits?).self) { group in
                for p in store.providers where p.enabled {
                    group.addTask { (p.id, ProviderLimits.from(try? await r.call(Channels.limitsGet, [.string(p.id)]))) }
                }
                for await (id, l) in group { if let l { found[id] = l } }
            }
            limits = found
        } catch {
            self.error = store.readable(error).localizedDescription
        }
        loaded = true
    }
}

/// Usage by where it came from (#1773): every paired computer that answers,
/// read in parallel over its own link, and this iPhone's own chats. A computer
/// that is offline, or fails to answer, keeps the numbers it last gave.
@MainActor
@Observable
public final class FleetUsageModel {
    /// The paired computers in the app's order, then this iPhone when it runs chats.
    public private(set) var places: [UsagePlace] = []
    public private(set) var loading = false
    public private(set) var loaded = false

    private let store: ComputersStore
    private let phone: PhoneChats?

    public init(store: ComputersStore, phone: PhoneChats?) {
        self.store = store
        self.phone = phone
    }

    /// The All places total.
    public var total: UsageTotals { UsageTotals(places) }
    public var isEmpty: Bool { places.allSatisfy(\.isEmpty) }

    public func load() async {
        loading = true
        defer { loading = false }
        let last = Dictionary(places.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let computers = store.computers
        // Who can be asked now: the active computer's connection, or the fleet's link.
        var links: [String: RemoteConnection] = [:]
        for c in computers where store.state(of: c.id) == .online {
            if let r = try? store.caller(c.id) { links[c.id] = r }
        }
        var read: [String: Result<UsagePlace, Error>] = [:]
        await withTaskGroup(of: (String, Result<UsagePlace, Error>).self) { group in
            for c in computers {
                guard let r = links[c.id] else { continue }
                let (id, name) = (c.id, c.name)
                group.addTask {
                    do { return (id, .success(try await Self.read(r, id: id, name: name))) } catch { return (id, .failure(error)) }
                }
            }
            for await (id, result) in group { read[id] = result }
        }
        var out: [UsagePlace] = computers.map { c in
            switch read[c.id] {
            case .success(let place)?:
                return place
            case .failure(let error)?:
                return Self.stale(last[c.id], id: c.id, name: c.name, error: store.readable(error).localizedDescription)
            case nil:
                return Self.stale(last[c.id], id: c.id, name: c.name, error: nil)
            }
        }
        if let phone, phone.isSetUp || !phone.usage.isEmpty {
            out.append(phone.usage.place())
        }
        places = out
        loaded = true
    }

    /// A place that did not answer this time: its last numbers, marked offline.
    static func stale(_ last: UsagePlace?, id: String, name: String, error: String?) -> UsagePlace {
        var p = last ?? UsagePlace(id: id, kind: .computer, name: name, online: false)
        p.online = false
        p.error = error
        return p
    }

    /// One computer's summary, providers and the enabled providers' plan limits.
    nonisolated static func read(_ r: RemoteConnection, id: String, name: String) async throws -> UsagePlace {
        async let summaryRaw = r.call(Channels.usageSummary)
        async let providersRaw = r.call(Channels.providersList)
        let summary = UsageSummary.from(try await summaryRaw)
        // Without the providers list there are no plans to show, but the summary still stands.
        let providers = PublicProvider.list(try? await providersRaw).filter(\.enabled)
        var found: [String: ProviderLimits] = [:]
        // A provider without limits answers null; one that fails to read leaves no plan.
        await withTaskGroup(of: (String, ProviderLimits?).self) { group in
            for p in providers {
                group.addTask { (p.id, ProviderLimits.from(try? await r.call(Channels.limitsGet, [.string(p.id)]))) }
            }
            for await (pid, l) in group { if let l { found[pid] = l } }
        }
        let plans = providers.compactMap { p in found[p.id].map { UsagePlace.Plan(providerId: p.id, label: p.shortName, limits: $0) } }
        return UsagePlace(id: id, kind: .computer, name: name, online: true, summary: summary, plans: plans)
    }
}
