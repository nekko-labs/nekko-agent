//! "Relay on this computer" (TASKS.md PH4): the desktop runs
//! `apps/relay-server` itself, bound to this computer's Tailscale address, so
//! a phone on the same tailnet reaches it over WireGuard with no hosted relay
//! in between.
//!
//! A port of `apps/desktop/src/backend/local-relay.ts`, the supervisor. The
//! relay itself stays the TS server, bundled as `out/main/relay.js` and run
//! by the app's Electron binary under `ELECTRON_RUN_AS_NODE=1`; it prints
//! `NEKKO_RELAY_READY` once listening and exits when its stdin closes.
//!
//! Tailscale first, and only Tailscale: binding to the tailnet address keeps
//! the relay off the LAN and the internet. When Tailscale isn't up the card
//! says so; a switched-on relay keeps checking and starts when Tailscale
//! comes back, and moves when the tailnet address changes.

use crate::mdns::{Nic, interfaces};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Notify, oneshot};

/// `LOCAL_RELAY_PORT` (packages/shared/src/relay-route.ts).
pub const LOCAL_RELAY_PORT: u16 = 4400;
const WATCH: Duration = Duration::from_secs(30);
const START_TIMEOUT: Duration = Duration::from_secs(10);
/// Time the relay gets after its stdin closes before it is killed.
const GRACE: Duration = Duration::from_secs(2);
const NO_TAILSCALE: &str =
    "Tailscale isn't connected on this computer. Install Tailscale and sign in, and the relay starts.";
const TAILSCALE_CLIS: [&str; 3] = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `isTailscaleIPv4`: 100.64.0.0/10, written as a JavaScript client reads it.
pub fn is_tailscale_ipv4(h: &str) -> bool {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 || !parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let n: Vec<u32> = parts.iter().map(|p| p.parse().unwrap_or(0)).collect();
    n.iter().all(|x| *x <= 255) && n[0] == 100 && (64..=127).contains(&n[1])
}

/// The first address in Tailscale's 100.64.0.0/10 range on any interface.
pub fn tailnet_address(nics: &[Nic]) -> Option<String> {
    nics.iter().find(|n| n.ipv4 && !n.internal && is_tailscale_ipv4(&n.address)).map(|n| n.address.clone())
}

/// The address phones dial: the MagicDNS name when known (Android needs one), else the tailnet IP.
pub fn local_relay_url(name: Option<&str>, ip: &str, port: u16) -> String {
    format!("ws://{}:{port}", name.unwrap_or(ip))
}

/// What the relay's stderr says went wrong, as the card shows it.
pub fn relay_failure(stderr: &str, port: u16) -> String {
    // `/NEKKO_RELAY_ERROR (\{.*\})/`: greedy to the last brace on that line.
    let re = regress::Regex::new(r"NEKKO_RELAY_ERROR (\{.*\})").expect("valid pattern");
    let code = re
        .find(stderr)
        .and_then(|m| m.group(1))
        .and_then(|g| serde_json::from_str::<Value>(&stderr[g]).ok())
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string));
    match code.as_deref() {
        Some("EADDRINUSE") => {
            format!(
                "Port {port} is already in use on this computer. Close whatever is using it (another relay?) and try again."
            )
        }
        Some("EADDRNOTAVAIL") => {
            "The Tailscale address went away while the relay was starting. It retries on its own.".into()
        }
        _ => "The relay could not start.".into(),
    }
}

/// `tailscale status --json` → `Self.DNSName`, without the trailing dot.
async fn magic_dns_name() -> Option<String> {
    for cli in TAILSCALE_CLIS {
        let mut cmd = Command::new(cli);
        cmd.args(["status", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let out = match tokio::time::timeout(Duration::from_secs(3), cmd.output()).await {
            Ok(Ok(out)) if out.status.success() => out,
            _ => continue,
        };
        // An unreadable answer ends the search, as execFile's callback did.
        let v: Value = serde_json::from_slice(&out.stdout).ok()?;
        // `String(Self?.DNSName ?? '')`.
        let raw = v.pointer("/Self/DNSName").filter(|n| !n.is_null()).map(nekko_js::display).unwrap_or_default();
        let name = raw.strip_suffix('.').unwrap_or(&raw).to_string();
        return name.ends_with(".ts.net").then_some(name);
    }
    None
}

#[derive(Default)]
struct State {
    enabled: bool,
    port: u16,
    /// The running relay: the address it bound and the signal that stops it.
    running: Option<Running>,
    name: Option<String>,
    error: Option<String>,
    watching: bool,
}

struct Running {
    ip: String,
    id: u64,
    stop: Arc<Notify>,
    /// Resolves once the process has exited.
    exited: Arc<Notify>,
}

pub struct LocalRelay {
    state_file: PathBuf,
    /// `(exe, entry)`: the Electron binary and `relay.js`; none in a build without them.
    command: Option<(String, String)>,
    state: Mutex<State>,
    /// One ensure at a time (the TS `starting` promise).
    ensuring: tokio::sync::Mutex<()>,
    ids: std::sync::atomic::AtomicU64,
}

impl LocalRelay {
    pub fn new(state_file: PathBuf, command: Option<(String, String)>) -> Arc<Self> {
        let saved = std::fs::read_to_string(&state_file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let (enabled, port) = match &saved {
            Some(s) => (
                s.get("enabled") == Some(&Value::Bool(true)),
                s.get("port")
                    .and_then(Value::as_u64)
                    .filter(|p| *p <= u16::MAX as u64)
                    .map_or(LOCAL_RELAY_PORT, |p| p as u16),
            ),
            None => (false, LOCAL_RELAY_PORT),
        };
        Arc::new(Self {
            state_file,
            command,
            state: Mutex::new(State { enabled, port, ..State::default() }),
            ensuring: tokio::sync::Mutex::new(()),
            ids: Default::default(),
        })
    }

    /// At app start: bring a switched-on relay back.
    pub fn resume(self: &Arc<Self>) {
        if lock(&self.state).enabled {
            let me = self.clone();
            tokio::spawn(async move { me.start().await });
        }
    }

    /// The relay phones would dial while it runs: `(url, port)`.
    pub fn running_at(&self) -> Option<(String, u16)> {
        let s = self.status();
        (s["running"] == true)
            .then(|| (s["url"].as_str().unwrap_or_default().to_string(), s["port"].as_u64().unwrap_or(0) as u16))
    }

    pub fn status(&self) -> Value {
        let ip = tailnet_address(&interfaces());
        let s = lock(&self.state);
        let running = s.running.as_ref().map(|r| r.ip.clone());
        let at = running.clone().or(ip.clone());
        let mut out = serde_json::Map::new();
        out.insert("available".into(), json!(true));
        out.insert("running".into(), json!(running.is_some()));
        out.insert("enabled".into(), json!(s.enabled));
        out.insert("port".into(), json!(s.port));
        if let Some(ip) = &ip {
            out.insert("tailnetIp".into(), json!(ip));
        }
        if let Some(n) = &s.name {
            out.insert("tailnetName".into(), json!(n));
        }
        if let Some(at) = at {
            out.insert("url".into(), json!(local_relay_url(s.name.as_deref(), &at, s.port)));
        }
        if running.is_none() {
            let error = s.error.clone().or_else(|| ip.is_none().then(|| NO_TAILSCALE.to_string()));
            if let Some(e) = error {
                out.insert("error".into(), json!(e));
            }
        }
        Value::Object(out)
    }

    pub async fn start(self: &Arc<Self>) -> Value {
        let watch = {
            let mut s = lock(&self.state);
            if !s.enabled {
                s.enabled = true;
                self.save(true, s.port);
            }
            !std::mem::replace(&mut s.watching, true)
        };
        if watch {
            let me = Arc::downgrade(self);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(WATCH);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let Some(me) = me.upgrade() else { return };
                    if !lock(&me.state).watching {
                        return;
                    }
                    me.ensure().await;
                }
            });
        }
        self.ensure().await;
        self.status()
    }

    pub async fn stop(self: &Arc<Self>) -> Value {
        {
            let mut s = lock(&self.state);
            s.enabled = false;
            s.watching = false;
            s.error = None;
            self.save(false, s.port);
        }
        self.kill().await;
        self.status()
    }

    /// App shutdown: stop the process, keep the switch as it is.
    pub async fn close(&self) {
        lock(&self.state).watching = false;
        self.kill().await;
    }

    /// Running on the current tailnet address, or a reason why not.
    async fn ensure(self: &Arc<Self>) {
        let _one = self.ensuring.lock().await;
        let ip = tailnet_address(&interfaces());
        if let (Some(r), Some(ip)) = (&lock(&self.state).running, &ip)
            && &r.ip == ip
        {
            return;
        }
        self.kill().await;
        let Some(ip) = ip else {
            lock(&self.state).error = Some(NO_TAILSCALE.into());
            return;
        };
        let name = magic_dns_name().await;
        lock(&self.state).name = name;
        let error = self.launch(&ip).await;
        lock(&self.state).error = error;
    }

    async fn launch(self: &Arc<Self>, ip: &str) -> Option<String> {
        let port = lock(&self.state).port;
        let Some((exe, entry)) = self.command.clone() else {
            return Some("The relay could not start: this build does not include it.".into());
        };
        let mut cmd = Command::new(&exe);
        cmd.arg(&entry)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("NEKKO_RELAY_HOST", ip)
            .env("NEKKO_RELAY_PORT", port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Some(format!("The relay could not start: {e}")),
        };
        let stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        if let Some(stdout) = stdout {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                let mut ready = Some(ready_tx);
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.contains("NEKKO_RELAY_READY")
                        && let Some(tx) = ready.take()
                    {
                        let _ = tx.send(());
                    }
                }
            });
        }
        let err_buf = Arc::new(Mutex::new(String::new()));
        if let Some(mut stderr) = stderr.take() {
            let buf = err_buf.clone();
            tokio::spawn(async move {
                let mut chunk = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    lock(&buf).push_str(&String::from_utf8_lossy(&chunk[..n]));
                }
            });
        }
        let exited = Arc::new(Notify::new());
        let (exit_tx, exit_rx) = oneshot::channel::<()>();
        let stop = Arc::new(Notify::new());
        let id = self.ids.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        {
            let (stop, exited, me) = (stop.clone(), exited.clone(), Arc::downgrade(self));
            tokio::spawn(async move {
                supervise(child, stop, exit_tx).await;
                exited.notify_waiters();
                exited.notify_one();
                // An exit nobody asked for, after it was up.
                if let Some(me) = me.upgrade() {
                    let mut s = lock(&me.state);
                    if s.running.as_ref().is_some_and(|r| r.id == id) {
                        s.running = None;
                        s.error = Some(
                            "The relay stopped unexpectedly. It restarts on its own while this is switched on.".into(),
                        );
                    }
                }
            });
        }
        tokio::select! {
            r = ready_rx => if r.is_ok() {
                lock(&self.state).running = Some(Running { ip: ip.to_string(), id, stop, exited });
                None
            } else {
                // stdout closed without the line: wait for the exit to read why.
                let _ = tokio::time::timeout(Duration::from_secs(1), exit_rx).await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                stop.notify_one();
                Some(relay_failure(&lock(&err_buf), port))
            },
            _ = tokio::time::sleep(START_TIMEOUT) => {
                stop.notify_one();
                Some("The relay did not start in time.".into())
            }
        }
    }

    async fn kill(&self) {
        let running = lock(&self.state).running.take();
        if let Some(r) = running {
            let gone = r.exited.notified();
            r.stop.notify_one();
            let _ = tokio::time::timeout(GRACE + Duration::from_secs(1), gone).await;
        }
    }

    fn save(&self, enabled: bool, port: u16) {
        // The relay still works this session; it just won't come back by itself.
        if let Some(dir) = self.state_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.state_file, json!({ "enabled": enabled, "port": port }).to_string());
    }
}

/// Own the relay process until it exits or is told to stop: close its stdin
/// (its shutdown signal), then kill it if it lingers.
async fn supervise(mut child: Child, stop: Arc<Notify>, exited: oneshot::Sender<()>) {
    tokio::select! {
        _ = child.wait() => {}
        _ = stop.notified() => {
            drop(child.stdin.take());
            if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
    }
    let _ = exited.send(());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/desktop-features.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn addresses_urls_and_failures_match_the_ts() {
        let g = golden();
        for case in g["relay"]["tailnet"].as_array().unwrap() {
            let nics = crate::mdns::tests::nics_of(&g["ifaces"][case["ifaces"].as_str().unwrap()]);
            assert_eq!(json!(tailnet_address(&nics)), case["address"], "{}", case["ifaces"]);
        }
        for case in g["relay"]["urls"].as_array().unwrap() {
            let url = local_relay_url(
                case["name"].as_str(),
                case["ip"].as_str().unwrap(),
                case["port"].as_u64().unwrap() as u16,
            );
            assert_eq!(url, case["url"].as_str().unwrap());
        }
        for case in g["relay"]["failures"].as_array().unwrap() {
            let msg = relay_failure(case["stderr"].as_str().unwrap(), case["port"].as_u64().unwrap() as u16);
            assert_eq!(msg, case["message"].as_str().unwrap(), "{}", case["stderr"]);
        }
    }

    #[test]
    fn a_saved_switch_and_port_come_back() {
        let dir = std::env::temp_dir().join(format!("nekkod-local-relay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("local-relay.json");
        let relay = LocalRelay::new(file.clone(), None);
        assert_eq!(relay.status()["enabled"], false);
        assert_eq!(relay.status()["port"], LOCAL_RELAY_PORT);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, r#"{"enabled":true,"port":4555}"#).unwrap();
        let relay = LocalRelay::new(file.clone(), None);
        assert_eq!(relay.status()["enabled"], true);
        assert_eq!(relay.status()["port"], 4555);
        assert_eq!(relay.status()["running"], false);
        std::fs::write(&file, r#"{"enabled":"yes","port":4400.5}"#).unwrap();
        let relay = LocalRelay::new(file, None);
        assert_eq!(relay.status()["enabled"], false);
        assert_eq!(relay.status()["port"], LOCAL_RELAY_PORT);
        let _ = std::fs::remove_dir_all(dir);
    }
}
