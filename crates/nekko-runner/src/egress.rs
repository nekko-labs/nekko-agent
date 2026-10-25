//! Guest egress: which addresses a job VM may connect to. The userspace NAT
//! asks [`guest_may_connect`] on every connection, after DNS resolution. It
//! combines the static allow-list [`guest_may_reach`] with the host's own
//! networks ([`HostNets`]), because a LAN with global IPv6 or a Mac with a
//! public IPv4 is not covered by any static range.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The static half of the egress check: whether `ip` is globally reachable
/// unicast. Every special-purpose range is denied, not just the ones we know
/// about today. Embedded IPv4 (mapped, NAT64, 6to4) is judged as that IPv4,
/// so it cannot be used to tunnel past the IPv4 rules. Explicit masks, not
/// unstable `Ipv4Addr::is_global`.
///
/// NOT enough on its own: most LANs give the Mac and every device on them
/// global IPv6 addresses, and a Mac or router may hold a public IPv4, all of
/// which pass this check. The NAT must call [`guest_may_connect`].
pub fn guest_may_reach(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_ok(v4),
        IpAddr::V6(v6) => v6_ok(v6),
    }
}

fn v4_ok(ip: Ipv4Addr) -> bool {
    let a = u32::from(ip);
    // (network, prefix length)
    const DENY: [(u32, u32); 15] = [
        (0x0000_0000, 8),  // 0.0.0.0/8
        (0x0A00_0000, 8),  // 10/8
        (0x6440_0000, 10), // 100.64/10 (CGNAT, Tailscale)
        (0x7F00_0000, 8),  // loopback
        (0xA9FE_0000, 16), // link-local
        (0xAC10_0000, 12), // 172.16/12
        (0xC000_0000, 24), // 192.0.0.0/24
        (0xC000_0200, 24), // TEST-NET-1
        (0xC058_6300, 24), // 192.88.99.0/24
        (0xC0A8_0000, 16), // 192.168/16
        (0xC612_0000, 15), // 198.18/15
        (0xC633_6400, 24), // TEST-NET-2
        (0xCB00_7100, 24), // TEST-NET-3
        (0xE000_0000, 4),  // multicast
        (0xF000_0000, 4),  // reserved, incl. broadcast
    ];
    !DENY.iter().any(|&(net, len)| a >> (32 - len) == net >> (32 - len))
}

fn v6_ok(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96
    if s[..5] == [0; 5] && s[5] == 0xffff || s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return v4_ok(embedded(s[6], s[7]));
    }
    // 6to4 2002::/16
    if s[0] == 0x2002 {
        return v4_ok(embedded(s[1], s[2]));
    }
    let [s0, s1, s2, s3, ..] = s;
    let special = (s0 == 0x0100 && s1 == 0 && s2 == 0 && s3 == 0) // 100::/64
        || (s0 == 0x2001 && s1 < 0x0200) // 2001::/23, incl. Teredo
        || (s0 == 0x2001 && s1 == 0x0db8); // documentation
    // Only 2000::/3 is global unicast; this also drops ::, ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8.
    s0 & 0xe000 == 0x2000 && !special
}

/// The host's own networks, which a guest must never reach even when they
/// are public: every interface address, every on-link prefix of every host
/// interface, and known WAN or gateway public addresses (in `addrs`). The
/// supervisor rebuilds it whenever the host's network changes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostNets {
    addrs: Vec<IpAddr>,
    prefixes: Vec<(IpAddr, u8)>,
}

impl HostNets {
    pub fn new(addrs: Vec<IpAddr>, prefixes: Vec<(IpAddr, u8)>) -> Self {
        Self { addrs, prefixes }
    }

    /// Exact address match, or inside any prefix of the same family.
    /// IPv4-mapped IPv6 is judged as IPv4; prefix lengths are clamped to the
    /// family maximum.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        self.addrs.iter().any(|a| a.to_canonical() == ip)
            || self.prefixes.iter().any(|&(net, len)| in_prefix(ip, net.to_canonical(), len))
    }
}

fn in_prefix(ip: IpAddr, net: IpAddr, len: u8) -> bool {
    let (a, b, width) = match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(b)) => (u128::from(u32::from(a)), u128::from(u32::from(b)), 32),
        (IpAddr::V6(a), IpAddr::V6(b)) => (u128::from(a), u128::from(b), 128),
        _ => return false,
    };
    // A /0 shifts by the full width, which `checked_shr` turns into "every address matches".
    let shift = width - u32::from(len).min(width);
    a.checked_shr(shift).unwrap_or(0) == b.checked_shr(shift).unwrap_or(0)
}

/// SECURITY BOUNDARY: whether a job VM may open a connection to `ip`. The
/// userspace NAT calls this on every connection, after DNS resolution, so a
/// job (which runs untrusted code) can reach only the public internet and
/// never the host, the LAN, Tailscale peers or anything local. `host` must be
/// refreshed whenever the host's network changes; a stale one lets the guest
/// reach the Mac's new addresses.
pub fn guest_may_connect(ip: IpAddr, host: &HostNets) -> bool {
    guest_may_reach(ip) && !host.contains(ip)
}
