import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Is this device on a tailnet right now? Tailscale gives every device an
/// address in 100.64.0.0/10 on its tunnel interface while it is connected, and
/// removes it when Tailscale is off, so the interface list answers without any
/// Tailscale API or VPN entitlement. Used to say "turn Tailscale on" instead of
/// a bare "can't reach your computer" when the relay is a tailnet address.
public enum Tailnet {
    public static func deviceAddresses() -> [String] {
        var out: [String] = []
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return out }
        defer { freeifaddrs(head) }
        var cur: UnsafeMutablePointer<ifaddrs>? = first
        while let p = cur {
            if let sa = p.pointee.ifa_addr, Int32(sa.pointee.sa_family) == AF_INET {
                var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
                    var addr = sin.pointee.sin_addr
                    _ = inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN))
                }
                out.append(String(cString: buf))
            }
            cur = p.pointee.ifa_next
        }
        return out
    }

    /// True when one of `addresses` is a Tailscale address.
    public static func isConnected(addresses: [String]) -> Bool {
        addresses.contains(where: RelayRoute.isTailscaleIPv4)
    }

    public static var isConnected: Bool { isConnected(addresses: deviceAddresses()) }
}
