//! The interface job traffic leaves by, read from `nekko-vm egress`. The
//! runner NAT binds every host socket to the physical interface (see
//! `net::Direct`), so a VPN route, split or full tunnel, never carries job
//! traffic. Fails closed: until the helper's first line, and while it is
//! restarting, the state is `None` and every flow is refused.
//!
//! Self-contained (no `crate::` paths) because `net.rs` uses it and tests
//! include both with `#[path]`.

use serde::Deserialize;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Egress {
    /// (name, index) of the first wifi, wired or cellular interface, or `None`.
    pub physical: Option<(String, u32)>,
    /// A tunnel leads the default path: a full-tunnel VPN or an exit node.
    pub vpn_carries_default: bool,
    pub expensive: bool,
    pub constrained: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Line {
    physical: Option<Nic>,
    vpn_carries_default: bool,
    expensive: bool,
    constrained: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Nic {
    name: String,
    index: u32,
}

/// One line of the helper's output; `None` if it does not parse.
pub fn parse(line: &str) -> Option<Egress> {
    let l: Line = serde_json::from_str(line).ok()?;
    Some(Egress {
        physical: l.physical.map(|n| (n.name, n.index)),
        vpn_carries_default: l.vpn_carries_default,
        expensive: l.expensive,
        constrained: l.constrained,
    })
}

/// Runs `helper egress` for as long as the runtime runs, restarting it when it
/// exits, and keeps the shared state at its latest line.
pub fn spawn_watch(helper: &Path) -> Arc<RwLock<Option<Egress>>> {
    let state = Arc::new(RwLock::new(None));
    let (helper, shared) = (helper.to_path_buf(), state.clone());
    tokio::spawn(async move {
        loop {
            watch_once(&helper, &shared).await;
            set(&shared, None);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
    state
}

/// One run of the helper, until it exits or its output stops parsing.
async fn watch_once(helper: &Path, state: &RwLock<Option<Egress>>) {
    let child = tokio::process::Command::new(helper)
        .arg("egress")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn();
    let Ok(mut child) = child else { return };
    let Some(out) = child.stdout.take() else { return };
    let mut lines = BufReader::new(out).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some(e) = parse(&line) else { return };
        set(state, Some(e));
    }
}

fn set(state: &RwLock<Option<Egress>>, e: Option<Egress>) {
    if let Ok(mut s) = state.write() {
        *s = e;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_helpers_line() {
        let e = parse(
            r#"{"physical":{"index":14,"name":"en0"},"vpnCarriesDefault":true,"expensive":false,"constrained":true}"#,
        );
        assert_eq!(
            e,
            Some(Egress {
                physical: Some(("en0".into(), 14)),
                vpn_carries_default: true,
                expensive: false,
                constrained: true
            })
        );
        let none = parse(r#"{"physical":null,"vpnCarriesDefault":false,"expensive":false,"constrained":false}"#);
        assert_eq!(none.unwrap().physical, None);
        assert_eq!(parse(r#"{"ok":false,"error":"usage"}"#), None);
        assert_eq!(parse("not json"), None);
    }

    #[tokio::test]
    async fn spawn_watch_tracks_the_helper_and_forgets_it_when_it_exits() {
        let dir = std::env::temp_dir().join(format!("nekko-egress-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let helper = dir.join("nekko-vm");
        let line =
            r#"{"physical":{"name":"en0","index":4},"vpnCarriesDefault":false,"expensive":false,"constrained":false}"#;
        std::fs::write(&helper, format!("#!/bin/sh\necho '{line}'\nsleep 1\n")).unwrap();
        std::fs::set_permissions(&helper, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let state = spawn_watch(&helper);
        assert_eq!(*state.read().unwrap(), None, "unknown until the first line");
        let read = || state.read().unwrap().as_ref().and_then(|e| e.physical.clone());
        let mut seen = vec![];
        for _ in 0..70 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if seen.last() != Some(&read()) {
                seen.push(read());
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
        // Known, forgotten when the helper exits, known again after the restart.
        assert_eq!(seen[..3], [Some(("en0".into(), 4)), None, Some(("en0".into(), 4))], "{seen:?}");
    }
}
