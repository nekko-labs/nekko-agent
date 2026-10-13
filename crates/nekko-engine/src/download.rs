//! The download queue behind model acquisition: resumable (`<file>.part`
//! and a `Range` request), cancellable for real, renamed into place only
//! once complete and verified. A port of `packages/host/src/engine/download.ts`,
//! held to it by `tests/golden/downloads.json`.

use crate::{BoxFuture, num};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

/// How often progress is published; faster is just re-rendering.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);
/// Window for the rate estimate, in milliseconds.
const RATE_WINDOW_MS: f64 = 3000.0;

/// One file to fetch (`DownloadRequest`).
#[derive(Clone, Debug, Default)]
pub struct Request {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub target: String,
    pub url: String,
    /// Final path; the transfer writes `<dest>.part` until it succeeds.
    pub dest: String,
    pub group: Option<String>,
    pub group_label: Option<String>,
    pub file: Option<String>,
    pub role: Option<String>,
    pub headers: Vec<(String, String)>,
    /// Reject the bytes unless they read as a GGUF header.
    pub verify_gguf: bool,
}

impl Request {
    /// From a planned download (`PlannedDownload`, the TS shape).
    pub fn from_value(v: &Value) -> Request {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Request {
            id: s("id").unwrap_or_default(),
            kind: s("kind").unwrap_or_default(),
            label: s("label").unwrap_or_default(),
            target: s("target").unwrap_or_default(),
            url: s("url").unwrap_or_default(),
            dest: s("dest").unwrap_or_default(),
            group: s("group").filter(|g| !g.is_empty()),
            group_label: s("groupLabel"),
            file: s("file").filter(|f| !f.is_empty()),
            role: s("role").filter(|r| !r.is_empty()),
            headers: v
                .get("headers")
                .and_then(Value::as_object)
                .map(|h| h.iter().map(|(k, v)| (k.clone(), nekko_js::display(v))).collect())
                .unwrap_or_default(),
            verify_gguf: false,
        }
    }
}

/// A body, chunk by chunk.
pub type Body = BoxStream<'static, Result<Vec<u8>, String>>;

/// One HTTP answer to a download request.
pub struct Reply {
    pub status: u16,
    pub content_length: Option<String>,
    pub body: Option<Body>,
}

/// How downloads reach the network (scripted in tests). `Err` is a request
/// that threw (`fetch failed`).
pub trait Fetch: Send + Sync {
    fn get(&self, url: String, headers: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>>;
}

/// reqwest, following redirects as `fetch` does.
pub struct HttpFetch(pub reqwest::Client);

impl Fetch for HttpFetch {
    fn get(&self, url: String, headers: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>> {
        let client = self.0.clone();
        Box::pin(async move {
            let mut req = client.get(&url);
            for (k, v) in headers {
                req = req.header(k, v);
            }
            // Node's fetch says only this when the request itself fails.
            let res = req.send().await.map_err(|_| "fetch failed".to_string())?;
            let status = res.status().as_u16();
            let content_length = res.headers().get("content-length").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = futures_util::stream::unfold(Some(res), |res| async move {
                let mut res = res?;
                match res.chunk().await {
                    Ok(Some(b)) => Some((Ok(b.to_vec()), Some(res))),
                    Ok(None) => None,
                    Err(_) => Some((Err("terminated".to_string()), None)),
                }
            })
            .boxed();
            Ok(Reply { status, content_length, body: Some(body) })
        })
    }
}

/// A job's cancel switch: set once, heard by the transfer at its next chunk.
#[derive(Clone, Default)]
struct Cancel {
    set: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
}

impl Cancel {
    fn abort(&self) {
        self.set.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    fn aborted(&self) -> bool {
        self.set.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        loop {
            let woken = self.wake.notified();
            if self.aborted() {
                return;
            }
            woken.await;
        }
    }
}

struct Job {
    /// The `DownloadJob` the UI sees, in the TS key order.
    snap: Map<String, Value>,
    cancel: Cancel,
    rate_samples: Vec<(f64, f64)>,
}

type OnChange = Arc<dyn Fn(Vec<Value>) + Send + Sync>;

struct Inner {
    fetch: Arc<dyn Fetch>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    on_change: OnChange,
    /// Insertion order, as a JavaScript `Map` keeps it: a restarted id keeps its place.
    jobs: Mutex<Vec<(String, Job)>>,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The queue (`createDownloads`).
#[derive(Clone)]
pub struct Downloads(Arc<Inner>);

fn state_of(m: &Map<String, Value>) -> &str {
    m.get("state").and_then(Value::as_str).unwrap_or_default()
}

fn active(state: &str) -> bool {
    matches!(state, "downloading" | "queued" | "verifying")
}

impl Downloads {
    pub fn new(
        fetch: Arc<dyn Fetch>,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
        on_change: impl Fn(Vec<Value>) + Send + Sync + 'static,
    ) -> Downloads {
        Downloads(Arc::new(Inner {
            fetch,
            now,
            on_change: Arc::new(on_change),
            jobs: Mutex::new(Vec::new()),
            timer: Mutex::new(None),
        }))
    }

    /// Every job, newest first (`list`).
    pub fn list(&self) -> Vec<Value> {
        let jobs = self.0.jobs.lock().unwrap();
        let mut out: Vec<Map<String, Value>> = jobs.iter().map(|(_, j)| j.snap.clone()).collect();
        let started = |m: &Map<String, Value>| m.get("startedAt").and_then(Value::as_f64).unwrap_or(0.0);
        out.sort_by(|a, b| started(b).partial_cmp(&started(a)).unwrap_or(std::cmp::Ordering::Equal));
        out.into_iter().map(Value::Object).collect()
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.0.jobs.lock().unwrap().iter().any(|(k, j)| k == id && active(state_of(&j.snap)))
    }

    /// Coalesce notifications: a fast link would otherwise emit per chunk.
    fn notify(&self, immediate: bool) {
        let mut timer = self.0.timer.lock().unwrap();
        if immediate {
            if let Some(t) = timer.take() {
                t.abort();
            }
            drop(timer);
            (self.0.on_change)(self.list());
            return;
        }
        if timer.is_some() {
            return;
        }
        let me = self.clone();
        *timer = Some(tokio::spawn(async move {
            tokio::time::sleep(PROGRESS_INTERVAL).await;
            me.0.timer.lock().unwrap().take();
            (me.0.on_change)(me.list());
        }));
    }

    fn with_job<T>(&self, id: &str, f: impl FnOnce(&mut Job) -> T) -> Option<T> {
        let mut jobs = self.0.jobs.lock().unwrap();
        jobs.iter_mut().find(|(k, _)| k == id).map(|(_, j)| f(j))
    }

    /// Settle a job unless it was replaced or dismissed meanwhile.
    fn settle(&self, id: &str, cancel: &Cancel, state: &str, message: Option<&str>) {
        let now = (self.0.now)();
        self.with_job(id, |j| {
            if !Arc::ptr_eq(&j.cancel.set, &cancel.set) {
                return;
            }
            j.snap.insert("state".into(), json!(state));
            match message {
                Some(m) => {
                    j.snap.insert("message".into(), json!(m));
                }
                // `job.message = undefined`: the key exists, unprinted.
                None => {
                    j.snap.shift_remove("message");
                }
            }
            j.snap.insert("finishedAt".into(), num(now));
            j.snap.shift_remove("bytesPerSecond");
        });
        self.notify(true);
    }

    /// Start one download, or return the one already running under its id.
    pub fn start(&self, req: Request) -> Value {
        let cancel = Cancel::default();
        {
            let mut jobs = self.0.jobs.lock().unwrap();
            if let Some((_, existing)) = jobs.iter().find(|(k, _)| *k == req.id)
                && active(state_of(&existing.snap))
            {
                return Value::Object(existing.snap.clone());
            }
            let mut snap = Map::new();
            snap.insert("id".into(), json!(req.id));
            snap.insert("kind".into(), json!(req.kind));
            snap.insert("label".into(), json!(req.label));
            snap.insert("target".into(), json!(req.target));
            snap.insert("dest".into(), json!(req.dest));
            if let Some(g) = &req.group {
                snap.insert("group".into(), json!(g));
                if let Some(l) = &req.group_label {
                    snap.insert("groupLabel".into(), json!(l));
                }
            }
            if let Some(f) = &req.file {
                snap.insert("file".into(), json!(f));
            }
            if let Some(r) = &req.role {
                snap.insert("role".into(), json!(r));
            }
            snap.insert("state".into(), json!("queued"));
            snap.insert("receivedBytes".into(), json!(0));
            snap.insert("startedAt".into(), num((self.0.now)()));
            let job = Job { snap, cancel: cancel.clone(), rate_samples: Vec::new() };
            match jobs.iter_mut().find(|(k, _)| *k == req.id) {
                Some(slot) => slot.1 = job,
                None => jobs.push((req.id.clone(), job)),
            }
        }
        let snapshot = self.with_job(&req.id, |j| Value::Object(j.snap.clone())).unwrap_or(Value::Null);
        self.notify(true);
        let me = self.clone();
        tokio::spawn(async move {
            let id = req.id.clone();
            if let Err(e) = me.run(&req, &cancel).await {
                let aborted = cancel.aborted();
                me.settle(
                    &id,
                    &cancel,
                    if aborted { "cancelled" } else { "failed" },
                    Some(if aborted { "Cancelled." } else { &e }),
                );
            }
        });
        snapshot
    }

    fn set(&self, id: &str, cancel: &Cancel, f: impl FnOnce(&mut Job)) {
        self.with_job(id, |j| {
            if Arc::ptr_eq(&j.cancel.set, &cancel.set) {
                f(j)
            }
        });
    }

    async fn run(&self, req: &Request, cancel: &Cancel) -> Result<(), String> {
        let partial = format!("{}.part", req.dest);
        if let Some(dir) = std::path::Path::new(&req.dest).parent() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
        }
        // Resume from whatever a previous attempt managed to write.
        let already = tokio::fs::metadata(&partial).await.map_or(0, |m| m.len());
        let mut headers = req.headers.clone();
        if already > 0 {
            headers.push(("Range".into(), format!("bytes={already}-")));
        }
        self.set(&req.id, cancel, |j| {
            j.snap.insert("state".into(), json!("downloading"));
            j.snap.insert("receivedBytes".into(), json!(already));
        });
        self.notify(true);

        let fetch = self.0.fetch.get(req.url.clone(), headers);
        let res = tokio::select! {
            r = fetch => r?,
            _ = cancel.wait() => return Err("This operation was aborted".into()),
        };
        // 206 honours the range; 200 to a range means the bytes we have are worthless.
        let resuming = res.status == 206;
        if !(200..300).contains(&res.status) {
            return Err(if res.status == 401 || res.status == 403 {
                "This file needs credentials or accepted terms on its page before it can be downloaded.".into()
            } else {
                format!("The download failed (HTTP {}).", res.status)
            });
        }
        let mut received = if already > 0 && !resuming { 0.0 } else { already as f64 };
        let length = res.content_length.as_deref().map_or(f64::NAN, nekko_js::string_to_number);
        self.set(&req.id, cancel, |j| {
            j.snap.insert("receivedBytes".into(), num(received));
            if length.is_finite() && length > 0.0 {
                j.snap.insert("totalBytes".into(), num(received + length));
            }
        });
        let Some(mut body) = res.body else { return Err("The server sent no data.".into()) };

        let mut out = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resuming && already > 0)
            .truncate(!(resuming && already > 0))
            .open(&partial)
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let chunk = tokio::select! {
                c = body.next() => c,
                _ = cancel.wait() => {
                    drop(out);
                    self.settle(&req.id, cancel, "cancelled", Some("Cancelled."));
                    return Ok(());
                }
            };
            match chunk {
                None => break,
                Some(Err(e)) => {
                    if cancel.aborted() {
                        self.settle(&req.id, cancel, "cancelled", Some("Cancelled."));
                        return Ok(());
                    }
                    return Err(e);
                }
                Some(Ok(bytes)) => {
                    out.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    received += bytes.len() as f64;
                    let now = (self.0.now)();
                    self.set(&req.id, cancel, |j| {
                        j.snap.insert("receivedBytes".into(), num(received));
                        sample_rate(j, now, received);
                    });
                    self.notify(false);
                }
            }
        }
        out.flush().await.map_err(|e| e.to_string())?;
        drop(out);

        if req.verify_gguf {
            self.set(&req.id, cancel, |j| {
                j.snap.insert("state".into(), json!("verifying"));
            });
            self.notify(true);
            let p = partial.clone();
            let readable =
                tokio::task::spawn_blocking(move || crate::gguf::read_metadata(&p).is_some()).await.unwrap_or(false);
            if !readable {
                // A file that failed its check is worse than none: a retry
                // must not resume onto corrupt bytes.
                let _ = tokio::fs::remove_file(&partial).await;
                return Err("The downloaded file is not a readable GGUF.".into());
            }
        }

        if cancel.aborted() {
            self.settle(&req.id, cancel, "cancelled", Some("Cancelled."));
            return Ok(());
        }
        let _ = tokio::fs::remove_file(&req.dest).await;
        tokio::fs::rename(&partial, &req.dest).await.map_err(|e| e.to_string())?;
        self.settle(&req.id, cancel, "done", None);
        Ok(())
    }

    /// Stop a download for real (`cancel`).
    pub fn cancel(&self, id: &str) {
        let queued = self.with_job(id, |j| {
            j.cancel.abort();
            (state_of(&j.snap) == "queued").then(|| j.cancel.clone())
        });
        if let Some(Some(cancel)) = queued {
            self.settle(id, &cancel, "cancelled", Some("Cancelled."));
        }
    }

    /// Drop a job from the list; a running one is cancelled first (`dismiss`).
    pub fn dismiss(&self, id: &str) {
        let mut jobs = self.0.jobs.lock().unwrap();
        let Some(at) = jobs.iter().position(|(k, _)| k == id) else { return };
        let (_, job) = jobs.remove(at);
        if active(state_of(&job.snap)) {
            job.cancel.abort();
        }
        drop(jobs);
        self.notify(true);
    }
}

/// Bytes per second over the recent window, not the whole transfer.
fn sample_rate(job: &mut Job, now: f64, received: f64) {
    job.rate_samples.push((now, received));
    while job.rate_samples.len() > 1 && now - job.rate_samples[0].0 > RATE_WINDOW_MS {
        job.rate_samples.remove(0);
    }
    let (at, bytes) = job.rate_samples[0];
    let span = now - at;
    if span > 500.0 {
        job.snap.insert("bytesPerSecond".into(), num((received - bytes) * 1000.0 / span));
    }
}
