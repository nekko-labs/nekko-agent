//! The host's own networks for the runner NAT's egress check
//! ([`nekko_runner::guest_may_connect`]): every interface address and every
//! on-link prefix, read with `getifaddrs`. A stale list lets a guest reach the
//! Mac's new addresses, so the supervisor keeps it fresh with [`spawn_refresh`].

use nekko_runner::HostNets;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Every address on every interface, and its prefix. On a read failure the
/// list is empty, which still refuses every private and local range
/// statically; the next refresh retries.
pub fn current() -> HostNets {
    let ifs = if_addrs::get_if_addrs().unwrap_or_default();
    let addrs = ifs.iter().map(|i| i.ip()).collect();
    let prefixes = ifs
        .iter()
        .map(|i| match &i.addr {
            if_addrs::IfAddr::V4(a) => (a.ip.into(), a.prefixlen),
            if_addrs::IfAddr::V6(a) => (a.ip.into(), a.prefixlen),
        })
        .collect();
    HostNets::new(addrs, prefixes)
}

/// Re-reads [`current`] every `every` (5 s in P1) for as long as the runtime runs.
pub fn spawn_refresh(host: Arc<RwLock<HostNets>>, every: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            let now = current();
            if let Ok(mut h) = host.write()
                && *h != now
            {
                *h = now;
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn current_includes_loopback() {
        assert!(current().contains(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }
}
