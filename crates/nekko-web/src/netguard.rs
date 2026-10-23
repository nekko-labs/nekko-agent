//! Which network destinations are public, for every fetch the daemon makes
//! on someone else's say-so: `fetch_url` (the agent, possibly steered by a
//! page it read) and `image:fetch` (a photo URL in a reply).
//!
//! Loopback, private (RFC 1918), link-local (169.254.169.254, the cloud
//! metadata address), CGNAT, unique-local, multicast and reserved ranges are
//! not public, and nor are names such as `localhost` or `printer.local`. The
//! check runs inside the HTTP client's own DNS resolver ([`PublicOnly`]), so
//! the address that is checked is the address that is dialed (no
//! DNS-rebinding gap); clients that use it must not use a proxy, which would
//! resolve the name itself.

use futures_util::future::BoxFuture;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use url::{Host, Url};

/// `publicIPv4`.
fn public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    if a == 0 || a == 10 || a == 127 || a >= 224 {
        return false; // this-net, private, loopback, multicast + reserved
    }
    if a == 100 && (64..=127).contains(&b) {
        return false; // CGNAT
    }
    if a == 169 && b == 254 {
        return false; // link-local, cloud metadata
    }
    if a == 172 && (16..=31).contains(&b) {
        return false;
    }
    if a == 192 && b == 168 {
        return false;
    }
    if a == 192 && b == 0 && (c == 0 || c == 2) {
        return false; // IETF, TEST-NET-1
    }
    if a == 198 && (b == 18 || b == 19) {
        return false; // benchmarking
    }
    if a == 198 && b == 51 && c == 100 {
        return false; // TEST-NET-2
    }
    if a == 203 && b == 0 && c == 113 {
        return false; // TEST-NET-3
    }
    true
}

/// The IPv4 address in an IPv6 address's last two groups.
fn tail_ipv4(g: &[u16; 8]) -> Ipv4Addr {
    Ipv4Addr::new((g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8)
}

/// The IPv6 half of `isPublicAddress`, on its eight groups.
fn public_ipv6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    if g.iter().all(|&x| x == 0) {
        return false; // ::
    }
    if g[..7].iter().all(|&x| x == 0) && g[7] == 1 {
        return false; // ::1
    }
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
    if g[..5].iter().all(|&x| x == 0) && (g[5] == 0xffff || g[5] == 0) {
        return public_ipv4(tail_ipv4(&g));
    }
    if g[0] == 0x64 && g[1] == 0xff9b {
        return public_ipv4(tail_ipv4(&g)); // NAT64
    }
    if (g[0] & 0xfe00) == 0xfc00 {
        return false; // unique local
    }
    if (g[0] & 0xffc0) == 0xfe80 {
        return false; // link-local
    }
    if (g[0] & 0xffc0) == 0xfec0 {
        return false; // site-local (deprecated)
    }
    if (g[0] & 0xff00) == 0xff00 {
        return false; // multicast
    }
    if g[0] == 0x2001 && g[1] == 0x0db8 {
        return false; // documentation
    }
    if g[0] == 0x2002 {
        return false; // 6to4 can tunnel to any IPv4, private ones included
    }
    if g[0] == 0x2001 && g[1] == 0 {
        return false; // Teredo, same reason
    }
    true
}

/// A parsed address is on the public internet.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_ipv4(v4),
        IpAddr::V6(v6) => public_ipv6(v6),
    }
}

/// `isPublicAddress`: true only for an address on the public internet.
/// Anything unparseable is not.
pub fn is_public_address(ip: &str) -> bool {
    let bare = ip.split('%').next().unwrap_or_default();
    if bare.parse::<Ipv4Addr>().is_ok() {
        // The TS reads the dotted quad from the whole string, zone included, so a zone fails it.
        return ip.parse::<Ipv4Addr>().is_ok_and(public_ipv4);
    }
    bare.parse::<Ipv6Addr>().is_ok_and(public_ipv6)
}

/// A host name that only ever means this computer or the local network.
pub fn local_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
}

/// How a URL's host is written down for comparing: lower case, no IPv6
/// brackets, no trailing dot.
pub fn host_key(url: &Url) -> String {
    match url.host() {
        Some(Host::Domain(d)) => d.trim_end_matches('.').to_ascii_lowercase(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => String::new(),
    }
}

/// The URL's host when it is local before any DNS is asked: a local name or a
/// non-public address literal. A public-looking name can still resolve to a
/// local address; [`PublicOnly`] catches that when it is dialed.
pub fn local_host(url: &Url) -> Option<String> {
    let local = match url.host() {
        None => true,
        Some(Host::Domain(d)) => local_name(d),
        Some(Host::Ipv4(ip)) => !public_ipv4(ip),
        Some(Host::Ipv6(ip)) => !public_ipv6(ip),
    };
    local.then(|| host_key(url))
}

/// A name lookup: the addresses a host name resolves to.
pub type Lookup = dyn Fn(String) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> + Send + Sync;

/// A name that resolved to a private or local address (`EBLOCKED`).
#[derive(Debug)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} resolves to a private or local address.", self.0)
    }
}

impl std::error::Error for Blocked {}

/// A name that did not resolve (`ENOTFOUND`).
#[derive(Debug)]
pub struct NotFound(pub std::io::Error);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for NotFound {}

/// `publicOnlyLookup`: a resolver that resolves as usual and then refuses the
/// connection unless every address is public. Checking *all* of them, not
/// just the first, stops a name that answers with one public and one private
/// address from being dialed on the private one by Happy Eyeballs.
///
/// Names in `allowed` (as [`host_key`] writes them) skip the check: the user
/// approved reaching that host on the local network.
pub struct PublicOnly {
    lookup: Arc<Lookup>,
    allowed: Arc<HashSet<String>>,
}

impl PublicOnly {
    /// The system resolver.
    pub fn system() -> Self {
        Self::with_lookup(Arc::new(|host: String| {
            Box::pin(async move { Ok(tokio::net::lookup_host((host.as_str(), 0)).await?.collect()) })
        }))
    }

    /// Another resolver, for tests.
    pub fn with_lookup(lookup: Arc<Lookup>) -> Self {
        Self { lookup, allowed: Arc::new(HashSet::new()) }
    }

    /// Let these hosts resolve to local addresses.
    pub fn allowing(mut self, hosts: HashSet<String>) -> Self {
        self.allowed = Arc::new(hosts);
        self
    }

    /// The host's addresses, or [`Blocked`] when any of them is not public.
    pub async fn resolve_public(
        &self,
        host: String,
    ) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
        let list = (self.lookup)(host.clone()).await.map_err(NotFound)?;
        let key = host.trim_end_matches('.').to_ascii_lowercase();
        if self.allowed.contains(&key) && !list.is_empty() {
            return Ok(list);
        }
        if list.is_empty() || list.iter().any(|a| !public_ip(a.ip())) {
            return Err(Box::new(Blocked(host)));
        }
        Ok(list)
    }
}

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let me = Self { lookup: Arc::clone(&self.lookup), allowed: Arc::clone(&self.allowed) };
        let host = name.as_str().to_string();
        Box::pin(async move {
            let list = me.resolve_public(host).await?;
            Ok(Box::new(list.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The request failed because [`PublicOnly`] refused the host.
pub fn is_blocked(e: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(s) = source {
        if s.downcast_ref::<Blocked>().is_some() {
            return true;
        }
        source = s.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(answers: &'static [&'static str]) -> PublicOnly {
        PublicOnly::with_lookup(Arc::new(move |_host: String| {
            Box::pin(async move { Ok(answers.iter().map(|a| SocketAddr::new(a.parse().unwrap(), 0)).collect()) })
        }))
    }

    #[test]
    fn local_hosts_are_known_before_dns() {
        for (url, local) in [
            ("http://localhost:3000/", Some("localhost")),
            ("http://LOCALHOST./", Some("localhost")),
            ("http://app.localhost/", Some("app.localhost")),
            ("http://printer.local/", Some("printer.local")),
            ("http://metadata.google.internal/", Some("metadata.google.internal")),
            ("http://router.home.arpa/", Some("router.home.arpa")),
            ("http://127.0.0.1:8080/", Some("127.0.0.1")),
            ("http://0x7f.1/", Some("127.0.0.1")),
            ("http://2130706433/", Some("127.0.0.1")),
            ("http://169.254.169.254/latest/meta-data/", Some("169.254.169.254")),
            ("http://10.0.0.1/", Some("10.0.0.1")),
            ("http://192.168.1.1/", Some("192.168.1.1")),
            ("http://100.64.0.1/", Some("100.64.0.1")),
            ("http://[::1]/", Some("::1")),
            ("http://[fd00::1]/", Some("fd00::1")),
            ("http://[::ffff:10.0.0.1]/", Some("::ffff:10.0.0.1")),
            ("https://example.com/", None),
            ("http://8.8.8.8/", None),
        ] {
            let u = Url::parse(url).unwrap();
            assert_eq!(local_host(&u).as_deref(), local, "{url}");
        }
    }

    #[tokio::test]
    async fn the_resolver_refuses_any_private_answer_unless_approved() {
        assert!(fake(&["93.184.216.34"]).resolve_public("example.com".into()).await.is_ok());
        let e = fake(&["127.0.0.1"]).resolve_public("rebind.example".into()).await.unwrap_err();
        assert_eq!(e.to_string(), "rebind.example resolves to a private or local address.");
        assert!(fake(&["93.184.216.34", "10.0.0.5"]).resolve_public("example.com".into()).await.is_err());
        assert!(fake(&[]).resolve_public("example.com".into()).await.is_err());
        let approved = fake(&["127.0.0.1"]).allowing(HashSet::from(["dev.example".to_string()]));
        assert!(approved.resolve_public("dev.example.".into()).await.is_ok());
        assert!(approved.resolve_public("other.example".into()).await.is_err());
    }
}
