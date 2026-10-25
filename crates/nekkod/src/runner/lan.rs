//! Which network the Mac is on, for the trusted-networks gate: the router's
//! hardware address, read from `route -n get default` and `arp -n <gateway>`.
//! An SSID needs Location access on current macOS; the router's MAC does not,
//! and it tells two networks with the same name apart.

use std::net::Ipv4Addr;

/// The IPv4 default gateway in `route -n get default` output; `None` when the
/// default route has no IPv4 gateway (no network, or a link-scoped tunnel).
pub fn default_gateway(route_get_default: &str) -> Option<Ipv4Addr> {
    route_get_default.lines().find_map(|l| l.trim().strip_prefix("gateway:")?.trim().parse().ok())
}

/// `gw:` plus the gateway's MAC from `arp -n` output, every octet two
/// lowercase hex digits (arp drops leading zeros); `None` when unresolved.
pub fn network_id(arp_n: &str, gateway: Ipv4Addr) -> Option<String> {
    let host = format!("({gateway})");
    let line = arp_n.lines().find(|l| l.split_whitespace().nth(1) == Some(host.as_str()))?;
    let mac = line.split_whitespace().skip_while(|w| *w != "at").nth(1)?;
    let octets: Vec<u8> = mac.split(':').map(|o| u8::from_str_radix(o, 16)).collect::<Result<_, _>>().ok()?;
    (octets.len() == 6)
        .then(|| format!("gw:{}", octets.iter().map(|o| format!("{o:02x}")).collect::<Vec<_>>().join(":")))
}
