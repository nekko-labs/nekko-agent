//! Model-server processes: start one, wait until it answers, keep its log,
//! stop it. One per loaded model.
//!
//! What to start (binary, arguments, which health route means ready) is the
//! caller's decision (the daemon's model server policy). This module owns the
//! processes themselves and stops them all on shutdown, so none is left
//! holding VRAM.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Lines of each model server's output kept for load-failure reports.
const LOG_LINES: usize = 200;
const HEALTH_INTERVAL: Duration = Duration::from_millis(400);
const DEFAULT_BUDGET: Duration = Duration::from_secs(600);
/// Placeholder in `args` for the port chosen at spawn time.
pub const PORT_PLACEHOLDER: &str = "{port}";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Text inference (llama.cpp, MLX).
    Chat,
    /// Image generation (stable-diffusion.cpp).
    Image,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSpec {
    pub model_id: String,
    pub bin: String,
    /// Arguments, with `{port}` where the listening port goes.
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub kind: Kind,
    /// GET this path; a 200 means ready (llama.cpp: `/health`).
    pub health_path: String,
    /// When set, the health body must also contain this (llama.cpp answers
    /// 503 or `loading model` until it is ready, and `"ok"` once it is).
    #[serde(default)]
    pub health_expect: Option<String>,
    #[serde(default)]
    pub budget_secs: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SpawnOutcome {
    Ready { port: u16, pid: u32 },
    Failed { message: String, log: Vec<String> },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildInfo {
    pub model_id: String,
    pub kind: Kind,
    pub port: u16,
    pub pid: u32,
    pub started_at: u64,
    pub last_used_at: u64,
    pub active_requests: usize,
}

pub struct Child {
    pub model_id: String,
    pub kind: Kind,
    pub port: u16,
    pub pid: u32,
    pub started_at: u64,
    last_used: AtomicU64,
    active: AtomicUsize,
    /// Dropping the handle kills the process (`kill_on_drop`).
    proc: Mutex<Option<tokio::process::Child>>,
    log: Arc<Mutex<VecDeque<String>>>,
    /// Distinguishes this process from a later one for the same model.
    generation: u64,
}

impl Child {
    pub fn touch(&self) {
        self.last_used.store(nekko_js::now_ms(), Ordering::Relaxed);
    }

    /// Count a request in flight; the guard counts it out when dropped.
    pub fn begin(self: &Arc<Self>) -> ActiveGuard {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.touch();
        ActiveGuard(self.clone())
    }

    fn info(&self) -> ChildInfo {
        ChildInfo {
            model_id: self.model_id.clone(),
            kind: self.kind,
            port: self.port,
            pid: self.pid,
            started_at: self.started_at,
            last_used_at: self.last_used.load(Ordering::Relaxed),
            active_requests: self.active.load(Ordering::Relaxed),
        }
    }

    fn kill(&self) {
        if let Some(mut p) = self.proc.lock().unwrap().take() {
            let _ = p.start_kill();
        }
    }
}

pub struct ActiveGuard(Arc<Child>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
        self.0.touch();
    }
}

#[derive(Default)]
pub struct Supervisor {
    children: Mutex<HashMap<String, Arc<Child>>>,
    /// Loads run one at a time: two at once race each other into VRAM.
    load_lock: tokio::sync::Mutex<()>,
    next_generation: AtomicU64,
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, model_id: &str) -> Option<Arc<Child>> {
        self.children.lock().unwrap().get(model_id).cloned()
    }

    pub fn list(&self) -> Vec<ChildInfo> {
        let mut all: Vec<ChildInfo> = self.children.lock().unwrap().values().map(|c| c.info()).collect();
        all.sort_by_key(|c| c.started_at);
        all
    }

    /// The most recently used model of this kind (a request that names none).
    pub fn most_recent(&self, kind: Kind) -> Option<Arc<Child>> {
        self.children
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.kind == kind)
            .max_by_key(|c| c.last_used.load(Ordering::Relaxed))
            .cloned()
    }

    /// The last lines a running model server printed.
    pub fn log(&self, model_id: &str) -> Vec<String> {
        self.get(model_id).map(|c| c.log.lock().unwrap().iter().cloned().collect()).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.children.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn kill(&self, model_id: &str) -> bool {
        let child = self.children.lock().unwrap().remove(model_id);
        match child {
            Some(c) => {
                c.kill();
                true
            }
            None => false,
        }
    }

    pub fn kill_all(&self) {
        let all: Vec<Arc<Child>> = self.children.lock().unwrap().drain().map(|(_, c)| c).collect();
        for c in all {
            c.kill();
        }
    }

    /// Start a model server and wait until it is ready. A model already
    /// running is replaced (a load with new settings is a reload).
    pub async fn spawn(self: &Arc<Self>, spec: SpawnSpec) -> SpawnOutcome {
        let _one_at_a_time = self.load_lock.lock().await;
        self.kill(&spec.model_id);

        let port = match free_port() {
            Ok(p) => p,
            Err(e) => return SpawnOutcome::Failed { message: format!("no free port: {e}"), log: vec![] },
        };
        let args: Vec<String> = spec.args.iter().map(|a| a.replace(PORT_PLACEHOLDER, &port.to_string())).collect();
        let mut cmd = Command::new(&spec.bin);
        cmd.args(&args)
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // No console window flashing up per model.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut proc = match cmd.spawn() {
            Ok(p) => p,
            Err(e) => {
                return SpawnOutcome::Failed { message: format!("could not start {}: {e}", spec.bin), log: vec![] };
            }
        };
        let pid = proc.id().unwrap_or(0);
        let log = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_LINES)));
        if let Some(out) = proc.stdout.take() {
            tokio::spawn(pump_lines(out, log.clone()));
        }
        if let Some(err) = proc.stderr.take() {
            tokio::spawn(pump_lines(err, log.clone()));
        }

        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let child = Arc::new(Child {
            model_id: spec.model_id.clone(),
            kind: spec.kind,
            port,
            pid,
            started_at: nekko_js::now_ms(),
            last_used: AtomicU64::new(nekko_js::now_ms()),
            active: AtomicUsize::new(0),
            proc: Mutex::new(Some(proc)),
            log: log.clone(),
            generation,
        });

        let budget = spec.budget_secs.map(Duration::from_secs).unwrap_or(DEFAULT_BUDGET);
        let deadline = Instant::now() + budget;
        let http = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).build_http();
        let url: hyper::Uri = match format!("http://127.0.0.1:{port}{}", spec.health_path).parse() {
            Ok(u) => u,
            Err(e) => {
                child.kill();
                return SpawnOutcome::Failed { message: format!("bad health path: {e}"), log: vec![] };
            }
        };
        loop {
            if let Some(status) = exited(&child) {
                return SpawnOutcome::Failed {
                    message: format!("The model server exited ({status})."),
                    log: log.lock().unwrap().iter().cloned().collect(),
                };
            }
            if healthy(&http, &url, spec.health_expect.as_deref()).await {
                break;
            }
            if Instant::now() >= deadline {
                child.kill();
                return SpawnOutcome::Failed {
                    message: "The model did not finish loading in time.".into(),
                    log: log.lock().unwrap().iter().cloned().collect(),
                };
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }

        self.children.lock().unwrap().insert(spec.model_id.clone(), child.clone());
        self.watch(child);
        SpawnOutcome::Ready { port, pid }
    }

    /// Forget a model server that dies on its own, so requests stop going to
    /// a dead port and the TS engine sees it gone.
    fn watch(self: &Arc<Self>, child: Arc<Child>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let Some(me) = me.upgrade() else { return };
                if exited(&child).is_some() {
                    let mut map = me.children.lock().unwrap();
                    if map.get(&child.model_id).is_some_and(|c| c.generation == child.generation) {
                        map.remove(&child.model_id);
                    }
                    return;
                }
                if child.proc.lock().unwrap().is_none() {
                    return; // killed on purpose
                }
            }
        });
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.kill_all();
    }
}

async fn pump_lines<R: tokio::io::AsyncRead + Unpin + Send + 'static>(reader: R, log: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim_end().to_string();
        if line.trim().is_empty() {
            continue;
        }
        let mut l = log.lock().unwrap();
        if l.len() >= LOG_LINES {
            l.pop_front();
        }
        l.push_back(line);
    }
}

fn exited(child: &Child) -> Option<String> {
    let mut guard = child.proc.lock().unwrap();
    let proc = guard.as_mut()?;
    match proc.try_wait() {
        Ok(Some(status)) => Some(status.to_string()),
        Ok(None) => None,
        Err(e) => Some(e.to_string()),
    }
}

async fn healthy(
    http: &hyper_util::client::legacy::Client<
        hyper_util::client::legacy::connect::HttpConnector,
        http_body_util::Empty<bytes::Bytes>,
    >,
    url: &hyper::Uri,
    expect: Option<&str>,
) -> bool {
    use http_body_util::BodyExt;
    let req = match hyper::Request::get(url.clone()).body(http_body_util::Empty::new()) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let Ok(Ok(res)) = tokio::time::timeout(Duration::from_secs(2), http.request(req)).await else { return false };
    if !res.status().is_success() {
        return false;
    }
    let Some(expect) = expect else { return true };
    match tokio::time::timeout(Duration::from_secs(2), res.into_body().collect()).await {
        Ok(Ok(body)) => String::from_utf8_lossy(&body.to_bytes()).contains(expect),
        _ => false,
    }
}

fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}
