//! The host's own networks for the runner NAT's egress check
//! ([`nekko_runner::guest_may_connect`]): every interface address and every
//! on-link prefix, read with `getifaddrs`. A stale list lets a guest reach the
//! Mac's new addresses, so the supervisor keeps it fresh with [`spawn_refresh`].

use nekko_runner::HostNets;
use std::io;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Every address on every interface, and its prefix.
pub fn try_current() -> io::Result<HostNets> {
    let ifs = if_addrs::get_if_addrs()?;
    let addrs = ifs.iter().map(|i| i.ip()).collect();
    let prefixes = ifs
        .iter()
        .map(|i| match &i.addr {
            if_addrs::IfAddr::V4(a) => (a.ip.into(), a.prefixlen),
            if_addrs::IfAddr::V6(a) => (a.ip.into(), a.prefixlen),
        })
        .collect();
    Ok(HostNets::new(addrs, prefixes))
}

/// Re-reads the host's networks every `every` (5 s in P1) for as long as the runtime runs.
pub fn spawn_refresh(host: Arc<RwLock<HostNets>>, every: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            refresh(&host, try_current);
        }
    })
}

/// One refresh step. A read error keeps the previous list: an empty one
/// would let the guest reach the Mac's public addresses.
fn refresh(host: &RwLock<HostNets>, read: impl FnOnce() -> io::Result<HostNets>) {
    let Ok(now) = read() else { return };
    if let Ok(mut h) = host.write()
        && *h != now
    {
        *h = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn try_current_includes_loopback() {
        assert!(try_current().unwrap().contains(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[test]
    fn refresh_keeps_the_previous_list_on_a_read_error() {
        let mac = IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34));
        let host = RwLock::new(HostNets::new(vec![mac], vec![]));
        refresh(&host, || Err(io::Error::other("getifaddrs failed")));
        assert!(host.read().unwrap().contains(mac));
        refresh(&host, || Ok(HostNets::default()));
        assert!(!host.read().unwrap().contains(mac));
    }
}
