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
