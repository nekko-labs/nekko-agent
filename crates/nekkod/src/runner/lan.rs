//! Which network the Mac is on, for the trusted-networks gate: the router's
//! hardware address, read from the system's network state, or from
//! `route -n get default` and `arp -n <gateway>` when that has none.
//! An SSID needs Location access on current macOS; the router's MAC does not,
//! and it tells two networks with the same name apart.
//!
//! Also the job NAT's view of the LAN: which resolvers DNS goes to, and the
//! router's public address, learned from the router itself (NAT-PMP or UPnP),
//! so the guest can be refused it. Nothing here makes an internet lookup.
//!
//! Self-contained (no `crate::` paths): the VM spike includes it with `#[path]`.

use nekko_runner::{HostNets, guest_may_connect};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

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
    gw_id(line.split_whitespace().skip_while(|w| *w != "at").nth(1)?)
}

fn gw_id(mac: &str) -> Option<String> {
    let octets: Vec<u8> = mac.split(':').map(|o| u8::from_str_radix(o, 16)).collect::<Result<_, _>>().ok()?;
    (octets.len() == 6)
        .then(|| format!("gw:{}", octets.iter().map(|o| format!("{o:02x}")).collect::<Vec<_>>().join(":")))
}

/// A `key : value` line of `scutil`'s `show` output.
pub fn scutil_field<'a>(show: &'a str, key: &str) -> Option<&'a str> {
    show.lines().find_map(|l| Some(l.trim().strip_prefix(key)?.trim_start().strip_prefix(':')?.trim()))
}

/// The same `gw:` id from a network service's `show State:/Network/Service/<id>/IPv4`:
/// macOS records the router it resolved there, so this works without Local Network
/// permission, which hides the whole ARP table from `arp`. `None` when that address
/// belongs to some other router than the service's current one.
pub fn service_network_id(ipv4: &str) -> Option<String> {
    let resolved = scutil_field(ipv4, "ARPResolvedIPAddress")?;
    (resolved == scutil_field(ipv4, "Router")?).then(|| gw_id(scutil_field(ipv4, "ARPResolvedHardwareAddress")?))?
}

/// Where DNS goes when the physical interface has no usable resolver.
pub const FALLBACK_DNS: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), 53),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 53),
];

/// The NAT's DNS upstreams: the IPv4 nameservers `scutil --dns` scopes to
/// interface `if_index` (the physical one), keeping only addresses a guest
/// may connect to. DNS over TCP is a raw pipe to the upstream, so a LAN
/// resolver (the home router), loopback, link-local or Tailscale's
/// 100.100.100.100 would hand the guest a stream it may not have; none of
/// them pass [`guest_may_connect`]. None left: [`FALLBACK_DNS`].
pub fn dns_upstreams(scutil_dns: &str, if_index: u32, host: &HostNets) -> Vec<SocketAddr> {
    let scoped = scutil_dns.split("DNS configuration (for scoped queries)").nth(1).unwrap_or("");
    let index = |b: &str| {
        b.lines().find_map(|l| {
            l.trim().strip_prefix("if_index")?.trim().strip_prefix(':')?.split_whitespace().next()?.parse::<u32>().ok()
        })
    };
    let ups: Vec<SocketAddr> = scoped
        .split("resolver #")
        .filter(|b| index(b) == Some(if_index))
        .flat_map(|b| b.lines())
        .filter_map(|l| {
            let (key, ip) = l.trim().split_once(':')?;
            key.trim().starts_with("nameserver[").then_some(())?;
            ip.trim().parse::<Ipv4Addr>().ok()
        })
        .filter(|&ip| guest_may_connect(ip.into(), host))
        .map(|ip| SocketAddr::new(ip.into(), 53))
        .collect();
    if ups.is_empty() { FALLBACK_DNS.to_vec() } else { ups }
}

/// The external address in a NAT-PMP reply (RFC 6886: version 0, op 128,
/// result 0, 12 bytes).
pub fn natpmp_external(reply: &[u8]) -> Option<Ipv4Addr> {
    match reply {
        [0, 128, 0, 0, _, _, _, _, a, b, c, d] => Some(Ipv4Addr::new(*a, *b, *c, *d)),
        _ => None,
    }
}

/// The LOCATION of an SSDP reply, only when it came from the gateway and
/// points at the gateway: nobody else on the LAN gets to name our router.
pub fn ssdp_location(reply: &str, from: IpAddr, gateway: Ipv4Addr) -> Option<String> {
    if from.to_canonical() != IpAddr::V4(gateway) {
        return None;
    }
    let loc = reply.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("location").then(|| v.trim().to_owned())
    })?;
    (same_host(&loc, gateway)).then_some(loc)
}

fn same_host(url: &str, gateway: Ipv4Addr) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.scheme() == "http" && u.host() == Some(url::Host::Ipv4(gateway)))
}

/// The WAN connection service of an IGD description: (serviceType, control
/// URL on the description's own host).
// shortcut: plain tag search, no XML parser; enough for IGD descriptions, upgrade if a router uses prefixed tags.
fn igd_service(description_xml: &str, location: &str) -> Option<(String, String)> {
    let base = url::Url::parse(location).ok()?;
    let tag = |s: &str, t: &str| -> Option<String> {
        let start = s.find(&format!("<{t}>"))? + t.len() + 2;
        Some(s[start..start + s[start..].find(&format!("</{t}>"))?].trim().to_owned())
    };
    description_xml.split("<service>").skip(1).find_map(|svc| {
        let ty = tag(svc, "serviceType")?;
        if !ty.contains(":WANIPConnection:") && !ty.contains(":WANPPPConnection:") {
            return None;
        }
        let control = base.join(&tag(svc, "controlURL")?).ok()?;
        (control.host() == base.host() && control.port_or_known_default() == base.port_or_known_default())
            .then(|| (ty, control.into()))
    })
}

/// The WANIPConnection or WANPPPConnection control URL, on the description's host only.
pub fn igd_control_url(description_xml: &str, location: &str) -> Option<String> {
    igd_service(description_xml, location).map(|(_, url)| url)
}

/// `NewExternalIPAddress` from a `GetExternalIPAddress` SOAP reply.
pub fn soap_external_ip(xml: &str) -> Option<IpAddr> {
    let start = xml.find("NewExternalIPAddress>")? + "NewExternalIPAddress>".len();
    let ip: IpAddr = xml[start..start + xml[start..].find('<')?].trim().parse().ok()?;
    (!ip.is_unspecified()).then_some(ip)
}

/// Asks the gateway's NAT-PMP port for its external address: 2 tries, 250 ms each.
pub async fn natpmp(gateway: SocketAddr) -> Option<Ipv4Addr> {
    let any: SocketAddr =
        if gateway.is_ipv4() { ([0, 0, 0, 0], 0).into() } else { (std::net::Ipv6Addr::UNSPECIFIED, 0).into() };
    let s = tokio::net::UdpSocket::bind(any).await.ok()?;
    s.connect(gateway).await.ok()?;
    let mut buf = [0u8; 16];
    for _ in 0..2 {
        s.send(&[0, 0]).await.ok()?;
        if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(250), s.recv(&mut buf)).await
            && let Some(ip) = natpmp_external(&buf[..n])
        {
            return Some(ip);
        }
    }
    None
}

/// The router's public (WAN) address, asked of the router: NAT-PMP, then
/// UPnP (SSDP search, the device description, `GetExternalIPAddress`), 3 s in
/// all. Every request goes to `gateway` only, never to the internet. Empty
/// when the router answers neither.
pub async fn discover_wan(gateway: Ipv4Addr) -> Vec<IpAddr> {
    let ask = async {
        if let Some(ip) = natpmp(SocketAddr::new(gateway.into(), 5351)).await {
            return Some(IpAddr::V4(ip));
        }
        upnp(gateway).await
    };
    tokio::time::timeout(Duration::from_secs(3), ask).await.ok().flatten().into_iter().collect()
}

async fn upnp(gateway: Ipv4Addr) -> Option<IpAddr> {
    let s = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
    let search = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
    s.send_to(search.as_bytes(), "239.255.255.250:1900").await.ok()?;
    let mut buf = [0u8; 2048];
    let location = loop {
        let (n, from) = s.recv_from(&mut buf).await.ok()?;
        if let Some(l) = ssdp_location(&String::from_utf8_lossy(&buf[..n]), from.ip(), gateway) {
            break l;
        }
    };
    // No proxy and no redirects: every request stays on the gateway.
    let http = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let desc = http.get(&location).send().await.ok()?.text().await.ok()?;
    let (ty, control) = igd_service(&desc, &location)?;
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:GetExternalIPAddress xmlns:u=\"{ty}\"/></s:Body></s:Envelope>"
    );
    let reply = http
        .post(control)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{ty}#GetExternalIPAddress\""))
        .body(body)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    soap_external_ip(&reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_runner::HostNets;

    const SCUTIL: &str = include_str!("../../tests/fixtures/runner/scutil-dns.txt");

    fn lan() -> HostNets {
        HostNets::new(
            vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))],
            vec![(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 0)), 24)],
        )
    }

    #[test]
    fn dns_upstreams_use_the_physical_interfaces_resolvers() {
        // Scoped en0 only: the router (on-link), IPv6, loopback and link-local are dropped.
        assert_eq!(dns_upstreams(SCUTIL, 4, &lan()), vec![SocketAddr::from(([9, 9, 9, 9], 53))]);
        assert_eq!(dns_upstreams(SCUTIL, 20, &lan()), FALLBACK_DNS);
        assert_eq!(dns_upstreams(SCUTIL, 99, &lan()), FALLBACK_DNS);
    }

    #[test]
    fn dns_upstreams_never_use_an_on_link_resolver() {
        // DNS over TCP is a raw pipe to the upstream: a LAN resolver would hand the guest a LAN stream.
        let router_only = "DNS configuration (for scoped queries)\n\nresolver #1\n  nameserver[0] : 192.168.1.1\n  if_index : 4 (en0)\n";
        assert_eq!(dns_upstreams(router_only, 4, &HostNets::default()), FALLBACK_DNS);
        // A public resolver on the Mac's own (public) subnet is the LAN too.
        let on_link = HostNets::new(vec![], vec![(IpAddr::V4(Ipv4Addr::new(9, 9, 9, 0)), 24)]);
        assert_eq!(dns_upstreams(SCUTIL, 4, &on_link), FALLBACK_DNS);
    }

    #[test]
    fn natpmp_reply_parses() {
        assert_eq!(natpmp_external(&[0, 128, 0, 0, 0, 0, 0, 9, 203, 0, 113, 7]), Some(Ipv4Addr::new(203, 0, 113, 7)));
        assert_eq!(natpmp_external(&[0, 128, 0, 3, 0, 0, 0, 9, 203, 0, 113, 7]), None);
        assert_eq!(natpmp_external(&[0, 128, 0, 0, 0, 0, 0, 9, 203, 0, 113]), None);
        assert_eq!(natpmp_external(&[0, 129, 0, 0, 0, 0, 0, 9, 203, 0, 113, 7]), None);
    }

    #[tokio::test]
    async fn natpmp_asks_the_gateway() {
        let router = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = router.local_addr().unwrap();
        let serve = tokio::spawn(async move {
            let mut buf = [0u8; 16];
            let (n, from) = router.recv_from(&mut buf).await.unwrap();
            assert_eq!(&buf[..n], [0, 0]);
            router.send_to(&[0, 128, 0, 0, 0, 0, 0, 9, 203, 0, 113, 7], from).await.unwrap();
        });
        assert_eq!(natpmp(addr).await, Some(Ipv4Addr::new(203, 0, 113, 7)));
        serve.await.unwrap();
    }

    #[test]
    fn ssdp_location_only_from_the_gateway() {
        let gw = Ipv4Addr::new(192, 168, 1, 1);
        let reply = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nlocation: http://192.168.1.1:5000/rootDesc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
        assert_eq!(ssdp_location(reply, gw.into(), gw).as_deref(), Some("http://192.168.1.1:5000/rootDesc.xml"));
        assert_eq!(ssdp_location(reply, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9)), gw), None);
        let elsewhere = reply.replace("192.168.1.1:5000", "93.184.216.34");
        assert_eq!(ssdp_location(&elsewhere, gw.into(), gw), None);
        assert_eq!(ssdp_location("HTTP/1.1 200 OK\r\n\r\n", gw.into(), gw), None);
    }

    #[test]
    fn igd_control_url_and_soap_reply_parse() {
        let desc = include_str!("../../tests/fixtures/runner/igd-description.xml");
        let loc = "http://192.168.1.1:5000/rootDesc.xml";
        assert_eq!(igd_control_url(desc, loc).as_deref(), Some("http://192.168.1.1:5000/ctl/IPConn"));
        // A control URL on another host is not the router's.
        let away = desc.replace("/ctl/IPConn", "http://93.184.216.34/ctl");
        assert_eq!(igd_control_url(&away, loc), None);
        assert_eq!(igd_control_url("<root/>", loc), None);
        let soap = include_str!("../../tests/fixtures/runner/igd-external-ip.xml");
        assert_eq!(soap_external_ip(soap), Some(IpAddr::V4(Ipv4Addr::new(81, 2, 69, 160))));
        assert_eq!(soap_external_ip(&soap.replace("81.2.69.160", "0.0.0.0")), None);
        assert_eq!(soap_external_ip("<x/>"), None);
    }
}
