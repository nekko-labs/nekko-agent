import Foundation
import NekkoProtocol
import Observation

/// The Expert monitor (2026-10-24): the computer's hardware and the Model
/// Server's loaded models, re-read while the panel is on screen, as the
/// desktop's Hardware and Local models monitors are.
@MainActor
@Observable
public final class HardwareMonitorModel {
    public private(set) var system: SystemStats?
    public private(set) var gpu: GpuStats?
    public private(set) var engine: EngineStatus?
    /// Model names by id, from the computer's model lists, for the loaded models.
    public private(set) var names: [String: String] = [:]
    public private(set) var loaded = false
    public private(set) var error: String?
    /// The model being unloaded.
    public private(set) var unloading: String?
    #if DEBUG
    /// Screenshot captures only (`-uiTestLocalModel`): a Model Server reading used in place of the computer's.
    public var stubEngine: EngineStatus?
    #endif

    /// How often the panel re-reads the computer: the desktop samples hardware every few seconds.
    public static let interval: TimeInterval = 3
    /// How often Simple mode checks for a loaded local model, with no monitor on screen.
    public static let engineInterval: TimeInterval = 10

    /// The Model Server holds at least one model: Simple then shows the monitors too.
    public var localModelLoaded: Bool { !(engine?.resident.isEmpty ?? true) }

    private let store: ComputersStore

    public init(store: ComputersStore) {
        self.store = store
    }

    /// Read the hardware and the Model Server once. A computer too old to
    /// answer a channel refuses it; that reading stays empty and the rest shows.
    public func refresh() async {
        do {
            let r = try store.remote()
            async let sys = orNil { try await r.call(MonitorChannels.systemStats) }
            async let gpuRaw = orNil { try await r.call(MonitorChannels.gpuStats) }
            async let eng = orNil { try await r.call(MonitorChannels.engineStatus) }
            // `nil` alone would read as JSONValue's own null literal here.
            let present = { (v: JSONValue?) -> JSONValue? in
                guard let v, !v.isNull else { return Optional.none }
                return v
            }
            let (s, g, e) = await (present(sys), present(gpuRaw), present(eng))
            system = SystemStats.from(s)
            gpu = GpuStats.from(g)
            engine = EngineStatus.from(e)
            #if DEBUG
            if let stubEngine { engine = stubEngine }
            #endif
            if s == nil && g == nil && e == nil {
                error = "\(store.active?.name ?? "This computer") didn’t send its monitors. Update Nekko Agent there to see them."
            } else {
                error = nil
            }
            var known: [String: String] = [:]
            for list in store.models.values { for m in list { known[m.id] = m.name } }
            names = known
        } catch {
            self.error = store.readable(error).localizedDescription
        }
        loaded = true
    }

    /// Read only the Model Server's status (light: no hardware sampling).
    public func refreshEngine() async {
        // A failed read keeps the last one, so a hiccup doesn't hide the monitors.
        guard let r = try? store.remote(), let raw = try? await r.call(MonitorChannels.engineStatus) else { return }
        engine = raw.isNull ? nil : EngineStatus.from(raw)
        #if DEBUG
        if let stubEngine { engine = stubEngine }
        #endif
    }

    /// Re-read every `interval` seconds until the task is cancelled (the panel left the screen).
    /// `engineOnly` reads just the Model Server, for Simple's loaded-model check.
    public func follow(every interval: TimeInterval = HardwareMonitorModel.interval, engineOnly: Bool = false) async {
        while !Task.isCancelled {
            if engineOnly { await refreshEngine() } else { await refresh() }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
    }

    /// Unload a model from the Model Server: it frees its memory, and the next
    /// reply that uses it loads it again. Returns the computer's message.
    @discardableResult
    public func unload(_ id: String) async throws -> String {
        unloading = id
        defer { unloading = nil }
        // A plain call (Change switch, no proof); `call(read:)` says the computer's refusals plainly.
        let res = try await store.call(read: MonitorChannels.modelUnload, [.string(engineProviderId), .string(id)])
        let ok = res["ok"]?.bool ?? false
        let message = res.str("message") ?? (ok ? "Unloaded." : "Couldn’t unload it.")
        await refresh()
        guard ok else { throw RelayError(message) }
        return message
    }

    public func name(_ id: String) -> String { names[id] ?? id }
}
