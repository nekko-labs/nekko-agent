import Foundation

/// The Expert monitor (2026-10-24): the computer's hardware, the Model
/// Server's loaded models and a chat's context window, each as the narrow
/// view the computer sends a phone (`phoneSystemView`, `phoneGpuView`,
/// `phoneEngineView`, `phoneContextView` in packages/shared/src/phone-views.ts).
public enum MonitorChannels {
    public static let systemStats = "system:stats"
    public static let gpuStats = "gpu:stats"
    public static let engineStatus = "engine:status"
    /// A chat's context totals; the computer never sends what is in it.
    public static let contextPreview = "context:preview"
    /// Change level without a proof: unloading frees memory and the next reply loads the model again.
    public static let modelUnload = "model:unload"
}

/// The built-in Model Server's provider id (`PROVIDER_ID` in the desktop's ModelDock).
public let engineProviderId = "nekko-engine"

/// `system:stats`: CPU load and memory, with temperatures when the computer has sensors.
public struct SystemStats: Equatable, Sendable {
    public let cpuPct: Double
    public let cpuCores: Int
    public let cpuModel: String?
    public let memUsedMB: Double
    public let memTotalMB: Double
    public let cpuC: Double?
    public let memoryC: Double?
    public let gpuC: Double?

    public init(cpuPct: Double, cpuCores: Int = 0, cpuModel: String? = nil, memUsedMB: Double, memTotalMB: Double,
                cpuC: Double? = nil, memoryC: Double? = nil, gpuC: Double? = nil) {
        self.cpuPct = cpuPct
        self.cpuCores = cpuCores
        self.cpuModel = cpuModel
        self.memUsedMB = memUsedMB
        self.memTotalMB = memTotalMB
        self.cpuC = cpuC
        self.memoryC = memoryC
        self.gpuC = gpuC
    }

    /// Memory in use, 0...1; nil when the computer reported no total.
    public var memFraction: Double? { memTotalMB > 0 ? min(1, max(0, memUsedMB / memTotalMB)) : nil }

    public static func from(_ v: JSONValue?) -> SystemStats? {
        guard let v, v.object != nil, let cpu = v.dbl("cpuPct") else { return nil }
        let temps = v["temps"]
        return SystemStats(cpuPct: cpu, cpuCores: Int(v.long("cpuCores") ?? 0), cpuModel: v.str("cpuModel"),
                           memUsedMB: v.dbl("memUsedMB") ?? 0, memTotalMB: v.dbl("memTotalMB") ?? 0,
                           cpuC: temps?.dbl("cpuC"), memoryC: temps?.dbl("memoryC"), gpuC: temps?.dbl("gpuC"))
    }
}

/// `gpu:stats`: the GPU memory pool and each device's load.
public struct GpuStats: Equatable, Sendable {
    public struct Device: Equatable, Sendable, Identifiable {
        public let index: Int
        public let name: String
        public let utilizationPct: Double?
        public let temperatureC: Double?
        public var id: Int { index }
    }

    public let devices: [Device]
    public let totalMB: Double
    public let usedMB: Double
    /// One pool shared with the CPU (Apple Silicon): "GPU memory", not VRAM (`gpuMemoryLabel`).
    public let unified: Bool

    public var memFraction: Double? { totalMB > 0 ? min(1, max(0, usedMB / totalMB)) : nil }

    public static func from(_ v: JSONValue?) -> GpuStats? {
        guard let v, v.object != nil else { return nil }
        let devices = (v["devices"]?.array ?? []).enumerated().compactMap { i, d -> Device? in
            guard d.object != nil else { return nil }
            return Device(index: i, name: d.str("name") ?? "", utilizationPct: d.dbl("utilizationPct"), temperatureC: d.dbl("temperatureC"))
        }
        return GpuStats(devices: devices, totalMB: v.dbl("totalMB") ?? 0, usedMB: v.dbl("usedMB") ?? 0, unified: v.flag("unified"))
    }
}

/// `engine:status`: whether the Model Server runs, and what it holds in memory.
public struct EngineStatus: Equatable, Sendable {
    /// A model the Model Server holds in memory (`ResidentModel`).
    public struct Resident: Equatable, Sendable, Identifiable {
        public let id: String
        public let contextLength: Int64?
        /// GPU memory it takes, else its file size.
        public let bytes: Int64?
        /// `gpu` every layer offloaded, `cpu` none, `gpu+cpu` split; nil when the runtime can't say.
        public let loadedOn: String?
        public let gpuLayers: Int?
        public let totalLayers: Int?
        public let lastUsedAt: Int64?
        /// When it unloads itself after sitting idle; nil stays loaded.
        public let expiresAt: Int64?

        public init(id: String, contextLength: Int64? = nil, bytes: Int64? = nil, loadedOn: String? = nil, gpuLayers: Int? = nil,
                    totalLayers: Int? = nil, lastUsedAt: Int64? = nil, expiresAt: Int64? = nil) {
            self.id = id
            self.contextLength = contextLength
            self.bytes = bytes
            self.loadedOn = loadedOn
            self.gpuLayers = gpuLayers
            self.totalLayers = totalLayers
            self.lastUsedAt = lastUsedAt
            self.expiresAt = expiresAt
        }

        /// Part of it runs on the CPU: slower, as the desktop warns.
        public var split: Bool { loadedOn == "gpu+cpu" || loadedOn == "cpu" }
    }

    public struct Loading: Equatable, Sendable, Identifiable {
        public let id: String
        /// `queued` or `loading`.
        public let phase: String
        /// 0...1 when known.
        public let progress: Double?
    }

    public let installed: Bool
    public let running: Bool
    public let resident: [Resident]
    public let loading: [Loading]
    /// What this computer can load models into (`EngineMemory`): `vram`, `unified` or `ram`.
    public let budgetBytes: Int64?
    public let memoryKind: String?

    /// Memory the resident models take, of the budget, 0...1.
    public var memFraction: Double? {
        guard let budget = budgetBytes, budget > 0 else { return nil }
        let used = resident.reduce(Int64(0)) { $0 + ($1.bytes ?? 0) }
        return min(1, Double(used) / Double(budget))
    }

    public static func from(_ v: JSONValue?) -> EngineStatus? {
        guard let v, v.object != nil else { return nil }
        let resident = (v["resident"]?.array ?? []).compactMap { r -> Resident? in
            guard let id = r.str("id") else { return nil }
            return Resident(id: id, contextLength: r.long("contextLength"), bytes: r.long("vramBytes") ?? r.long("sizeBytes"),
                            loadedOn: r.str("loadedOn"), gpuLayers: r.long("gpuLayers").map(Int.init),
                            totalLayers: r.long("totalLayers").map(Int.init), lastUsedAt: r.long("lastUsedAt"), expiresAt: r.long("expiresAt"))
        }
        let loading = (v["loading"]?.array ?? []).compactMap { l -> Loading? in
            guard let id = l.str("id") else { return nil }
            return Loading(id: id, phase: l.str("phase") ?? "queued", progress: l.dbl("progress"))
        }
        return EngineStatus(installed: v.flag("installed"), running: v.flag("running"), resident: resident, loading: loading,
                            budgetBytes: v["memory"]?.long("budgetBytes"), memoryKind: v["memory"]?.str("kind"))
    }
}

/// `context:preview`: how much of the chat's model window the next request fills.
public struct ContextUsage: Equatable, Sendable {
    public struct Source: Equatable, Sendable, Identifiable {
        /// `system`, `conversation`, `attached-file`, `guideline`, `memory`, ...
        public let source: String
        public let tokens: Int64
        public var id: String { source }
    }

    public let usedTokens: Int64
    /// The model's window; nil when the computer doesn't know it.
    public let contextWindow: Int64?
    /// Biggest first.
    public let sources: [Source]

    public init(usedTokens: Int64, contextWindow: Int64?, sources: [Source] = []) {
        self.usedTokens = usedTokens
        self.contextWindow = contextWindow
        self.sources = sources
    }

    /// 0...1 of the window; nil without one.
    public var fraction: Double? {
        guard let w = contextWindow, w > 0 else { return nil }
        return min(1, Double(usedTokens) / Double(w))
    }

    /// The composer gauge's colours (`fillTone`): a warning from 60%, danger from 85%.
    public var tone: MonitorTone {
        guard let f = fraction else { return .ok }
        return f >= 0.85 ? .hot : f >= 0.6 ? .warn : .ok
    }

    public static func from(_ v: JSONValue?) -> ContextUsage? {
        guard let v, v.object != nil, let used = v.long("usedTokens") else { return nil }
        var sources: [Source] = []
        for (k, t) in v["sources"]?.object ?? [:] {
            if let n = t.int64, n > 0 { sources.append(Source(source: k, tokens: n)) }
        }
        sources.sort { a, b in a.tokens != b.tokens ? a.tokens > b.tokens : a.source < b.source }
        return ContextUsage(usedTokens: used, contextWindow: v.long("contextWindow").flatMap { $0 > 0 ? $0 : nil }, sources: sources)
    }
}

/// The monitors' shared severity scale: quiet, warn, danger.
public enum MonitorTone: Sendable {
    case ok, warn, hot

    /// A load or fill fraction: warn above 70%, danger above 90% (the desktop's `loadColor`).
    public static func of(_ fraction: Double?) -> MonitorTone {
        guard let f = fraction else { return .ok }
        return f > 0.9 ? .hot : f > 0.7 ? .warn : .ok
    }

    /// A temperature in °C (`temperatureTone`): warn from 80, danger from 90.
    public static func temperature(_ c: Double) -> MonitorTone { c >= 90 ? .hot : c >= 80 ? .warn : .ok }
}

/// Counts as the desktop writes them (`formatContextTokens`, `formatTokens`, `formatBytes`).
public enum MonitorFormat {
    /// 950, 12.3k, 128k, 1.05M.
    public static func tokens(_ n: Int64) -> String {
        let d = Double(n)
        if n >= 1_000_000 { return trim(String(format: "%.2f", d / 1_000_000)) + "M" }
        if n >= 100_000 { return String(format: "%.0f", d / 1000) + "k" }
        if n >= 1000 { return trim(String(format: "%.1f", d / 1000)) + "k" }
        return String(n)
    }

    /// 512 MB, 4.7 GB.
    public static func bytes(_ n: Int64) -> String {
        let gb = Double(n) / 1_073_741_824
        if gb >= 1 { return trim(String(format: gb >= 10 ? "%.0f" : "%.1f", gb)) + " GB" }
        return String(format: "%.0f", Double(n) / 1_048_576) + " MB"
    }

    /// MiB as the hardware monitor writes memory: 9.4 / 32 GB.
    public static func memory(usedMB: Double, totalMB: Double) -> String {
        let f = { (mb: Double) in trim(String(format: mb / 1024 >= 10 ? "%.0f" : "%.1f", mb / 1024)) }
        return "\(f(usedMB)) / \(f(totalMB)) GB"
    }

    private static func trim(_ s: String) -> String {
        guard s.contains(".") else { return s }
        var t = s
        while t.hasSuffix("0") { t.removeLast() }
        if t.hasSuffix(".") { t.removeLast() }
        return t
    }
}
