import Foundation
import NekkoProtocol

/// The organizations' computers that run CI runners (decision 0064), as the paired
/// computer reads them from its sealed fleet and the phone gate lets through.
public struct FleetRunnerComputer: Identifiable, Equatable, Sendable {
    public struct Runner: Equatable, Sendable {
        public let label: String
        public let state: String
        public let busy: Int
        public let slots: Int
    }

    public var id: String { "\(org)/\(deviceId)" }
    public let org: String
    public let deviceId: String
    public let name: String
    public let online: Bool
    public let you: Bool
    public let runners: [Runner]

    /// One line per runner, worded as the desktop's fleet view. None while offline: the state is stale.
    public var lines: [String] {
        guard online else { return [] }
        return runners.map { r in
            let what: String
            if r.busy > 0 {
                what = "running \(r.busy == 1 ? "a job" : "\(r.busy) jobs") (\(r.busy) of \(max(r.slots, r.busy)) VMs)"
            } else {
                switch r.state {
                case "off": what = "off"
                case "waiting": what = "waiting"
                case "ready": what = "ready (\(r.slots) \(r.slots == 1 ? "VM" : "VMs"))"
                case "running": what = "starting a job"
                case "draining": what = "finishing a job"
                case "cleaning": what = "cleaning up"
                case "error": what = "needs attention"
                default: what = r.state
                }
            }
            return "CI runner \(r.label): \(what)"
        }
    }

    /// Every computer with runners, in the order the computer listed them. Malformed rows are dropped.
    public static func list(_ value: JSONValue) -> [FleetRunnerComputer] {
        (value["orgs"]?.array ?? []).flatMap { org -> [FleetRunnerComputer] in
            let orgName = org.str("orgName") ?? ""
            return (org["computers"]?.array ?? []).compactMap { c in
                guard let deviceId = c.str("deviceId"), let name = c.str("name") else { return nil }
                let runners = (c["runners"]?.array ?? []).compactMap { r -> Runner? in
                    guard let label = r.str("label"), let state = r.str("state") else { return nil }
                    return Runner(label: label, state: state, busy: Int(r.long("busy") ?? 0), slots: Int(r.long("slots") ?? 0))
                }
                guard !runners.isEmpty else { return nil }
                return FleetRunnerComputer(org: orgName, deviceId: deviceId, name: name,
                                           online: c["online"]?.bool ?? false, you: c["you"]?.bool ?? false, runners: runners)
            }
        }
    }
}
