import Foundation

/// The Monitors pane's one read (`monitor:summary`, FD-1): the computer's
/// hardware load and temperatures, its working chats, the approvals and
/// questions waiting across chats, and the next automation runs. The computer
/// builds it in the phone gate (`phoneMonitorView` in packages/shared
/// phone-views.ts, `phone_views.rs`), capped and without process names, paths
/// or a tool's input; the phone shows it as is.
public struct MonitorSummary: Equatable, Sendable {
    public struct Cpu: Equatable, Sendable {
        public let loadPct: Double?
        public let cores: Int?
        public let tempC: Double?
    }

    public struct Memory: Equatable, Sendable {
        public let usedMB: Double?
        public let totalMB: Double?
        public let tempC: Double?

        /// Used over total, 0 to 1, when both are known.
        public var fraction: Double? {
            guard let usedMB, let totalMB, totalMB > 0 else { return nil }
            return min(1, max(0, usedMB / totalMB))
        }
    }

    public struct Gpu: Equatable, Sendable {
        /// The busiest device's load.
        public let loadPct: Double?
        /// The hottest device's temperature, else the system sensor's.
        public let tempC: Double?
        public let memoryUsedMB: Double?
        public let memoryTotalMB: Double?
        /// Apple Silicon: the GPU shares the computer's memory.
        public let unified: Bool

        public var memoryFraction: Double? {
            guard let memoryUsedMB, let memoryTotalMB, memoryTotalMB > 0 else { return nil }
            return min(1, max(0, memoryUsedMB / memoryTotalMB))
        }
    }

    public struct Hardware: Equatable, Sendable {
        public let cpu: Cpu
        public let memory: Memory
        /// Nil without a GPU probe or sensor.
        public let gpu: Gpu?
    }

    /// What a working chat is doing, coarsely (the computer doesn't name the tool yet).
    public enum Step: String, Equatable, Sendable {
        case approval, question, working
    }

    public struct Running: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let step: Step
        /// Since its turn started; nil when the computer didn't say.
        public let elapsedMs: Int64?
    }

    public struct NeedsYou: Equatable, Sendable, Identifiable {
        public enum Kind: String, Equatable, Sendable {
            case approval, question
        }

        public let sessionId: String
        public let title: String
        public let kind: Kind
        public let callId: String
        /// An approval's risk; nil for a question.
        public let risk: Severity?
        /// The tool's name, or the first question.
        public let label: String
        /// How many questions a question asks.
        public let count: Int
        public let since: Int64?

        public var id: String { "\(sessionId)/\(kind.rawValue)/\(callId)" }
    }

    public struct Automation: Equatable, Sendable, Identifiable {
        public enum Kind: String, Equatable, Sendable {
            case task, workflow
        }

        public let kind: Kind
        public let automationId: String
        public let name: String
        public let nextRunAt: Int64

        public var id: String { "\(kind.rawValue)/\(automationId)" }
    }

    public let hardware: Hardware
    public let running: [Running]
    public let needsYou: [NeedsYou]
    public let automations: [Automation]

    /// Nil for anything but an object; missing parts read as empty.
    public static func from(_ v: JSONValue?) -> MonitorSummary? {
        guard let v, v.object != nil else { return nil }
        let hw = v["hardware"]
        let cpu = hw?["cpu"], mem = hw?["memory"]
        var gpu: Gpu?
        if let g = hw?["gpu"], g.object != nil {
            gpu = Gpu(loadPct: g.dbl("loadPct"), tempC: g.dbl("tempC"), memoryUsedMB: g.dbl("memoryUsedMB"),
                      memoryTotalMB: g.dbl("memoryTotalMB"), unified: g.flag("unified"))
        }
        let hardware = Hardware(
            cpu: Cpu(loadPct: cpu?.dbl("loadPct"), cores: cpu?.long("cores").map(Int.init), tempC: cpu?.dbl("tempC")),
            memory: Memory(usedMB: mem?.dbl("usedMB"), totalMB: mem?.dbl("totalMB"), tempC: mem?.dbl("tempC")),
            gpu: gpu)
        let running: [Running] = (v["running"]?.array ?? []).compactMap { r in
            guard let id = r.str("id") else { return nil }
            return Running(id: id, title: r.str("title") ?? "", step: r.str("step").flatMap(Step.init(rawValue:)) ?? .working,
                           elapsedMs: r.long("elapsedMs"))
        }
        let needsYou: [NeedsYou] = (v["needsYou"]?.array ?? []).compactMap { n in
            guard let sid = n.str("sessionId"), let callId = n.str("callId"),
                  let kind = n.str("kind").flatMap(NeedsYou.Kind.init(rawValue:)) else { return nil }
            return NeedsYou(sessionId: sid, title: n.str("title") ?? "", kind: kind, callId: callId,
                            risk: kind == .approval ? Severity.parse(n.str("risk") ?? "medium") : nil,
                            label: n.str("label") ?? "", count: Int(n.long("count") ?? 0), since: n.long("since"))
        }
        let automations: [Automation] = (v["automations"]?.array ?? []).compactMap { a in
            guard let kind = a.str("kind").flatMap(Automation.Kind.init(rawValue:)), let id = a.str("id"),
                  let next = a.long("nextRunAt") else { return nil }
            return Automation(kind: kind, automationId: id, name: a.str("name") ?? "", nextRunAt: next)
        }
        return MonitorSummary(hardware: hardware, running: running, needsYou: needsYou, automations: automations)
    }
}
