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

    /// No backend at all (`backend` absent from the config): nothing runs in
    /// a host, so there are no host turns, approvals or busy chats to ask about.
    pub fn is_none(&self) -> bool {
        matches!(*self.state.borrow(), State::Disabled)
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
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command
            .args(&cmd.args)
            .envs(&cmd.env)
            .env("NEKKO_BACKEND_TOKEN", token)
            .env("NEKKOD_URL", daemon_url)
            .env("NEKKOD_TOKEN", daemon_token)
            // Where nekkod's app-local Visual C++ runtime lives: the host copies it into
            // llama.cpp builds on a Windows without the redistributable.
            .envs(
                std::env::current_exe().ok().and_then(|p| p.parent().map(|d| ("NEKKOD_RUNTIME_DIR", d.to_path_buf()))),
            )
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

/// The backend's events the daemon relays to its clients. The backend sends
/// none of its copies of the daemon's own events (`?forDaemon=1`: no
/// `relayOnly` frame and no daemon terminal's output, see
/// apps/desktop/src/backend/wire.ts), so a frame is parsed only when it is an
/// agent event, to scope it to its chat (`Hub::publish_backend`).
///
/// An older backend ignores `forDaemon` and still sends both; its copies are
/// told apart by a substring check, never a parse of every frame:
/// `"relayOnly":true` is written last by the host (`{ ...event, relayOnly }`),
/// and a daemon terminal's id does not start with `agent_`.
fn is_daemon_copy(text: &str) -> bool {
    if text.ends_with(r#","relayOnly":true}}"#) {
        return true;
    }
    text.starts_with(r#"{"channel":"terminal:event""#) && !text.contains(r#""terminalId":"agent_"#)
}

async fn relay_events(port: u16, token: String, hub: Hub) {
    let url = format!("ws://127.0.0.1:{port}/api/events?forDaemon=1&token={token}");
    loop {
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((mut ws, _)) => {
                while let Some(msg) = ws.next().await {
                    match msg {
                        Ok(Message::Text(text)) => {
                            let text = text.as_str();
                            if !is_daemon_copy(text) {
                                hub.publish_backend(text);
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
    fn an_older_backends_copies_of_daemon_events_are_dropped_without_a_parse() {
        assert!(is_daemon_copy(
            r#"{"channel":"agent:event","payload":{"type":"text","sessionId":"s","delta":"x","relayOnly":true}}"#
        ));
        assert!(!is_daemon_copy(r#"{"channel":"agent:event","payload":{"type":"text","sessionId":"s","delta":"x"}}"#));
        // The host's echo of a limit change the daemon published itself.
        assert!(is_daemon_copy(
            r#"{"channel":"limits:updated","payload":{"tokenKey":"k","limits":{},"relayOnly":true}}"#
        ));
        // Only the payload's own flag counts, not text that mentions it.
        assert!(!is_daemon_copy(
            r#"{"channel":"agent:event","payload":{"type":"text","delta":"{\"relayOnly\":true}","inner":{"relayOnly":true}}}"#
        ));
        // Output of a terminal the daemon owns; the agent command logs are the backend's.
        assert!(is_daemon_copy(
            r#"{"channel":"terminal:event","payload":{"type":"data","terminalId":"term_1","data":"x"}}"#
        ));
        assert!(!is_daemon_copy(
            r#"{"channel":"terminal:event","payload":{"type":"data","terminalId":"agent_s1","data":"x"}}"#
        ));
    }
}
