//! The TS host backend: every channel the daemon has not taken over yet.
//!
//! The daemon starts it, reads its `NEKKO_BACKEND_READY {"port":N}` line,
//! forwards unported channels to its `POST /api/:channel`, and relays its
//! `/api/events` into the hub. If it dies it is restarted with backoff; calls
//! made meanwhile wait for it (up to [`READY_WAIT`]) rather than failing at once.
//!
//! The backend is also a *client* of the daemon: services already ported (the
//! terminals) are reached from TS through `NEKKOD_URL`, so the relay and the
//! CLI, which live in the backend, see the same terminals the UI does. The
//! backend re-emits those terminals' events on its own bus for its relay, so
//! the relay below drops them to avoid echoing them back to the UI.

use crate::config::BackendCommand;
use crate::hub::Hub;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, watch};
use tokio_tungstenite::tungstenite::Message;

/// How long a forwarded call waits for a (re)starting backend.
pub const READY_WAIT: Duration = Duration::from_secs(45);
const READY_LINE: &str = "NEKKO_BACKEND_READY ";
/// A backend that ran this long before dying resets the backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
/// Time the backend gets to shut down after its stdin closes.
const GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Disabled,
    Starting,
    Ready { base: String },
    Down { reason: String },
}

/// The running backend and the write end of its stdin (dropped to stop it).
type Running = Arc<Mutex<Option<(Child, Option<ChildStdin>)>>>;

pub struct Backend {
    state: watch::Receiver<State>,
    token: String,
    client: reqwest::Client,
    stopping: Arc<AtomicBool>,
    child: Running,
}

/// Idle lifetime of a pooled daemon-to-backend connection. Must stay below the
/// backend server's `keepAliveTimeout` (120 s in `apps/desktop/src/backend/wire.ts`).
const BACKEND_POOL_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

impl Backend {
    /// A backend that never exists (tests, or the daemon run on its own).
    pub fn disabled() -> Arc<Self> {
        let (_tx, rx) = watch::channel(State::Disabled);
        Arc::new(Self {
            state: rx,
            token: String::new(),
            client: reqwest::Client::new(),
            stopping: Arc::new(AtomicBool::new(true)),
            child: Arc::new(Mutex::new(None)),
        })
    }

    /// Start supervising the backend described by `cmd`.
    pub fn spawn(cmd: BackendCommand, daemon_url: String, daemon_token: String, hub: Hub) -> Arc<Self> {
        let token = crate::random_token();
        let (tx, rx) = watch::channel(State::Starting);
        let backend = Arc::new(Self {
            state: rx,
            token: token.clone(),
            // Drop pooled connections well before the backend's keep-alive
            // timeout (wire.ts), so a request never goes out on a socket the
            // backend is closing: that race failed a channel call mid-download.
            client: reqwest::Client::builder()
                .no_proxy()
                .pool_idle_timeout(BACKEND_POOL_IDLE)
                .build()
                .unwrap_or_default(),
            stopping: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        });
        let sup = backend.clone();
        tokio::spawn(async move { sup.supervise(cmd, token, daemon_url, daemon_token, hub, tx).await });
        backend
    }

    pub fn state(&self) -> State {
        self.state.borrow().clone()
    }

    async fn ready_base(&self) -> Result<String, String> {
        let mut rx = self.state.clone();
        let wait = async {
            loop {
                match rx.borrow_and_update().clone() {
                    State::Ready { base } => return Ok(base),
                    State::Disabled => return Err("no backend is configured".to_string()),
                    _ => {}
                }
                if rx.changed().await.is_err() {
                    return Err("backend supervisor stopped".to_string());
                }
            }
        };
        match tokio::time::timeout(READY_WAIT, wait).await {
            Ok(r) => r,
            Err(_) => Err(match self.state() {
                State::Down { reason } => format!("the engine backend is down: {reason}"),
                _ => "the engine backend is still starting".to_string(),
            }),
        }
    }

    /// Forward one channel call.
    pub async fn call(&self, channel: &str, args: Value) -> Result<Value, String> {
        let base = self.ready_base().await?;
        let res = self
            .client
            .post(format!("{base}/api/{channel}"))
            .bearer_auth(&self.token)
            .json(&json!({ "args": args }))
            .send()
            .await
            .map_err(|e| format!("{channel}: {e}"))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| format!("{channel}: {e}"))?;
        let body: Value =
            if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
        if status.is_success() {
            Ok(body)
        } else {
            Err(body
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{channel}: HTTP {status}")))
        }
    }

    /// Close the backend's stdin (its signal to shut down), then kill it if it
    /// has not exited within the grace period.
    pub async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let taken = self.child.lock().await.take();
        if let Some((mut child, stdin)) = taken {
            drop(stdin);
            if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
                let _ = child.kill().await;
            }
        }
    }

    async fn supervise(
        self: Arc<Self>,
        cmd: BackendCommand,
        token: String,
        daemon_url: String,
        daemon_token: String,
        hub: Hub,
        tx: watch::Sender<State>,
    ) {
        let mut backoff = Duration::from_millis(500);
        while !self.stopping.load(Ordering::SeqCst) {
            let started = Instant::now();
            let _ = tx.send(State::Starting);
            let reason = match self.run_once(&cmd, &token, &daemon_url, &daemon_token, &hub, &tx).await {
                Ok(status) => format!("exited ({status})"),
                Err(e) => e,
            };
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            eprintln!("nekkod: backend {reason}; restarting in {}ms", backoff.as_millis());
            let _ = tx.send(State::Down { reason: reason.clone() });
            hub.publish("daemon:backend", json!({ "state": "restarting", "reason": reason }), false);
            if started.elapsed() > HEALTHY_RUN {
                backoff = Duration::from_millis(500);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    async fn run_once(
        &self,
        cmd: &BackendCommand,
        token: &str,
        daemon_url: &str,
        daemon_token: &str,
        hub: &Hub,
        tx: &watch::Sender<State>,
    ) -> Result<String, String> {
        let mut command = Command::new(&cmd.exe);
        command
            .args(&cmd.args)
            .envs(&cmd.env)
            .env("NEKKO_BACKEND_TOKEN", token)
            .env("NEKKOD_URL", daemon_url)
            .env("NEKKOD_TOKEN", daemon_token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(dir) = &cmd.cwd {
            command.current_dir(dir);
        }
        crate::procgroup::on_child_spawn(&mut command);
        let mut child = command.spawn().map_err(|e| format!("failed to start {}: {e}", cmd.exe))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("backend has no stdout")?;
        *self.child.lock().await = Some((child, stdin));

        // Wait for the ready line; everything else it prints is log output.
        let mut lines = BufReader::new(stdout).lines();
        let port = loop {
            let line = tokio::time::timeout(Duration::from_secs(90), lines.next_line())
                .await
                .map_err(|_| "backend did not report ready within 90s".to_string())?
                .map_err(|e| e.to_string())?
                .ok_or("backend exited before it was ready")?;
            // Found anywhere in the line: a runtime may prefix its own output.
            if let Some(rest) = line.find(READY_LINE).map(|at| &line[at + READY_LINE.len()..]) {
                let v: Value = serde_json::from_str(rest).map_err(|e| format!("bad ready line: {e}"))?;
                break v.get("port").and_then(Value::as_u64).ok_or("ready line has no port")? as u16;
            }
            eprintln!("{line}");
        };
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{line}");
            }
        });

        let base = format!("http://127.0.0.1:{port}");
        let events = tokio::spawn(relay_events(port, token.to_string(), hub.clone()));
        let _ = tx.send(State::Ready { base });
        hub.publish("daemon:backend", json!({ "state": "ready" }), false);

        let status = loop {
            // Poll rather than hold the lock across the wait, so shutdown can
            // take the child.
            {
                let mut guard = self.child.lock().await;
                match guard.as_mut() {
                    Some((child, _)) => match child.try_wait() {
                        Ok(Some(status)) => {
                            guard.take();
                            break status.to_string();
                        }
                        Ok(None) => {}
                        Err(e) => break e.to_string(),
                    },
                    None => break "stopped".to_string(),
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        events.abort();
        Ok(status)
    }
}

/// True for backend events the daemon must not relay: output of terminals the
/// daemon owns, which the backend only re-emits for its own relay.
fn is_daemon_terminal_echo(text: &str) -> bool {
    if !text.contains("\"terminal:event\"") {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    if v.get("channel").and_then(Value::as_str) != Some("terminal:event") {
        return false;
    }
    let id = v.pointer("/payload/terminalId").and_then(Value::as_str).unwrap_or("");
    !id.starts_with("agent_")
}

/// True for a backend event the daemon already sent: a run the daemon drives
/// publishes its agent events itself, in order, and a limit change the daemon
/// made is published by it too. The backend re-emits its copies, marked
/// `relayOnly`, only for its own listeners (messaging).
fn is_relay_only(text: &str) -> bool {
    text.contains("\"relayOnly\":true")
        && serde_json::from_str::<Value>(text)
            .is_ok_and(|v| v.pointer("/payload/relayOnly") == Some(&Value::Bool(true)))
}

async fn relay_events(port: u16, token: String, hub: Hub) {
    let url = format!("ws://127.0.0.1:{port}/api/events?token={token}");
    loop {
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((mut ws, _)) => {
                while let Some(msg) = ws.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            let text = text.as_str();
                            if !is_daemon_terminal_echo(text) && !is_relay_only(text) {
                                hub.publish_raw(text, false);
                            }
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
            }
            Err(e) => eprintln!("nekkod: backend events: {e}"),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_agent_events_the_daemon_already_sent() {
        assert!(is_relay_only(
            r#"{"channel":"agent:event","payload":{"type":"text","sessionId":"s","delta":"x","relayOnly":true}}"#
        ));
        assert!(!is_relay_only(r#"{"channel":"agent:event","payload":{"type":"text","sessionId":"s","delta":"x"}}"#));
        // The host's echo of a limit change the daemon published itself.
        assert!(is_relay_only(
            r#"{"channel":"limits:updated","payload":{"tokenKey":"k","limits":{},"relayOnly":true}}"#
        ));
        // Only the payload's own flag counts, not text that mentions it.
        assert!(!is_relay_only(
            r#"{"channel":"agent:event","payload":{"type":"text","delta":"{\"relayOnly\":true}","inner":{"relayOnly":true}}}"#
        ));
    }

    #[test]
    fn drops_only_echoes_of_daemon_terminals() {
        assert!(is_daemon_terminal_echo(
            r#"{"channel":"terminal:event","payload":{"type":"data","terminalId":"term_1","data":"x"}}"#
        ));
        assert!(!is_daemon_terminal_echo(
            r#"{"channel":"terminal:event","payload":{"type":"data","terminalId":"agent_s1","data":"x"}}"#
        ));
        assert!(!is_daemon_terminal_echo(r#"{"channel":"agent:event","payload":{"type":"delta"}}"#));
    }
}
