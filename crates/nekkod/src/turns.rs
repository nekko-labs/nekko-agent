//! Whole chat turns the daemon drives (PF14 steps 2 and 3): `chat:turn`.
//!
//! The TS host admits a turn (provider, session, sandbox, worktree setup,
//! offline and endpoint checks), gathers what still needs TS services (MCP
//! tool specs, the decision runner, connector and index snippets, the
//! provider with a fresh subscription token) and hands the daemon a spec
//! (packages/host/src/daemon-turn.ts). From there the turn is the daemon's:
//!
//! - it composes the turn (`nekko-turn`: the tool list and system prompt;
//!   `nekko-context`: guidelines, attached files and memory read from disk);
//! - it puts the user's input in the transcript and writes the chat, every
//!   checkpoint and the end through `nekko-store` (`save_turn`, the port of
//!   `saveTurnSession`), before telling the UI about the step it saved;
//! - it runs the loop (`nekko-loop`) on the Rust providers, the built-in file
//!   and shell tools (`nekko-tools`), `ask_user`, `set_chat_title`,
//!   `complete_session` and an ordinary chat's `update_plan`;
//! - it owns what the turn waits on a person for ([`Pending`]): approvals and
//!   questions are raised to the UI from here and answered here
//!   (`tool:approve`, `chat:answer`, `chat:pending`), so an approval's round
//!   trip never passes through the TS event loop. Tools that still run in the
//!   host park their approvals here too (`turn:approval`).
//!
//! It calls back for what has not moved: `turn:tool` (MCP, sub-agents, the
//! browser, processes, fetch, watches, training reports, `decide`),
//! `turn:hook` (tool hooks), `turn:headers` (Anthropic subscription rate
//! limits), `loop:log` (the agent terminal); and it sends the host every
//! event (`turn:event`, deltas batched) for the phone relay and usage and
//! reply accounting, then `turn:end`.
//!
//! After a turn (step 4) the daemon starts the chat's generated title and
//! runs its next queued prompt: the host admits that prompt (`turn:prepare`)
//! and the daemon drives it as the next turn of the same chain, so the
//! host's `sendChat` resolves once the queue is worked through, as it did.

use crate::backend::Backend;
use crate::hub::Hub;
use nekko_agent::{ProviderConfig, create_provider};
use nekko_chat::ProviderClient;
use nekko_js as js;
use nekko_loop::{Cancel, RunOptions, Steering, ToolRunner, run_agent};
use nekko_store::SessionStore;
use nekko_tools::{ChangeTracker, CommandLog, ToolCall, ToolContext, approver_fn, is_ported};
use nekko_turn as turn;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, oneshot};

/// How long text and reasoning deltas are batched before the host gets them.
/// The UI gets each one at once; the host only relays them.
const DELTA_BATCH: Duration = Duration::from_millis(100);

/// The built-in tools the daemon runs itself (`nekko-tools`).
const NATIVE: &[&str] = &["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"];

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// What every session's running turn is waiting on a person for, and the
/// turns parked on it. The board asks on mount (`chat:pending`), so the
/// question lives here until it is answered, as `pendingBySession` did in TS.
#[derive(Default)]
pub struct Pending {
    inner: Mutex<PendingInner>,
}

#[derive(Default)]
struct PendingInner {
    /// `PendingInput` by session, in the order sessions started waiting.
    by_session: Map<String, Value>,
    approvals: HashMap<String, (String, oneshot::Sender<bool>)>,
    questions: HashMap<String, (String, oneshot::Sender<Value>)>,
}

impl PendingInner {
    /// `setPending(sessionId, { [key]: value })`.
    fn set(&mut self, session_id: &str, key: &str, value: Option<Value>) {
        let mut entry = match self.by_session.get(session_id) {
            Some(Value::Object(m)) => m.clone(),
            _ => {
                let mut m = Map::new();
                m.insert("sessionId".into(), json!(session_id));
                m
            }
        };
        match value {
            Some(v) => {
                entry.insert(key.into(), v);
            }
            None => {
                entry.shift_remove(key);
            }
        }
        if entry.contains_key("approval") || entry.contains_key("question") {
            self.by_session.insert(session_id.into(), Value::Object(entry));
        } else {
            self.by_session.shift_remove(session_id);
        }
    }
}

impl Pending {
    fn park_approval(&self, session_id: &str, call: &Value, reason: &str, severity: &Value) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        let mut p = lock(&self.inner);
        let id = str_at(call, "id").unwrap_or_default().to_string();
        p.approvals.insert(id, (session_id.into(), tx));
        let approval = json!({ "call": call, "reason": reason, "severity": severity, "requestedAt": now_ms() });
        p.set(session_id, "approval", Some(approval));
        rx
    }

    fn park_question(&self, session_id: &str, request: &Value) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let mut p = lock(&self.inner);
        let id = str_at(request, "callId").unwrap_or_default().to_string();
        p.questions.insert(id, (session_id.into(), tx));
        p.set(session_id, "question", Some(request.clone()));
        rx
    }

    /// `resolveApproval`: false when no turn here waits on that call.
    pub fn approve(&self, session_id: &str, call_id: &str, approved: bool) -> bool {
        let mut p = lock(&self.inner);
        let Some((_, tx)) = p.approvals.remove(call_id) else { return false };
        let _ = tx.send(approved);
        let current = p.by_session.get(session_id).and_then(|e| e.get("approval")).and_then(|a| a.get("call"));
        if current.and_then(|c| str_at(c, "id")) == Some(call_id) {
            p.set(session_id, "approval", None);
        }
        true
    }

    /// `resolveQuestion`: false when no turn here waits on that question.
    pub fn answer(&self, session_id: &str, call_id: &str, answers: Value) -> bool {
        let mut p = lock(&self.inner);
        let Some((_, tx)) = p.questions.remove(call_id) else { return false };
        let current = p.by_session.get(session_id).and_then(|e| e.get("question"));
        if current.and_then(|q| str_at(q, "callId")) == Some(call_id) {
            p.set(session_id, "question", None);
        }
        let _ = tx.send(answers);
        true
    }

    /// `releasePending`: nothing a stopped or finished turn waited on can still
    /// be answered, so every waiter of the session hears no.
    pub fn release(&self, session_id: &str) {
        let mut p = lock(&self.inner);
        let approvals: Vec<String> =
            p.approvals.iter().filter(|(_, (s, _))| s == session_id).map(|(k, _)| k.clone()).collect();
        for id in approvals {
            if let Some((_, tx)) = p.approvals.remove(&id) {
                let _ = tx.send(false);
            }
        }
        let questions: Vec<String> =
            p.questions.iter().filter(|(_, (s, _))| s == session_id).map(|(k, _)| k.clone()).collect();
        for id in questions {
            if let Some((_, tx)) = p.questions.remove(&id) {
                let _ = tx.send(json!([]));
            }
        }
        p.by_session.shift_remove(session_id);
    }

    /// `getPendingInput`.
    pub fn snapshot(&self) -> Value {
        Value::Object(lock(&self.inner).by_session.clone())
    }
}

/// What reaches the turn's forwarder, in order.
enum Out {
    /// A loop event, with the transcript at a checkpoint.
    Loop(Value, Option<Vec<Value>>),
    /// An event of the turn's own (an approval, a question, `session_meta`).
    Event(Value),
    /// The loop has ended: nothing more for the forwarder.
    End,
}

/// One event for the host, with a reply's stats on its `done`.
struct HostMsg {
    event: Value,
    extra: Option<Value>,
}

/// A running turn, as the routes that reach into it see it.
struct Shared {
    turn_id: String,
    session_id: String,
    cancel: Cancel,
    steering: Steering,
    events: mpsc::UnboundedSender<Out>,
    /// `settings.defaultChatMode`, for the live policy check on each approval.
    default_mode: Option<String>,
}

impl Shared {
    fn emit(&self, event: Value) {
        let _ = self.events.send(Out::Event(event));
    }
}

pub struct Turns {
    store: Option<Arc<SessionStore>>,
    data_dir: Option<PathBuf>,
    changes: Arc<ChangeTracker>,
    running: Mutex<HashMap<String, Arc<Shared>>>,
    pub pending: Pending,
}

static STEER_SEQ: AtomicU64 = AtomicU64::new(0);

impl Turns {
    pub fn new(store: Option<Arc<SessionStore>>, data_dir: Option<PathBuf>, changes: Arc<ChangeTracker>) -> Self {
        Self { store, data_dir, changes, running: Mutex::default(), pending: Pending::default() }
    }

    fn by_session(&self, session_id: &str) -> Option<Arc<Shared>> {
        lock(&self.running).values().find(|s| s.session_id == session_id).cloned()
    }

    /// `turn:alive`: whether this turn is still being driven here.
    pub fn is_running(&self, turn_id: &str) -> bool {
        lock(&self.running).contains_key(turn_id)
    }

    /// The sessions whose turn runs here (`chat:running` adds the host's).
    pub fn running_sessions(&self) -> Vec<String> {
        let mut ids: Vec<String> = lock(&self.running).values().map(|s| s.session_id.clone()).collect();
        ids.dedup();
        ids
    }

    /// `turn:abort`: stop a turn by id; true when there was one.
    pub fn abort(&self, turn_id: &str) -> bool {
        let Some(shared) = lock(&self.running).get(turn_id).cloned() else { return false };
        shared.cancel.cancel();
        self.pending.release(&shared.session_id);
        true
    }

    /// `chat:abort`: stop this session's turn here, if it has one.
    pub fn abort_session(&self, session_id: &str) -> bool {
        let Some(shared) = self.by_session(session_id) else { return false };
        shared.cancel.cancel();
        self.pending.release(session_id);
        true
    }

    /// `turn:steer` / `chat:steer`: a user message for this session's running
    /// turn, folded in at its next tool boundary; false when it has none here.
    pub fn steer(&self, session_id: &str, message: Value) -> bool {
        let Some(shared) = self.by_session(session_id) else { return false };
        lock(&shared.steering).push(message);
        true
    }

    /// The steering message `steerChat` makes from typed text.
    pub fn steering_message(content: &str) -> Value {
        let n = STEER_SEQ.fetch_add(1, Ordering::Relaxed);
        let mut rand = [0u8; 4];
        let _ = getrandom::fill(&mut rand);
        let r = u32::from_le_bytes(rand) as u64 ^ n;
        json!({
            "id": format!("msg_{}_{}", base36(now_ms()), &format!("{:0>6}", base36(r))[..6]),
            "role": "user",
            "content": content,
            "createdAt": now_ms(),
        })
    }

    /// `turn:approval`: an approval for a tool the host runs, parked here
    /// with the rest of the turn's input; the answer goes back through
    /// `turn:approved`.
    pub fn host_approval(
        self: &Arc<Self>,
        backend: Arc<Backend>,
        turn_id: &str,
        args: &[Value],
    ) -> Result<Value, String> {
        let shared = lock(&self.running).get(turn_id).cloned().ok_or("This run has already ended.")?;
        let call = args.first().cloned().unwrap_or(Value::Null);
        let reason = args.get(1).and_then(Value::as_str).unwrap_or_default().to_string();
        let severity = args.get(2).cloned().unwrap_or(json!("medium"));
        let me = self.clone();
        tokio::spawn(async move {
            let id = str_at(&call, "id").unwrap_or_default().to_string();
            let ok = me.request_approval(&shared, &call, &reason, &severity).await;
            let _ = backend.call("turn:approved", json!([id, ok])).await;
        });
        Ok(json!(true))
    }

    /// The approval prompt: the live policy first (the user can allow the
    /// rest of the turn while it waits), then park and ask.
    async fn request_approval(&self, shared: &Shared, call: &Value, reason: &str, severity: &Value) -> bool {
        if self.live_mode(shared).await == "yolo" {
            return true;
        }
        let rx = self.pending.park_approval(&shared.session_id, call, reason, severity);
        shared.emit(json!({
            "type": "tool_approval_required",
            "sessionId": shared.session_id,
            "call": call,
            "reason": reason,
            "severity": severity,
        }));
        rx.await.unwrap_or(false)
    }

    /// `getSession(id)?.mode ?? settings.defaultChatMode ?? 'guardrails'`.
    async fn live_mode(&self, shared: &Shared) -> String {
        let store = self.store.clone();
        let id = shared.session_id.clone();
        let mode = tokio::task::spawn_blocking(move || {
            store.and_then(|s| s.get(&id)).and_then(|s| s.get("mode").and_then(Value::as_str).map(str::to_string))
        })
        .await
        .ok()
        .flatten();
        mode.or_else(|| shared.default_mode.clone()).unwrap_or_else(|| "guardrails".into())
    }

    /// `chat:turn`: start driving a turn; `turn:end` tells the host when it is over.
    pub fn start(self: &Arc<Self>, backend: Arc<Backend>, hub: Hub, spec: Value) -> Result<Value, String> {
        let store = self.store.clone().ok_or("chat:turn needs the daemon to know the data directory")?;
        let turn_id = str_at(&spec, "turnId").ok_or("chat:turn needs a turnId")?.to_string();
        let opts = spec.get("opts").cloned().ok_or("chat:turn needs the send options")?;
        let session_id = str_at(&opts, "sessionId").ok_or("chat:turn needs a sessionId")?.to_string();
        if !nekko_store::valid_id(&session_id) {
            return Err("Session not found.".into());
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            turn_id: turn_id.clone(),
            session_id,
            cancel: Cancel::default(),
            steering: Arc::default(),
            events: tx,
            default_mode: spec.pointer("/settings/defaultChatMode").and_then(Value::as_str).map(str::to_string),
        });
        lock(&self.running).insert(turn_id.clone(), shared.clone());
        let me = self.clone();
        tokio::spawn(async move {
            let summary = me.drive(&backend, hub.clone(), store.clone(), &spec, shared.clone(), rx).await;
            lock(&me.running).remove(&turn_id);
            me.pending.release(&shared.session_id);
            let summary = me.after_turn(&backend, &hub, &store, &spec, &turn_id, summary).await;
            let _ = backend.call("turn:end", json!([turn_id, summary])).await;
        });
        Ok(json!({ "started": true }))
    }

    /// What follows a turn here (PF14 step 4): the chat's generated title,
    /// started and left to land on its own, and the next queued prompt, run
    /// as the next turn of the chain (`summary.next`) once the host has
    /// admitted it (`turn:prepare`), or handed back to the host to run
    /// (`summary.drain`). A turn that never started has nothing after it.
    async fn after_turn(
        self: &Arc<Self>,
        backend: &Arc<Backend>,
        hub: &Hub,
        store: &Arc<SessionStore>,
        spec: &Value,
        turn_id: &str,
        mut summary: Value,
    ) -> Value {
        if summary.get("early") == Some(&Value::Bool(true)) {
            return summary;
        }
        let opts = &spec["opts"];
        let session_id = str_at(opts, "sessionId").unwrap_or_default().to_string();
        let (st, id) = (store.clone(), session_id.clone());
        let Some(fresh) = tokio::task::spawn_blocking(move || st.get(&id)).await.ok().flatten() else {
            return summary;
        };
        // titleAuto guards a name the user typed; incognito and offline chats
        // skip the extra call, as does a turn whose provider never resolved.
        if !js::truthy(fresh.get("incognito"))
            && !js::truthy(fresh.get("offline"))
            && fresh.get("titleAuto") == Some(&Value::Bool(true))
            && spec.pointer("/facts/provider").is_some_and(Value::is_object)
        {
            let messages = fresh.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            tokio::spawn(generate_title(backend.clone(), hub.clone(), store.clone(), spec.clone(), messages));
        }
        if summary.get("aborted") == Some(&Value::Bool(true)) || js::truthy(fresh.get("archivedAt")) {
            return summary;
        }
        let Some(next) = fresh.get("queue").and_then(Value::as_array).and_then(|q| q.first()).cloned() else {
            return summary;
        };
        let base = json!({
            "sessionId": session_id,
            "providerId": opts.get("providerId").cloned().unwrap_or(Value::Null),
            "modelId": opts.get("modelId").cloned().unwrap_or(Value::Null),
            "text": "",
        });
        let payload =
            json!({ "opts": turn::send_options_for_queued_item(&base, &next), "queued": { "index": 0, "item": next } });
        match backend.call("turn:prepare", json!([turn_id, payload])).await {
            Ok(reply) if reply.get("spec").is_some_and(Value::is_object) => {
                let next_spec = reply["spec"].clone();
                let next_id = next_spec.get("turnId").cloned().unwrap_or(Value::Null);
                match self.start(backend.clone(), hub.clone(), next_spec) {
                    Ok(_) => summary["next"] = next_id,
                    Err(e) => eprintln!("nekkod: could not start the next queued turn: {e}"),
                }
            }
            Ok(reply) if reply.get("inProcess") == Some(&Value::Bool(true)) => summary["drain"] = json!("host"),
            Ok(_) => {}
            Err(e) => eprintln!("nekkod: the host could not admit the next queued turn: {e}"),
        }
        summary
    }

    async fn drive(
        self: &Arc<Self>,
        backend: &Arc<Backend>,
        hub: Hub,
        store: Arc<SessionStore>,
        spec: &Value,
        shared: Arc<Shared>,
        rx: mpsc::UnboundedReceiver<Out>,
    ) -> Value {
        // The host's copy of every event, in order and batched; the UI never
        // waits on it. Drained before `turn:end`.
        let (host_tx, host_rx) = mpsc::unbounded_channel::<HostMsg>();
        let host_task = tokio::spawn(forward_to_host(host_rx, backend.clone(), shared.turn_id.clone()));
        let summary = self.run_turn(backend, &hub, store, spec, &shared, rx, &host_tx).await;
        drop(host_tx);
        let _ = host_task.await;
        summary
    }

    #[allow(clippy::too_many_arguments, clippy::too_many_lines)]
    async fn run_turn(
        self: &Arc<Self>,
        backend: &Arc<Backend>,
        hub: &Hub,
        store: Arc<SessionStore>,
        spec: &Value,
        shared: &Arc<Shared>,
        rx: mpsc::UnboundedReceiver<Out>,
        host_tx: &mpsc::UnboundedSender<HostMsg>,
    ) -> Value {
        let opts = &spec["opts"];
        let settings = &spec["settings"];
        let facts = &spec["facts"];
        let session_id = shared.session_id.clone();
        let say = |event: Value| {
            hub.publish("agent:event", event.clone(), false);
            let _ = host_tx.send(HostMsg { event, extra: None });
        };
        let early = |message: &str| {
            say(json!({ "type": "error", "sessionId": session_id, "message": message }));
            json!({ "early": true })
        };

        let s_id = session_id.clone();
        let st = store.clone();
        let Some(loaded) = tokio::task::spawn_blocking(move || st.get(&s_id)).await.ok().flatten() else {
            return early("Session not found.");
        };
        // Sandbox turns stay with the host's container router.
        if str_at(&loaded, "executionMode") == Some("sandbox") {
            return early("chat:turn is unsupported for sandbox sessions; use the host container router");
        }
        let incognito = js::truthy(loaded.get("incognito"));

        // The turn's composition: tools, context from disk, the system prompt.
        let tool_input = json!({
            "session": loaded,
            "offline": js::truthy(loaded.get("offline")),
            "orchestration": settings.get("orchestration").cloned().unwrap_or(Value::Null),
            "allowBrowserControl": spec.get("allowBrowserControl").cloned().unwrap_or(json!(false)),
            "mcpTools": facts.get("mcpTools").cloned().unwrap_or(json!([])),
            "decide": facts.get("decide").cloned().unwrap_or(json!(false)),
        });
        let tools = turn::turn_tools(&tool_input);
        let workspaces: Vec<Value> = facts.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
        let data_dir = self.data_dir.clone().or_else(|| store.dir().parent().map(PathBuf::from));
        let block = {
            let (loaded, opts, facts, workspaces) = (loaded.clone(), opts.clone(), facts.clone(), workspaces.clone());
            tokio::task::spawn_blocking(move || context_block(&loaded, &opts, &facts, &workspaces, data_dir.as_deref()))
                .await
                .unwrap_or_default()
        };
        let execution_mode = match str_at(&loaded, "executionMode") {
            Some(m) => m.to_string(),
            None if loaded.get("gitIsolation") == Some(&Value::Bool(false)) => "unified".into(),
            None => "worktree".into(),
        };
        let notices: Vec<Value> = loaded
            .get("gitWorktrees")
            .and_then(Value::as_object)
            .map(|m| m.values().map(|w| json!(w.get("notice").map(js::display).unwrap_or_default())).collect())
            .unwrap_or_default();
        let system = turn::turn_system_prompt(&json!({
            "workspaces": workspaces,
            "tools": tools,
            "settings": settings,
            "sandbox": false,
            "executionMode": execution_mode,
            "worktreeNotices": notices,
            "contextBlock": block,
            "platform": facts.get("platform").cloned().unwrap_or(json!(std::env::consts::OS)),
        }));

        if shared.cancel.is_cancelled() {
            return json!({ "early": true });
        }

        // The user's input, saved before the reply starts.
        let mut session_value = loaded;
        turn::apply_turn_input(&mut session_value, opts, now_ms());
        let session = Arc::new(Mutex::new(session_value));
        let queued = spec.get("queued").filter(|q| !q.is_null()).cloned();
        if let Some(q) = queued {
            let (st, sess) = (store.clone(), session.clone());
            let saved = tokio::task::spawn_blocking(move || {
                let index = q.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                st.save_turn(&mut lock(&sess), Some((index, q.get("item").unwrap_or(&Value::Null))))
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            if let Err(e) = saved {
                return early(&e);
            }
            say(json!({ "type": "session_meta", "sessionId": session_id }));
        } else {
            persist(&store, &session, incognito).await;
            // The wall composer and transcript are separate panes: both show the
            // saved user turn before streaming starts.
            if !incognito {
                say(json!({ "type": "session_meta", "sessionId": session_id }));
            }
        }

        let config: Result<ProviderConfig, String> = match (facts.get("provider"), str_at(facts, "providerError")) {
            (_, Some(e)) => Err(e.to_string()),
            (Some(p), None) => serde_json::from_value(p.clone()).map_err(|e| format!("provider: {e}")),
            (None, None) => Err("Provider not configured or disabled.".into()),
        };
        let config = match config {
            Ok(c) => c,
            Err(e) => return early(&e),
        };

        // On disk while the turn runs, so a restart knows it was cut off.
        if let Some(obj) = lock(&session).as_object_mut() {
            obj.insert("activeRun".into(), json!({ "startedAt": now_ms() }));
        }
        persist(&store, &session, incognito).await;

        let turn_from = lock(&session).get("messages").and_then(Value::as_array).map_or(0, Vec::len);
        let started_at = now_ms();
        let mut identity = Map::new();
        identity.insert("providerId".into(), opts.get("providerId").cloned().unwrap_or(Value::Null));
        identity.insert("modelId".into(), opts.get("modelId").cloned().unwrap_or(Value::Null));
        if let Some(e) = facts.get("statsEffort").filter(|v| !v.is_null()) {
            identity.insert("effort".into(), e.clone());
        }
        let forwarder = tokio::spawn(forward(
            rx,
            Forward {
                hub: hub.clone(),
                host: host_tx.clone(),
                store: store.clone(),
                session: session.clone(),
                incognito,
                session_id: session_id.clone(),
                stats: turn::TurnStats::new(identity, started_at as f64),
                turn_from,
                started_at,
            },
        ));

        let provider = create_provider(config);
        let client = if facts.get("headers") == Some(&Value::Bool(true)) {
            let (b, id) = (backend.clone(), shared.turn_id.clone());
            ProviderClient::with_headers(
                provider,
                Arc::new(move |headers: &Vec<(String, String)>| {
                    let (b, id, pairs) = (b.clone(), id.clone(), json!(headers));
                    tokio::spawn(async move {
                        let _ = b.call("turn:headers", json!([id, pairs])).await;
                    });
                }),
            )
        } else {
            ProviderClient::new(provider)
        };
        let names: HashSet<String> = tools.iter().map(|t| turn::catalog::name(t).to_string()).collect();
        let mode = str_at(&lock(&session), "mode")
            .map(str::to_string)
            .or_else(|| shared.default_mode.clone())
            .unwrap_or_else(|| "guardrails".into());
        let hooks = facts.get("hooks") == Some(&Value::Bool(true));
        let native =
            if hooks { None } else { native_context(self, shared, backend, settings, &workspaces, &mode, &session_id) };
        let runner = TurnTools {
            turns: self.clone(),
            shared: shared.clone(),
            backend: backend.clone(),
            store: store.clone(),
            session: session.clone(),
            names,
            native,
            hooks,
            incognito,
            training: js::truthy(lock(&session).get("trainingRunId")),
            unattended_ms: (settings.get("unattendedQuestionMinutes").and_then(Value::as_f64).unwrap_or(0.0).max(0.0)
                * 60_000.0) as u64,
        };

        let mut history: Vec<Value> =
            lock(&session).get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let events = shared.events.clone();
        let str_of = |v: &Value, k: &str| str_at(v, k).map(str::to_string);
        let run = RunOptions {
            session_id: session_id.clone(),
            model: str_of(opts, "modelId").unwrap_or_default(),
            system,
            history: &mut history,
            tools,
            temperature: facts.get("temperature").and_then(Value::as_f64),
            effort: str_of(facts, "effort"),
            think: lock(&session).get("thinking").and_then(Value::as_bool),
            prompt_caching: Some(facts.get("promptCaching").and_then(Value::as_bool).unwrap_or(true)),
            max_history_turns: opts.get("maxHistoryTurns").and_then(Value::as_f64),
            max_output_tokens: facts.get("maxOutputTokens").and_then(Value::as_u64),
            resume: opts.get("resume") == Some(&json!(true)),
            cancel: shared.cancel.clone(),
            steering: shared.steering.clone(),
        };
        run_agent(run, &client, &runner, &mut |event: Value, transcript: &[Value]| {
            let snapshot = is_checkpoint(&event).then(|| transcript.to_vec());
            let _ = events.send(Out::Loop(event, snapshot));
        })
        .await;
        drop(runner);
        // The routes keep a sender for as long as the turn is listed, so the
        // forwarder is told it has had the loop's last event.
        let _ = shared.events.send(Out::End);
        let last_stop = forwarder.await.ok().flatten();

        // The turn is over: nothing it waited on can still be answered.
        self.pending.release(&session_id);
        if let Some(obj) = lock(&session).as_object_mut() {
            obj.remove("activeRun");
        }
        persist(&store, &session, incognito).await;

        // Steering that arrived during the final model call runs next, queued.
        let left: Vec<Value> = std::mem::take(&mut *lock(&shared.steering));
        if !incognito && !left.is_empty() {
            let (st, id) = (store.clone(), session_id.clone());
            let _ = tokio::task::spawn_blocking(move || {
                for m in left {
                    let _ = st.queue(&id, m.get("content").unwrap_or(&Value::Null));
                }
            })
            .await;
        }

        let mut summary = json!({ "aborted": shared.cancel.is_cancelled() });
        if let Some(stop) = last_stop {
            summary["stop"] = stop;
        }
        summary
    }
}

/// `titleSession`: ask the turn's own provider and model for a short title
/// once a chat's turn has content, and land it unless the user named the
/// chat meanwhile. A failure just leaves the prompt-prefix placeholder. The
/// call's usage goes to the host's usage log (`turn:usage`), and the title's
/// `session_meta` to the UI and the host's listeners (`turn:notify`).
async fn generate_title(backend: Arc<Backend>, hub: Hub, store: Arc<SessionStore>, spec: Value, messages: Vec<Value>) {
    let Some(content) = turn::title_prompt(&messages) else { return };
    let opts = &spec["opts"];
    let facts = &spec["facts"];
    let session_id = str_at(opts, "sessionId").unwrap_or_default().to_string();
    let request = json!({
        "provider": facts["provider"],
        "request": {
            "model": opts.get("modelId").cloned().unwrap_or(Value::Null),
            "messages": [{ "id": "title", "role": "user", "createdAt": now_ms(), "content": content }],
            "temperature": 0.2,
            "maxOutputTokens": 24,
            "think": false,
            "purpose": "title",
            "promptCaching": facts.get("promptCaching").cloned().unwrap_or(json!(true)),
        },
        "timeoutMs": 30_000,
        "usageOnFailure": true,
    });
    let Ok(out) = crate::sideband::complete(&request).await else { return };
    if let Some(usage) = out.get("usage").filter(|u| u.as_array().is_some_and(|a| !a.is_empty())) {
        let provider = &facts["provider"];
        let who = json!({ "id": provider.get("id"), "kind": provider.get("kind"), "auth": provider.get("auth") });
        let record =
            json!({ "provider": who, "modelId": opts.get("modelId"), "sessionId": session_id, "usage": usage });
        let _ = backend.call("turn:usage", json!([record])).await;
    }
    if out.get("error").is_some() {
        return;
    }
    let title = turn::clean_title(out.get("text").and_then(Value::as_str).unwrap_or_default());
    if title.is_empty() {
        return;
    }
    let (st, id) = (store.clone(), session_id.clone());
    let landed = tokio::task::spawn_blocking(move || st.set_auto_title(&id, &title)).await;
    if matches!(landed, Ok(Ok(true))) {
        let meta = json!({ "type": "session_meta", "sessionId": session_id });
        hub.publish("agent:event", meta.clone(), false);
        let _ = backend.call("turn:notify", json!([meta])).await;
    }
}

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn is_delta(e: &Value) -> bool {
    matches!(str_at(e, "type"), Some("text" | "reasoning"))
}

fn is_checkpoint(e: &Value) -> bool {
    matches!(str_at(e, "type"), Some("step" | "steered" | "tool_result" | "done" | "error"))
}

/// The context block a turn sends: attached files, guidelines and memory
/// from disk, the host's connector and index snippets, and the chat's
/// include and pin choices.
fn context_block(
    session: &Value,
    opts: &Value,
    facts: &Value,
    workspaces: &[Value],
    data_dir: Option<&std::path::Path>,
) -> String {
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    };
    let mut attached = strings(session.get("attachedPaths"));
    attached.extend(strings(opts.get("attachedPaths")));
    let paths: Vec<String> = workspaces.iter().filter_map(|w| str_at(w, "path").map(str::to_string)).collect();
    let guidelines = nekko_context::collect_guidelines(&paths).into_iter().map(|g| (g.path, g.content)).collect();
    let mut memory = Vec::new();
    if let Some(dir) = data_dir {
        memory.extend(nekko_context::list_memory(dir, "global", None));
        let mut seen = HashSet::new();
        let primary = str_at(session, "workspaceId").map(str::to_string);
        let supporting = strings(session.get("supportingWorkspaceIds")).into_iter().filter(|s| !s.is_empty());
        for id in primary.into_iter().chain(supporting) {
            if seen.insert(id.clone()) {
                memory.extend(nekko_context::list_memory(dir, "workspace", Some(&id)));
            }
        }
    }
    let triple = |v: &Value, a: &str, b: &str, c: &str| -> (String, String, String) {
        let s = |k: &str| v.get(k).map(js::display).unwrap_or_default();
        (s(a), s(b), s(c))
    };
    let connector = facts
        .get("connectorSnippets")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|s| triple(s, "label", "origin", "body")).collect())
        .unwrap_or_default();
    let index = facts
        .get("indexSnippets")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|s| triple(s, "relPath", "path", "body")).collect())
        .unwrap_or_default();
    let prefs = session.get("contextPrefs");
    let bundle = nekko_context::assemble(nekko_context::AssembleInput {
        attached: nekko_context::collect_attached(&attached),
        guidelines,
        memory,
        connector_snippets: connector,
        index_snippets: index,
        excluded: strings(prefs.and_then(|p| p.get("excluded"))).into_iter().collect(),
        pinned: strings(prefs.and_then(|p| p.get("pinned"))).into_iter().collect(),
        ..Default::default()
    });
    nekko_context::render_block(&bundle)
}

/// `persist()`: save the turn's chat over whatever the user changed on disk
/// meanwhile (`saveTurnSession`); never an incognito chat.
async fn persist(store: &Arc<SessionStore>, session: &Arc<Mutex<Value>>, incognito: bool) {
    if incognito {
        return;
    }
    let (st, sess) = (store.clone(), session.clone());
    let saved = tokio::task::spawn_blocking(move || st.save_turn(&mut lock(&sess), None)).await;
    if let Ok(Err(e)) = saved {
        eprintln!("nekkod: could not save a running turn's chat: {e}");
    }
}

struct Forward {
    hub: Hub,
    host: mpsc::UnboundedSender<HostMsg>,
    store: Arc<SessionStore>,
    session: Arc<Mutex<Value>>,
    incognito: bool,
    session_id: String,
    stats: turn::TurnStats,
    turn_from: usize,
    started_at: u64,
}

/// The turn's events, in order: checkpoints saved first, then the UI told,
/// then the host. Returns how the reply ended (`done.stop`).
async fn forward(mut rx: mpsc::UnboundedReceiver<Out>, mut f: Forward) -> Option<Value> {
    let mut last_stop = None;
    while let Some(out) = rx.recv().await {
        let (event, snapshot) = match out {
            Out::End => break,
            Out::Event(e) => {
                f.hub.publish("agent:event", e.clone(), false);
                let _ = f.host.send(HostMsg { event: e, extra: None });
                continue;
            }
            Out::Loop(e, s) => (e, s),
        };
        if str_at(&event, "type") == Some("usage") {
            f.stats.add(&event);
        }
        let mut extra = None;
        if let Some(snapshot) = snapshot {
            let mut s = lock(&f.session);
            if let Some(obj) = s.as_object_mut() {
                obj.insert("messages".into(), Value::Array(snapshot));
            }
        }
        if str_at(&event, "type") == Some("done") {
            if let Some(stop) = event.get("stop").filter(|v| js::truthy(Some(v))) {
                last_stop = Some(stop.clone());
            }
            // Stats go on the transcript before the checkpoint writes it, so a
            // pane that re-reads the chat on `done` already finds them.
            let finished = f.stats.finish(now_ms() as f64, event.get("steps"), event.get("stop"));
            if let Some(stats) = &finished {
                let mut s = lock(&f.session);
                if let Some(Value::Array(messages)) = s.get_mut("messages") {
                    turn::attach_turn_stats(messages, f.turn_from, stats);
                }
            }
            extra = Some(json!({ "stats": finished, "startedAt": f.started_at }));
        }
        if is_checkpoint(&event) {
            persist(&f.store, &f.session, f.incognito).await;
        }
        let steered = str_at(&event, "type") == Some("steered");
        f.hub.publish("agent:event", event.clone(), false);
        let _ = f.host.send(HostMsg { event, extra });
        if steered {
            // The steering message is in the transcript now; panes re-read it.
            let meta = json!({ "type": "session_meta", "sessionId": f.session_id });
            f.hub.publish("agent:event", meta.clone(), false);
            let _ = f.host.send(HostMsg { event: meta, extra: None });
        }
    }
    last_stop
}

/// Deltas of one kind in a row, joined, as the host relays them.
fn coalesce(batch: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in batch {
        if let Some(last) = out.last_mut()
            && last["type"] == e["type"]
        {
            let joined = format!("{}{}", last["delta"].as_str().unwrap_or(""), e["delta"].as_str().unwrap_or(""));
            last["delta"] = json!(joined);
            continue;
        }
        out.push(e);
    }
    out
}

/// The host's copy of the turn's events, in order, deltas batched. The UI
/// never waits on this: it has each event already.
async fn forward_to_host(mut rx: mpsc::UnboundedReceiver<HostMsg>, backend: Arc<Backend>, turn_id: String) {
    let mut deltas: Vec<Value> = Vec::new();
    let send = |payload: Value| {
        let (backend, turn_id) = (backend.clone(), turn_id.clone());
        async move {
            let _ = backend.call("turn:event", json!([turn_id, payload])).await;
        }
    };
    loop {
        let next = if deltas.is_empty() {
            rx.recv().await
        } else {
            match tokio::time::timeout(DELTA_BATCH, rx.recv()).await {
                Ok(v) => v,
                Err(_) => {
                    send(json!({ "events": coalesce(std::mem::take(&mut deltas)) })).await;
                    continue;
                }
            }
        };
        let Some(msg) = next else { break };
        if is_delta(&msg.event) {
            deltas.push(msg.event);
            continue;
        }
        if !deltas.is_empty() {
            send(json!({ "events": coalesce(std::mem::take(&mut deltas)) })).await;
        }
        let mut payload = json!({ "events": [msg.event] });
        if let Some(Value::Object(extra)) = msg.extra {
            for (k, v) in extra {
                payload[k] = v;
            }
        }
        send(payload).await;
    }
    if !deltas.is_empty() {
        send(json!({ "events": coalesce(deltas) })).await;
    }
}

/// The agent terminal lines of one turn, sent to the host in order.
struct HostLog(mpsc::UnboundedSender<Value>);

impl CommandLog for HostLog {
    fn append(&self, session_id: &str, workspace_id: Option<&str>, data: &str) {
        let _ = self.0.send(json!([session_id, workspace_id, data]));
    }
}

/// The built-in tools' context, or `None` (every tool then runs in the
/// host) when a setting is one this build cannot read, such as a guardrail
/// rule it does not know.
fn native_context(
    turns: &Arc<Turns>,
    shared: &Arc<Shared>,
    backend: &Arc<Backend>,
    settings: &Value,
    workspaces: &[Value],
    mode: &str,
    session_id: &str,
) -> Option<ToolContext> {
    let (t, s) = (turns.clone(), shared.clone());
    let approver = approver_fn(move |call: ToolCall, reason: String, severity| {
        let (t, s) = (t.clone(), s.clone());
        async move {
            let call = serde_json::to_value(&call).unwrap_or(Value::Null);
            let severity = serde_json::to_value(severity).unwrap_or(json!("medium"));
            t.request_approval(&s, &call, &reason, &severity).await
        }
    });
    let mut ctx = ToolContext::new(approver);
    let parse = |key: &str| settings.get(key).filter(|v| !v.is_null()).cloned();
    if let Some(v) = parse("sandboxMode") {
        ctx.sandbox_mode = serde_json::from_value(v).ok()?;
    }
    if let Some(v) = parse("guardrails") {
        ctx.guardrails = Some(serde_json::from_value(v).ok()?);
    }
    let ws: Vec<Value> = workspaces.iter().map(|w| json!({ "id": w.get("id"), "path": w.get("path") })).collect();
    ctx.workspaces = serde_json::from_value(Value::Array(ws)).ok()?;
    ctx.mode = serde_json::from_value(json!(mode)).ok()?;
    ctx.default_cwd = workspaces.first().and_then(|w| str_at(w, "path")).map(str::to_string);
    ctx.session_id = Some(session_id.to_string());
    ctx.changes = Some(turns.changes.clone());
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let b = backend.clone();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let _ = b.call("loop:log", line).await;
        }
    });
    ctx.command_log = Some(Arc::new(HostLog(tx)));
    // Stop stops a running command too.
    let tools_cancel = ctx.cancel.clone();
    shared.cancel.on_cancel(move || tools_cancel.cancel());
    Some(ctx)
}

/// A turn's tool calls: where each runs, with hooks around them.
struct TurnTools {
    turns: Arc<Turns>,
    shared: Arc<Shared>,
    backend: Arc<Backend>,
    store: Arc<SessionStore>,
    session: Arc<Mutex<Value>>,
    names: HashSet<String>,
    native: Option<ToolContext>,
    hooks: bool,
    incognito: bool,
    training: bool,
    unattended_ms: u64,
}

fn result(id: &str, output: impl Into<String>) -> Value {
    json!({ "toolCallId": id, "output": output.into() })
}

fn error(id: &str, output: impl Into<String>) -> Value {
    json!({ "toolCallId": id, "output": output.into(), "isError": true })
}

impl ToolRunner for TurnTools {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        if !self.hooks {
            return self.inner(call).await;
        }
        // PreToolUse hooks may block a call, PostToolUse hooks may add to its result (hooks.ts).
        let id = str_at(call, "id").unwrap_or_default();
        let pre =
            self.backend.call("turn:hook", json!([self.shared.turn_id, "pre", call])).await.unwrap_or(Value::Null);
        let notes: Vec<String> =
            pre.get("notes").and_then(Value::as_array).map(|a| a.iter().map(js::display).collect()).unwrap_or_default();
        if let Some(block) = pre.get("block").filter(|b| js::truthy(Some(b))) {
            let mut lines = vec![js::display(block)];
            lines.extend(notes);
            return Ok(error(id, lines.join("\n")));
        }
        let out = self.inner(call).await?;
        let post = self
            .backend
            .call("turn:hook", json!([self.shared.turn_id, "post", call, out]))
            .await
            .ok()
            .filter(|v| v.is_object())
            .unwrap_or(out);
        if notes.is_empty() {
            return Ok(post);
        }
        let mut post = post;
        let output = format!("{}\n\n{}", post.get("output").map(js::display).unwrap_or_default(), notes.join("\n"));
        post["output"] = json!(output);
        Ok(post)
    }
}

impl TurnTools {
    async fn inner(&self, call: &Value) -> Result<Value, String> {
        let id = str_at(call, "id").unwrap_or_default();
        let name = str_at(call, "name").unwrap_or_default();
        let input = call.get("input").cloned().unwrap_or(json!({}));
        if !self.names.contains(name) {
            return Ok(error(id, "This tool is disabled or unavailable for this chat."));
        }
        match name {
            "set_chat_title" => return Ok(self.set_title(id, &input).await),
            "complete_session" => return Ok(self.complete(id, &input).await),
            "ask_user" => return Ok(result(id, self.ask(call).await)),
            "update_plan" if !self.training => return Ok(self.update_plan(id, &input).await),
            _ => {}
        }
        if let Some(ctx) = &self.native
            && NATIVE.contains(&name)
            && is_ported(name)
        {
            let call: ToolCall = serde_json::from_value(call.clone()).map_err(|e| e.to_string())?;
            return serde_json::to_value(nekko_tools::execute(&call, ctx).await).map_err(|e| e.to_string());
        }
        let reply = self.backend.call("turn:tool", json!([self.shared.turn_id, call])).await?;
        if let Some(Value::Object(patch)) = reply.get("patch") {
            {
                let mut s = lock(&self.session);
                if let Some(obj) = s.as_object_mut() {
                    for (k, v) in patch {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
            persist(&self.store, &self.session, self.incognito).await;
            self.shared.emit(json!({ "type": "session_meta", "sessionId": self.shared.session_id }));
        }
        Ok(reply.get("result").cloned().unwrap_or_else(|| error(id, "The host returned no result.")))
    }

    async fn disk(&self) -> Option<Value> {
        let (st, id) = (self.store.clone(), self.shared.session_id.clone());
        tokio::task::spawn_blocking(move || st.get(&id)).await.ok().flatten()
    }

    fn meta(&self) {
        self.shared.emit(json!({ "type": "session_meta", "sessionId": self.shared.session_id }));
    }

    async fn set_title(&self, id: &str, input: &Value) -> Value {
        if self.disk().await.is_some_and(|d| d.get("titleAuto") == Some(&Value::Bool(false))) {
            return result(id, "The chat already has a chosen title; it was not changed.");
        }
        let title = match input.get("title") {
            Some(Value::String(t)) => js::slice16(&js::fold_space(js::trim(t)), 64).to_string(),
            _ => String::new(),
        };
        if title.is_empty() {
            return error(id, "A nonblank title is required.");
        }
        if let Some(obj) = lock(&self.session).as_object_mut() {
            obj.insert("title".into(), json!(title));
            obj.insert("titleAuto".into(), json!(false));
        }
        persist(&self.store, &self.session, self.incognito).await;
        self.meta();
        result(id, "Chat title updated.")
    }

    async fn complete(&self, id: &str, input: &Value) -> Value {
        if input.as_object().is_some_and(|o| !o.is_empty()) {
            return error(id, "complete_session takes no arguments and only completes the current chat.");
        }
        let Some(disk) = self.disk().await else {
            return error(id, "Session not found; completion was not saved.");
        };
        let at = disk.get("archivedAt").filter(|v| !v.is_null()).cloned().unwrap_or(json!(now_ms()));
        let (st, sid) = (self.store.clone(), self.shared.session_id.clone());
        let saved = tokio::task::spawn_blocking(move || st.set_options(&sid, &json!({ "archivedAt": at }))).await.ok();
        let Some(Ok(Some(saved))) = saved else {
            return error(id, "Session not found; completion was not saved.");
        };
        if let Some(obj) = lock(&self.session).as_object_mut() {
            obj.insert("archivedAt".into(), saved.get("archivedAt").cloned().unwrap_or(Value::Null));
        }
        self.meta();
        result(
            id,
            "This session is marked completed (archived). Messages are retained under the app\u{2019}s archive retention policy. You can restore it from completed chats.",
        )
    }

    async fn update_plan(&self, id: &str, input: &Value) -> Value {
        let current = lock(&self.session).get("agentPlan").cloned();
        let output = match turn::apply_plan_update(current.as_ref(), input, now_ms()) {
            turn::PlanOutcome::Applied { plan, .. } => {
                let echo = turn::plan_echo(&plan);
                if let Some(obj) = lock(&self.session).as_object_mut() {
                    obj.insert("agentPlan".into(), Value::Array(plan));
                    obj.insert("updatedAt".into(), json!(now_ms()));
                }
                echo
            }
            turn::PlanOutcome::Refused(e) => e,
            turn::PlanOutcome::Threw(m) => return error(id, format!("Failed to update the plan: {m}")),
        };
        persist(&self.store, &self.session, self.incognito).await;
        self.meta();
        result(id, output)
    }

    /// `askUser`: park the turn on a question until it is answered, the turn
    /// stops, or (with an unattended limit set) nobody answers in time.
    async fn ask(&self, call: &Value) -> String {
        let c = turn::catalog::catalog();
        let call_id = str_at(call, "id").unwrap_or_default().to_string();
        let request = match turn::parse_ask_request(&call_id, call.get("input").unwrap_or(&Value::Null), now_ms()) {
            Ok(r) => r,
            Err(e) => return e,
        };
        let session_id = self.shared.session_id.clone();
        let rx = self.turns.pending.park_question(&session_id, &request);
        self.shared.emit(json!({ "type": "question", "sessionId": session_id, "request": request }));
        let mut unattended = false;
        let answers = if self.unattended_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(self.unattended_ms), rx).await {
                Ok(a) => a.unwrap_or(json!([])),
                Err(_) => {
                    unattended = true;
                    self.turns.pending.answer(&session_id, &call_id, json!([]));
                    json!([])
                }
            }
        } else {
            rx.await.unwrap_or(json!([]))
        };
        self.shared.emit(json!({ "type": "question_resolved", "sessionId": session_id, "callId": call_id }));
        if answers.as_array().is_none_or(Vec::is_empty) {
            return if unattended { c.ask_unattended.clone() } else { c.ask_cancelled.clone() };
        }
        turn::format_ask_answers(&request, &answers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str) -> Value {
        json!({ "id": id, "name": "bash", "input": { "command": "rm -rf x" } })
    }

    #[tokio::test]
    async fn an_approval_is_pending_until_answered_and_then_gone() {
        let p = Pending::default();
        let rx = p.park_approval("s1", &call("c1"), "Delete", &json!("high"));
        let snap = p.snapshot();
        assert_eq!(snap["s1"]["sessionId"], "s1");
        assert_eq!(snap["s1"]["approval"]["call"]["id"], "c1");
        assert_eq!(snap["s1"]["approval"]["severity"], "high");
        assert!(!p.approve("s1", "other", true));
        assert!(p.approve("s1", "c1", true));
        assert!(rx.await.unwrap());
        assert_eq!(p.snapshot(), json!({}));
        assert!(!p.approve("s1", "c1", true), "an answered approval cannot be answered twice");
    }

    #[tokio::test]
    async fn a_question_and_an_approval_share_the_session_entry() {
        let p = Pending::default();
        let approval = p.park_approval("s1", &call("c1"), "r", &json!("low"));
        let question = p.park_question("s1", &json!({ "callId": "q1", "questions": [], "askedAt": 1 }));
        let snap = p.snapshot();
        assert!(snap["s1"].get("approval").is_some() && snap["s1"].get("question").is_some());
        assert!(p.answer("s1", "q1", json!([{ "questionId": "q1", "labels": ["a"] }])));
        assert_eq!(question.await.unwrap()[0]["labels"][0], "a");
        let snap = p.snapshot();
        assert!(snap["s1"].get("question").is_none() && snap["s1"].get("approval").is_some());
        p.release("s1");
        assert!(!approval.await.unwrap(), "a released approval is a no");
        assert_eq!(p.snapshot(), json!({}));
    }

    #[tokio::test]
    async fn release_answers_every_waiter_of_the_session_only() {
        let p = Pending::default();
        let a = p.park_approval("s1", &call("c1"), "r", &json!("low"));
        let q = p.park_question("s1", &json!({ "callId": "q1" }));
        let other = p.park_approval("s2", &call("c2"), "r", &json!("low"));
        p.release("s1");
        assert!(!a.await.unwrap());
        assert_eq!(q.await.unwrap(), json!([]));
        assert!(p.snapshot().get("s2").is_some());
        assert!(p.approve("s2", "c2", true));
        assert!(other.await.unwrap());
    }

    #[test]
    fn steering_messages_look_like_the_hosts() {
        let m = Turns::steering_message("also check the tests");
        assert_eq!(m["role"], "user");
        assert_eq!(m["content"], "also check the tests");
        let id = m["id"].as_str().unwrap();
        assert!(id.starts_with("msg_") && id.matches('_').count() == 2, "{id}");
    }

    #[test]
    fn coalesces_runs_of_the_same_delta_kind_only() {
        let e = |t: &str, d: &str| json!({ "type": t, "sessionId": "s", "delta": d });
        let out = coalesce(vec![e("reasoning", "a"), e("reasoning", "b"), e("text", "c"), e("text", "d")]);
        assert_eq!(out, vec![e("reasoning", "ab"), e("text", "cd")]);
    }
}
