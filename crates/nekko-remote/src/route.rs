//! The relay transport rule (TASKS.md PH1): `wss://` anywhere; plain `ws://`
//! only toward private networks (a Tailscale tailnet, the LAN, loopback). The
//! same rules as `packages/shared/src/relay-route.ts` and the iPhone app's
//! `RelayRoute.swift`, held equal by `tests/golden/relay-route.json`.

/// What kind of network path a relay address is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Tailscale,
    Lan,
    Loopback,
    Internet,
}

impl Route {
    pub fn as_str(self) -> &'static str {
        match self {
            Route::Tailscale => "tailscale",
            Route::Lan => "lan",
            Route::Loopback => "loopback",
            Route::Internet => "internet",
        }
    }
}

pub fn relay_route(relay_url: &str) -> Route {
    let h = relay_host(relay_url);
    if h == "localhost" || h == "::1" || ipv4(&h).is_some_and(|n| n[0] == 127) {
        return Route::Loopback;
    }
    if h == "ts.net" || h.ends_with(".ts.net") || is_tailscale_ipv4(&h) || h.starts_with("fd7a:115c:a1e0:") {
        return Route::Tailscale;
    }
    if h.ends_with(".local") || is_private_ipv4(&h) || is_private_ipv6(&h) {
        return Route::Lan;
    }
    Route::Internet
}

/// Why `relay_url` can't be this computer's relay, or `None` when it can.
pub fn relay_url_problem(relay_url: &str) -> Option<String> {
    let url = relay_url.trim();
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("wss://").or_else(|| lower.strip_prefix("ws://"));
    let has_host = rest.and_then(|r| r.chars().next()).is_some_and(|c| !matches!(c, '/' | '?' | '#'));
    if !has_host {
        return Some("A relay address starts with wss:// (or ws:// on your Tailscale network or LAN).".into());
    }
    if lower.starts_with("ws://") && relay_route(url) == Route::Internet {
        return Some(
            "This relay is not encrypted (ws://) and is on the open internet. Use a wss:// relay, or a relay on your Tailscale network."
                .into(),
        );
    }
    None
}

/// The host part of a ws/wss/http(s) URL, lowercased, IPv6 without brackets.
pub fn relay_host(url: &str) -> String {
    let mut s = url.trim();
    if let Some(i) = s.find("://") {
        s = &s[i + 3..];
    }
    // Userinfo (`user:pass@`) only counts inside the authority, not in a path.
    let authority_end = s.find(['/', '?', '#']).unwrap_or(s.len());
    if let Some(at) = s[..authority_end].rfind('@') {
        s = &s[at + 1..];
    }
    if let Some(inner) = s.strip_prefix('[') {
        return match inner.find(']') {
            Some(end) => inner[..end].to_lowercase(),
            None => String::new(),
        };
    }
    let end = s.find(['/', ':', '?', '#']).unwrap_or(s.len());
    s[..end].to_lowercase()
}

fn ipv4(h: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u32; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
        if out[i] > 255 {
            return None;
        }
    }
    Some(out)
}

/// 100.64.0.0/10: the range Tailscale gives every device on a tailnet.
pub fn is_tailscale_ipv4(h: &str) -> bool {
    ipv4(h).is_some_and(|n| n[0] == 100 && (64..=127).contains(&n[1]))
}

fn is_private_ipv4(h: &str) -> bool {
    ipv4(h).is_some_and(|n| {
        n[0] == 10
            || (n[0] == 172 && (16..=31).contains(&n[1]))
            || (n[0] == 192 && n[1] == 168)
            || (n[0] == 169 && n[1] == 254)
    })
}

fn is_private_ipv6(h: &str) -> bool {
    h.contains(':') && (h.starts_with("fc") || h.starts_with("fd") || h.starts_with("fe80:"))
}

/// Nekko Cloud Relay, the hosted relay (decision 0116). `NEKKO_CLOUD_RELAY_URL`
/// replaces it (a staging relay, or tests).
pub const CLOUD_RELAY_URL: &str = "wss://nekko-agent-relay.fly.dev";

pub fn cloud_relay_url() -> String {
    std::env::var("NEKKO_CLOUD_RELAY_URL")
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| CLOUD_RELAY_URL.to_string())
}

/// Whether `url` is Nekko Cloud Relay: the same scheme and host (and port, if any).
pub fn is_cloud_relay(url: &str) -> bool {
    let norm = |u: &str| u.trim().trim_end_matches('/').to_ascii_lowercase();
    norm(url) == norm(&cloud_relay_url())
}

/// How a device reaches this computer over a relay address: `cloud` through
/// Nekko Cloud Relay, `direct` for everything else (the relay on this computer
/// over Tailscale or the LAN, or a relay the owner runs). A device's route
/// choice (`auto`, `cloud`, `direct`) is checked against this at HELLO.
pub fn via(url: &str) -> &'static str {
    if is_cloud_relay(url) { "cloud" } else { "direct" }
}

/// The routes a device may be limited to. `auto` (or none) allows both.
pub const DEVICE_ROUTES: [&str; 3] = ["auto", "cloud", "direct"];

/// Whether a device whose route choice is `route` may come in `via`.
pub fn route_allows(route: Option<&str>, via: &str) -> bool {
    match route {
        Some("cloud") => via == "cloud",
        Some("direct") => via == "direct",
        _ => true,
    }
}

#[cfg(test)]
mod cloud_tests {
    use super::*;

    #[test]
    fn tells_nekko_cloud_relay_from_every_other_route() {
        assert!(is_cloud_relay("wss://nekko-agent-relay.fly.dev/"));
        assert!(is_cloud_relay("WSS://Nekko-Agent-Relay.fly.dev"));
        assert_eq!(via(CLOUD_RELAY_URL), "cloud");
        for other in [
            "ws://gomi.tail1234.ts.net:4400",
            "ws://192.168.1.4:4400",
            "wss://relay.example.com",
            "wss://nekko-agent-relay.fly.dev.evil.com",
        ] {
            assert_eq!(via(other), "direct", "{other}");
        }
    }

    #[test]
    fn a_route_choice_limits_how_a_device_comes_in() {
        for v in ["cloud", "direct"] {
            assert!(route_allows(None, v));
            assert!(route_allows(Some("auto"), v));
        }
        assert!(route_allows(Some("cloud"), "cloud"));
        assert!(!route_allows(Some("cloud"), "direct"));
        assert!(route_allows(Some("direct"), "direct"));
        assert!(!route_allows(Some("direct"), "cloud"));
    }
}
