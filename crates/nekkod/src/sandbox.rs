//! Sandbox chats' containers, owned here (PF14): the `sandbox:*` channels and
//! a sandbox chat's tool calls, ported from `packages/host/src/execution-router.ts`
//! over `nekko-sandbox`. The daemon is the only owner of the containers, their
//! manifests and their runtime state; the TS host's sandbox turn asks first
//! and sends the call here (`sandbox:tool`), and its Stop arrives as
//! `sandbox:abort`, which stops the container itself (a cancelled `docker
//! exec` alone leaves its shell running).

use crate::routes::Ctx;
use nekko_js as js;
use nekko_sandbox::{BoxFuture, Config, ContainerSandbox, Limits, ProcessRunner, RunResult, Runner};
use nekko_tools::Cancel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the backend is told the daemon owns (`NEKKOD_OWNS`).
pub const OWNS: &str = "sandbox";
/// The channels served here (the last two are the host's).
pub const CHANNELS: &[&str] = &[
    "sandbox:configure",
    "sandbox:cleanup",
    "sandbox:status",
    "sandbox:diff",
    "sandbox:applyDiff",
    "sandbox:tool",
    "sandbox:abort",
];

pub const SANDBOX_TOOLS: &[&str] = &["read_file", "write_file", "edit_file", "list_dir", "glob", "grep", "bash"];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// One sandbox chat's container and what has happened to it.
struct Runtime {
    sandbox: ContainerSandbox,
    identity: String,
    state: Arc<Mutex<RuntimeState>>,
}

#[derive(Default)]
struct RuntimeState {
    ready: bool,
    error: Option<String>,
    /// The running tool call's Stop.
    signal: Option<Cancel>,
    active: bool,
}

/// Runs Docker, but refuses to start once the call was stopped and, when a
/// stop lands during a `docker exec`, kills the container and records why.
struct CancellableRunner {
    inner: ProcessRunner,
    state: Arc<Mutex<RuntimeState>>,
}

fn container_arg(args: &[String]) -> Option<String> {
    if args.first().map(String::as_str) != Some("exec") {
        return None;
    }
    args.iter()
        .find(|a| {
            a.strip_prefix("nekko-").is_some_and(|t| {
                t.len() == 36 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            })
        })
        .cloned()
}

impl Runner for CancellableRunner {
    fn run<'a>(
        &'a self,
        exe: &'a str,
        args: &'a [String],
        timeout: Duration,
        max_buffer: u64,
    ) -> BoxFuture<'a, Result<RunResult, String>> {
        Box::pin(async move {
            let signal = lock(&self.state).signal.clone();
            if signal.as_ref().is_some_and(Cancel::is_cancelled) {
                return Err("Sandbox execution cancelled".into());
            }
            let container = container_arg(args);
            let kill = |state: &Arc<Mutex<RuntimeState>>| {
                lock(state).error =
                    Some("Sandbox stopped by cancellation. Create a new sandbox chat to resume.".into());
                if let Some(c) = &container {
                    let (exe, c) = (exe.to_string(), c.clone());
                    tokio::spawn(async move {
                        let args = vec!["kill".to_string(), c];
                        let _ = ProcessRunner.run(&exe, &args, Duration::from_secs(10), 65536).await;
                    });
                }
            };
            let work = self.inner.run(exe, args, timeout, max_buffer);
            let result = match &signal {
                Some(s) => tokio::select! {
                    r = work => r,
                    _ = s.cancelled() => {
                        kill(&self.state);
                        return Err("Sandbox execution cancelled".into());
                    }
                },
                None => work.await,
            };
            match result {
                Ok(r) if signal.as_ref().is_some_and(Cancel::is_cancelled) => {
                    let _ = r;
                    Err("Sandbox execution cancelled".into())
                }
                Ok(r) => Ok(r),
                Err(e) => {
                    if container.is_some() && signal.is_some() {
                        kill(&self.state);
                    }
                    Err(e)
                }
            }
        })
    }
}

#[derive(Default)]
pub struct Sandboxes {
    runtimes: Mutex<HashMap<String, Arc<Runtime>>>,
    data_dir: PathBuf,
}

fn session_workspace_ids(s: &Value) -> Vec<Value> {
    let mut ids: Vec<Value> = Vec::new();
    if let Some(w) = s.get("workspaceId").filter(|w| js::truthy(Some(w))) {
        ids.push(w.clone());
    }
    for w in s.get("supportingWorkspaceIds").and_then(Value::as_array).cloned().unwrap_or_default() {
        if js::truthy(Some(&w)) && !ids.contains(&w) {
            ids.push(w);
        }
    }
    ids
}

fn execution_mode(s: &Value) -> &str {
    match s.get("executionMode").and_then(Value::as_str) {
        Some(m) => m,
        None if s.get("gitIsolation") == Some(&Value::Bool(false)) => "unified",
        None => "worktree",
    }
}

impl Sandboxes {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self { runtimes: Mutex::default(), data_dir })
    }

    fn session(&self, ctx: &Ctx, id: &str) -> Result<Value, String> {
        ctx.sessions.as_ref().and_then(|s| s.get(id)).ok_or_else(|| "Session not found".into())
    }

    fn sandbox_session(&self, ctx: &Ctx, id: &str) -> Result<Value, String> {
        let s = ctx.sessions.as_ref().and_then(|s| s.get(id));
        match s {
            Some(s) if execution_mode(&s) == "sandbox" => Ok(s),
            _ => Err("Sandbox session required".into()),
        }
    }

    /// `runtime(s)`: the chat's container handle, made once per identity.
    async fn runtime(&self, ctx: &Ctx, s: &Value) -> Result<Arc<Runtime>, String> {
        let Some(sb) = s.get("sandbox").filter(|v| js::truthy(Some(v))) else {
            return Err("Configure a sandbox explicitly before sending. No host fallback is available.".into());
        };
        let id = s["id"].as_str().unwrap_or_default().to_string();
        let identity = sb["identity"].as_str().unwrap_or_default().to_string();
        if let Some(prior) = lock(&self.runtimes).get(&id).filter(|r| r.identity == identity) {
            return Ok(prior.clone());
        }
        if js::stringify(&json!(session_workspace_ids(s)))
            != js::stringify(sb.get("sourceWorkspaceIds").unwrap_or(&Value::Null))
        {
            return Err("Sandbox folder selection changed. Create a new sandbox chat.".into());
        }
        let settings = crate::settings::current(ctx).await;
        let workspaces = settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut folders = Vec::new();
        for wid in sb["sourceWorkspaceIds"].as_array().cloned().unwrap_or_default() {
            let Some(w) = workspaces.iter().find(|w| w.get("id") == Some(&wid)) else {
                return Err("Sandbox source folder unavailable".into());
            };
            folders.push(w["path"].as_str().unwrap_or_default().to_string());
        }
        let state = Arc::new(Mutex::new(RuntimeState::default()));
        let runner = Arc::new(CancellableRunner { inner: ProcessRunner, state: state.clone() });
        let config = Config {
            session_id: id.clone(),
            state_directory: self.data_dir.join("sandboxes").join(&identity),
            source_folders: folders,
            image: sb["image"].as_str().unwrap_or_default().to_string(),
            docker_path: None,
            limits: Limits::default(),
        };
        let rt = Arc::new(Runtime { sandbox: ContainerSandbox::new(config, runner)?, identity, state });
        lock(&self.runtimes).insert(id, rt.clone());
        Ok(rt)
    }

    async fn ready(&self, ctx: &Ctx, s: &Value) -> Result<Arc<Runtime>, String> {
        let r = self.runtime(ctx, s).await?;
        if let Some(e) = lock(&r.state).error.clone() {
            return Err(e);
        }
        if let Err(e) = r.sandbox.initialize().await {
            lock(&r.state).error = Some(e.clone());
            return Err(e);
        }
        lock(&r.state).ready = true;
        Ok(r)
    }

    /// `sandboxStatus(sessionId)`.
    fn status(&self, ctx: &Ctx, id: &str) -> Result<Value, String> {
        let s = self.session(ctx, id)?;
        let r = lock(&self.runtimes).get(id).cloned();
        let (ready, error) = r
            .as_ref()
            .map(|r| {
                let st = lock(&r.state);
                (st.ready, st.error.clone())
            })
            .unwrap_or((false, None));
        let phase = if error.is_some() {
            "error"
        } else if ready {
            "ready"
        } else if js::truthy(s.get("sandbox")) {
            "configured"
        } else {
            "unconfigured"
        };
        let mut out = serde_json::Map::new();
        out.insert("mode".into(), json!(execution_mode(&s)));
        out.insert("phase".into(), json!(phase));
        if let Some(v) = s.pointer("/sandbox/identity") {
            out.insert("identity".into(), v.clone());
        }
        if let Some(v) = s.pointer("/sandbox/image") {
            out.insert("image".into(), v.clone());
        }
        if let Some(e) = error {
            out.insert("error".into(), json!(e));
        }
        out.insert("applySupported".into(), json!(false));
        Ok(Value::Object(out))
    }

    async fn busy(ctx: &Ctx, id: &str) -> bool {
        if ctx.turns.running_sessions().iter().any(|s| s == id) {
            return true;
        }
        match tokio::time::timeout(crate::routes::AUX_WAIT, ctx.backend.call("chat:running", json!([]))).await {
            Ok(Ok(Value::Array(ids))) => ids.iter().any(|v| v.as_str() == Some(id)),
            _ => false,
        }
    }

    async fn diff(&self, ctx: &Ctx, id: &str) -> Result<Value, String> {
        let s = self.sandbox_session(ctx, id)?;
        let r = self.ready(ctx, &s).await?;
        let changes: Vec<Value> = r.sandbox.diff().await?.iter().map(|c| c.json()).collect();
        let changes = Value::Array(changes);
        let digest: String = Sha256::digest(format!("{}{}", r.identity, js::stringify(&changes)).as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok(json!({ "identity": r.identity, "diffId": digest, "changes": changes }))
    }

    /// `executeSandboxTool` after the host's approval.
    async fn tool(&self, ctx: &Ctx, id: &str, call: &Value) -> Value {
        let call_id = call.get("id").cloned().unwrap_or(json!(""));
        let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
        let failure = |output: String| json!({ "toolCallId": call_id, "output": output, "isError": true });
        if !SANDBOX_TOOLS.contains(&name) {
            return failure(format!(
                "Unsupported sandbox tool: {name}. Host controls, network, connectors, MCP and delegation are denied. No host fallback."
            ));
        }
        let run = async {
            let s = self.sandbox_session(ctx, id)?;
            let r = self.runtime(ctx, &s).await?;
            {
                let mut st = lock(&r.state);
                if st.active {
                    return Err("Sandbox operation already in progress".to_string());
                }
                st.active = true;
                st.signal = Some(Cancel::new());
            }
            let outcome = async {
                self.ready(ctx, &s).await?;
                if lock(&r.state).signal.as_ref().is_some_and(Cancel::is_cancelled) {
                    return Err("Sandbox execution cancelled".to_string());
                }
                r.sandbox.execute(name, call.get("input").unwrap_or(&json!({}))).await
            }
            .await;
            {
                let mut st = lock(&r.state);
                st.active = false;
                st.signal = None;
            }
            outcome
        };
        match run.await {
            Ok(Value::String(out)) => json!({ "toolCallId": call_id, "output": out }),
            Ok(other) => json!({ "toolCallId": call_id, "output": js::stringify(&other) }),
            Err(e) => failure(e),
        }
    }

    /// The chat's Stop, during a sandbox tool call.
    fn abort(&self, id: &str) -> bool {
        let Some(r) = lock(&self.runtimes).get(id).cloned() else { return false };
        let signal = lock(&r.state).signal.clone();
        match signal {
            Some(s) => {
                s.cancel();
                true
            }
            None => false,
        }
    }

    pub async fn route(&self, ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
        let id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        match channel {
            "sandbox:configure" => {
                if Self::busy(ctx, &id).await {
                    return Err("Wait for the current reply to finish before sandbox setup.".into());
                }
                self.session(ctx, &id)?;
                let store = ctx.sessions.clone().ok_or("Session not found")?;
                let image = arg(1).as_str().map(str::to_string).unwrap_or_else(|| js::display(&arg(1)));
                let (sid, ident) = (id.clone(), uuid());
                let s = tokio::task::spawn_blocking(move || store.configure_sandbox(&sid, &image, &ident, now_ms()))
                    .await
                    .map_err(|e| e.to_string())??;
                let r = self.runtime(ctx, &s).await?;
                if let Err(e) = r.sandbox.initialize().await {
                    lock(&r.state).error = Some(e.clone());
                    return Err(e);
                }
                lock(&r.state).ready = true;
                self.status(ctx, &id)
            }
            "sandbox:cleanup" => {
                if Self::busy(ctx, &id).await {
                    return Err("Wait for the current reply to finish before sandbox cleanup.".into());
                }
                let s = self.sandbox_session(ctx, &id)?;
                if js::truthy(s.get("activeRun")) || s.pointer("/sandbox/identity") != Some(&arg(1)) {
                    return Err("Sandbox is busy or identity is stale".into());
                }
                let r = self.runtime(ctx, &s).await?;
                if lock(&r.state).active {
                    return Err("Sandbox operation already in progress".into());
                }
                r.sandbox.destroy().await?;
                let mut st = lock(&r.state);
                st.ready = false;
                st.error = Some("Sandbox resources deleted. Create a new sandbox chat to resume.".into());
                Ok(Value::Null)
            }
            "sandbox:status" => self.status(ctx, &id),
            "sandbox:diff" => self.diff(ctx, &id).await,
            "sandbox:applyDiff" => {
                let diff = self.diff(ctx, &id).await?;
                let paths: Vec<Value> = arg(3).as_array().cloned().unwrap_or_default();
                let known = |p: &Value| diff["changes"].as_array().is_some_and(|c| c.iter().any(|c| &c["path"] == p));
                if diff["identity"] != arg(1)
                    || diff["diffId"] != arg(2)
                    || paths.is_empty()
                    || paths.iter().any(|p| !known(p))
                {
                    return Err("Invalid or stale sandbox diff selection".into());
                }
                Err("Apply-back is disabled: exclusive host filesystem ownership cannot be guaranteed against concurrent external writes. Export/review the diff manually.".into())
            }
            "sandbox:tool" => Ok(self.tool(ctx, &id, &arg(1)).await),
            "sandbox:abort" => Ok(json!(self.abort(&id))),
            _ => Err(format!("unknown channel {channel}")),
        }
    }
}
