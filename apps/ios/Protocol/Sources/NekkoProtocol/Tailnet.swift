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

/// Opening the Tailscale app from the connection banner and Settings →
/// Connection (TASKS.md IO-19 TS-4). iOS doesn't let another app turn a VPN on,
/// so the most this app can do is take the owner to the switch.
public enum TailscaleApp {
    /// Tailscale's URL scheme; listed in `LSApplicationQueriesSchemes` so
    /// `canOpenURL` can answer.
    public static let scheme = "tailscale"
    public static let appURL = URL(string: "tailscale://")!
    /// Tailscale on the App Store, for when the app isn't installed.
    public static let appStoreURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!

    /// Offer *Open Tailscale* when the computer is on the tailnet, Tailscale is
    /// off on this phone and the phone is trying to reach it.
    public static func shouldOffer(route: RelayRoute, tailscaleOn: Bool, state: RelayState) -> Bool {
        route == .tailscale && !tailscaleOn && (state == .connecting || state == .offline)
    }

    /// The app when it's installed, else its App Store page.
    public static func destination(installed: Bool) -> URL {
        installed ? appURL : appStoreURL
    }

    /// Open the app, or the App Store when `canOpen` says it isn't installed.
    /// Returns what was opened.
    @discardableResult
    public static func open(canOpen: (URL) -> Bool, open: (URL) -> Void) -> URL {
        let url = destination(installed: canOpen(appURL))
        open(url)
        return url
    }
}
