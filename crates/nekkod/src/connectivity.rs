//! Internet reachability on the execution machine, not the paired browser.
//! Probes run only for public-model turns (or their restoration observers).
//! A provider's own failure never changes this state. Notices are metadata,
//! not model messages; recovery holds the same model call, never a new turn.

use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const LOST: &str = "Internet reachability lost. Saved progress is retained; select Continue after reconnecting.";
pub use nekko_loop::INTERNET_PAUSED as PAUSED;
const POLL: Duration = Duration::from_secs(5);
const MAX_WAIT: Duration = Duration::from_secs(30 * 60);
const ENDPOINTS: [&str; 2] = ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"];
type Work<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Probe = Arc<dyn Fn() -> Work<bool> + Send + Sync>;
pub type Sink = Arc<dyn Fn(Value) -> Work<()> + Send + Sync>;
pub type Allowed = Arc<dyn Fn() -> Work<bool> + Send + Sync>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Unknown,
    Online,
    Offline,
}

#[derive(Default)]
struct Debounce {
    state: State,
    good: u8,
    bad: u8,
}

impl Debounce {
    fn sample(&mut self, reachable: bool) -> State {
        if reachable {
            self.good = self.good.saturating_add(1);
            self.bad = 0;
            if self.good >= 2 {
                self.state = State::Online;
            }
        } else {
            self.bad = self.bad.saturating_add(1);
            self.good = 0;
            if self.bad >= 3 {
                self.state = State::Offline;
            }
        }
        self.state
    }
}

struct Observer {
    session: String,
    cancel: Cancel,
    sink: Sink,
    active: bool,
    lost: bool,
    expires: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    observations: HashMap<u64, Observer>,
    running: bool,
    debounce: Debounce,
}

pub struct Connectivity {
    inner: Mutex<Inner>,
    next: AtomicU64,
    state: watch::Sender<State>,
    probe: Probe,
}

impl Connectivity {
    pub fn new() -> Arc<Self> {
        // No redirects, cookies, auth, prompts or session identifiers. Only a
        // 204 counts: a captive portal must not look like a restored connection.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(4))
            .build();
        Self::with_probe(Arc::new(move || {
            let client = client.as_ref().ok().cloned();
            Box::pin(async move {
                let Some(client) = client else { return true }; // Never pause work because monitor setup failed.
                let check = |url| {
                    let client = client.clone();
                    async move { nekko_net::send("model-providers", client.get(url)).await.is_ok_and(|r| r.status() == 204) }
                };
                let (a, b) = tokio::join!(check(ENDPOINTS[0]), check(ENDPOINTS[1]));
                a || b
            })
        }))
    }

    fn with_probe(probe: Probe) -> Arc<Self> {
        let (state, _) = watch::channel(State::Unknown);
        Arc::new(Self { inner: Mutex::default(), next: AtomicU64::new(1), state, probe })
    }

    pub fn observe(self: &Arc<Self>, session: &str, cancel: Cancel, sink: Sink) -> Observation {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let start = {
            let mut inner = lock(&self.inner);
            // A manual Continue/new turn supersedes any old restoration observer.
            inner.observations.retain(|_, o| o.session != session);
            inner.observations.insert(
                id,
                Observer { session: session.into(), cancel, sink, active: true, lost: false, expires: None },
            );
            let start = !inner.running;
            inner.running = true;
            start
        };
        if start {
            let me = self.clone();
            tokio::spawn(async move {
                loop {
                    {
                        let mut inner = lock(&me.inner);
                        inner
                            .observations
                            .retain(|_, o| !o.cancel.is_cancelled() && o.expires.is_none_or(|t| t > Instant::now()));
                        if inner.observations.is_empty() {
                            inner.running = false;
                            inner.debounce = Debounce::default();
                            me.state.send_replace(State::Unknown);
                            break;
                        }
                    }
                    if !nekko_net::allowed("model-providers") {
                        tokio::time::sleep(POLL).await;
                        continue;
                    }
                    let reachable = (me.probe)().await;
                    me.sample(reachable).await;
                    tokio::time::sleep(POLL).await;
                }
            });
        }
        Observation { monitor: self.clone(), id }
    }

    pub fn forget(&self, session: &str) {
        lock(&self.inner).observations.retain(|_, o| o.session != session);
    }

    async fn sample(&self, reachable: bool) {
        let (state, notices) = {
            let mut inner = lock(&self.inner);
            let state = inner.debounce.sample(reachable);
            let mut notices = Vec::new();
            inner.observations.retain(|_, o| {
                if o.cancel.is_cancelled() { return false; }
                if state == State::Offline && !o.lost {
                    o.lost = true;
                    notices.push((o.sink.clone(), "lost", "Internet reachability lost on this computer. Saved work is retained. Automatic restoration recovery is off unless enabled in Settings."));
                } else if state == State::Online && o.lost {
                    o.lost = false;
                    notices.push((o.sink.clone(), "restored", if o.active {
                        "Internet reachability restored on this computer. Only eligible requests with automatic recovery enabled may continue."
                    } else {
                        "Internet reachability restored on this computer. This reply remains interrupted; select Continue to resume."
                    }));
                    return o.active;
                }
                true
            });
            (state, notices)
        };
        for (sink, kind, content) in notices {
            sink(notice(kind, content)).await;
        }
        self.state.send_if_modified(|s| {
            if *s == state {
                false
            } else {
                *s = state;
                true
            }
        });
    }
}

pub fn notice(kind: &str, content: &str) -> Value {
    let at = chrono::Utc::now().timestamp_millis();
    static SEQ: AtomicU64 = AtomicU64::new(0);
    json!({ "id": format!("connectivity_{at}_{}", SEQ.fetch_add(1, Ordering::Relaxed)), "kind": kind, "createdAt": at, "content": content })
}

pub struct Observation {
    monitor: Arc<Connectivity>,
    id: u64,
}

impl Drop for Observation {
    fn drop(&mut self) {
        let mut inner = lock(&self.monitor.inner);
        if let Some(o) = inner.observations.get_mut(&self.id) {
            if o.lost && !o.cancel.is_cancelled() {
                o.active = false;
                o.expires = Some(Instant::now() + MAX_WAIT);
            } else {
                inner.observations.remove(&self.id);
            }
        }
    }
}

/// Only public endpoints depend on public internet. Local/LAN inference is
/// usable without it, even when its provider kind normally means cloud.
pub fn needs_internet(provider: &Value) -> bool {
    if provider.get("kind").and_then(Value::as_str).is_some_and(nekko_turn::providers::is_local_kind) {
        return false;
    }
    let Some(url) = nekko_turn::providers::provider_endpoint(provider) else { return false };
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified())
        }
        Some(url::Host::Ipv6(ip)) => {
            !(ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local() || ip.is_unspecified())
        }
        Some(url::Host::Domain(host)) => {
            !(host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host.ends_with(".lan")
                || host.ends_with(".internal")
                || host.ends_with(".home.arpa")
                || !host.contains('.'))
        }
        None => false,
    }
}

/// Wrap only the provider call. Internet loss never cancels a tool or kills a
/// background process, nor starts a second turn/changes the admitted route.
pub struct ConnectedClient<C> {
    inner: C,
    monitor: Option<Arc<Connectivity>>,
    allowed: Allowed,
    sink: Sink,
    paused: Arc<AtomicBool>,
}

impl<C> ConnectedClient<C> {
    pub fn new(inner: C, monitor: Option<Arc<Connectivity>>, allowed: Allowed, sink: Sink) -> Self {
        Self { inner, monitor, allowed, sink, paused: Arc::new(AtomicBool::new(false)) }
    }

    async fn ready(&self, cancel: &Cancel) -> Result<(), String> {
        let Some(monitor) = &self.monitor else { return Ok(()) };
        let mut state = monitor.state.subscribe();
        let started = Instant::now();
        while *state.borrow_and_update() == State::Offline {
            if !(self.allowed)().await || started.elapsed() >= MAX_WAIT {
                return Err(LOST.into());
            }
            self.paused.store(true, Ordering::SeqCst);
            tokio::select! {
                _ = cancel.cancelled() => return Err("Stopped".into()),
                _ = state.changed() => {},
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        }
        if self.paused.swap(false, Ordering::SeqCst) {
            if cancel.is_cancelled() || !(self.allowed)().await {
                return Err(LOST.into());
            }
            (self.sink)(notice("resuming", "Automatically continuing the interrupted model request after restoration. Additional provider usage may incur charges.")).await;
        }
        Ok(())
    }
}

async fn offline(monitor: Option<Arc<Connectivity>>) {
    let Some(monitor) = monitor else { return std::future::pending().await };
    let mut state = monitor.state.subscribe();
    loop {
        if *state.borrow_and_update() == State::Offline {
            return;
        }
        if state.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

impl<C: ModelClient> ModelClient for ConnectedClient<C> {
    type Stream = ConnectedStream<C::Stream>;

    async fn chat(&self, req: ChatRequest, cancel: Cancel) -> Result<Self::Stream, String> {
        self.ready(&cancel).await?;
        let call = Cancel::default();
        let c = call.clone();
        cancel.on_cancel(move || c.cancel());
        let result = tokio::select! {
            result = self.inner.chat(req, call.clone()) => result,
            _ = offline(self.monitor.clone()) => {
                call.cancel();
                self.paused.store(true, Ordering::SeqCst);
                return Err(if (self.allowed)().await { PAUSED } else { LOST }.into());
            }
            _ = cancel.cancelled() => return Err("Stopped".into()),
        }?;
        Ok(ConnectedStream {
            inner: result,
            monitor: self.monitor.clone(),
            allowed: self.allowed.clone(),
            paused: self.paused.clone(),
            call,
            cancel,
            done: false,
        })
    }
}

pub struct ConnectedStream<S> {
    inner: S,
    monitor: Option<Arc<Connectivity>>,
    allowed: Allowed,
    paused: Arc<AtomicBool>,
    call: Cancel,
    cancel: Cancel,
    done: bool,
}

impl<S: ChunkStream> ChunkStream for ConnectedStream<S> {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        if self.done {
            return None;
        }
        tokio::select! {
            item = self.inner.next() => { if item.is_none() { self.done = true; } item },
            _ = offline(self.monitor.clone()) => {
                self.done = true;
                self.call.cancel();
                self.paused.store(true, Ordering::SeqCst);
                Some(Err(if (self.allowed)().await { PAUSED } else { LOST }.into()))
            }
            _ = self.cancel.cancelled() => { self.done = true; Some(Err("Stopped".into())) },
        }
    }
}

#[cfg(test)]
#[path = "connectivity_tests.rs"]
mod tests;
