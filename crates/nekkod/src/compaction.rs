//! Compacting a chat in the daemon (PF14): `chat:compact` and
//! `chat:cancelCompaction`, a port of `packages/host/src/compaction.ts`.
//!
//! The older part of a chat's transcript is summarized so the chat can keep
//! going inside the model's window: the summary goes in after the messages it
//! stands in for (or starts a new chat, `newChat`), and from then on a model
//! is sent only the summary and what follows it. What is summarized, the
//! prompt, the passes and the edit are `nekko_turn::variants`, held to the TS
//! by the golden set; here are the job per chat, its progress (`compaction`
//! events, to the UI), the summary calls on the Rust providers (four-minute limit each,
//! usage written to the usage log, a subscription's limits polled after
//! each), Stop, and the write.
//!
//! The daemon is the owner of compaction state: admission reads
//! [`Compactions::is_compacting`].

use crate::routes::Ctx;
use nekko_agent::http::AbortController;
use nekko_agent::{ChatMessage, ChatRequest, EffortLevel, ProviderChunk, ProviderConfig, Role, create_provider};
use nekko_js as js;
use nekko_turn::variants as v;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub const CHANNELS: &[&str] = &["chat:compact", "chat:cancelCompaction"];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// One running compaction.
struct Job {
    abort: AbortController,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    /// The latest `CompactionProgress`, as the UI last heard it.
    progress: Mutex<serde_json::Map<String, Value>>,
    /// How it ended: the chat the summary landed in, or the error.
    done: watch::Receiver<Option<Result<Value, String>>>,
}

#[derive(Default)]
pub struct Compactions {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Compactions {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// `isSessionCompacting`.
    pub fn is_compacting(&self, session_id: &str) -> bool {
        lock(&self.jobs).contains_key(session_id)
    }

    /// `cancelSessionCompaction`.
    pub fn cancel(&self, session_id: &str) {
        if let Some(job) = lock(&self.jobs).get(session_id).cloned() {
            job.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            job.abort.abort();
        }
    }

    pub async fn route(self: &Arc<Self>, ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
        let id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
        match channel {
            "chat:compact" => {
                // Options cross IPC, where an omitted argument can arrive as null.
                let new_chat = js::truthy(args.get(1).and_then(|o| o.get("newChat")));
                self.compact(ctx, &id, new_chat).await
            }
            "chat:cancelCompaction" => {
                self.cancel(&id);
                Ok(Value::Null)
            }
            other => Err(format!("{other} is not a compaction channel")),
        }
    }

    /// `compactSession(sessionId, { newChat })`: resolves with the chat the summary landed in.
    pub async fn compact(self: &Arc<Self>, ctx: &Ctx, session_id: &str, new_chat: bool) -> Result<Value, String> {
        let job = match self.start(ctx, session_id, new_chat).await? {
            Started::Running(job) => job,
            Started::New(job) => job,
        };
        let mut done = job.done.clone();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            if done.changed().await.is_err() {
                return Err("Compaction cancelled.".into());
            }
        }
    }

    async fn start(self: &Arc<Self>, ctx: &Ctx, session_id: &str, new_chat: bool) -> Result<Started, String> {
        if let Some(running) = lock(&self.jobs).get(session_id).cloned() {
            let redirect = new_chat && lock(&running.progress).get("target") != Some(&json!("new"));
            if redirect {
                report(ctx, session_id, &running, &[("target", json!("new"))]);
            }
            return Ok(Started::Running(running));
        }
        if crate::routes::running_chats(ctx).iter().any(|s| s == session_id) || ctx.admission.is_admitting(session_id) {
            return Err("Wait for the current reply to finish before compacting.".into());
        }
        let store = ctx.sessions.clone();
        let (st, id) = (store.clone(), session_id.to_string());
        let session = tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?;
        let settings = crate::settings::current(ctx).await;
        let provider = session.as_ref().and_then(|s| {
            settings
                .get("providers")
                .and_then(Value::as_array)?
                .iter()
                .find(|p| p.get("id") == s.get("providerId"))
                .cloned()
        });
        let offline_allowed = provider.as_ref().is_some_and(crate::admission::offline_provider_allowed);
        if let Some(refusal) = v::compaction_refusal(session.as_ref(), provider.as_ref(), offline_allowed) {
            return Err(refusal.into());
        }
        let (session, provider) = (session.expect("checked"), provider.expect("checked"));

        let (tx, rx) = watch::channel(None);
        let mut progress = serde_json::Map::new();
        progress.insert("state".into(), json!("running"));
        progress.insert("done".into(), json!(0));
        progress.insert("total".into(), json!(0));
        progress.insert("target".into(), json!(if new_chat { "new" } else { "here" }));
        let job = Arc::new(Job {
            abort: AbortController::new(),
            cancelled: Arc::default(),
            progress: Mutex::new(progress),
            done: rx,
        });
        {
            let mut jobs = lock(&self.jobs);
            // Another call may have started one while this one read the chat.
            if let Some(running) = jobs.get(session_id).cloned() {
                return Ok(Started::Running(running));
            }
            jobs.insert(session_id.to_string(), job.clone());
        }
        report(ctx, session_id, &job, &[]);
        let (me, ctx2, job2, id) = (self.clone(), ctx.clone(), job.clone(), session_id.to_string());
        tokio::spawn(async move {
            let result = run(&ctx2, &store, session, provider, &job2).await;
            let cancelled = job2.cancelled.load(std::sync::atomic::Ordering::SeqCst);
            match &result {
                Ok(landed) => {
                    let mut patch = vec![("state", json!("done"))];
                    if landed.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                        patch.push(("newSessionId", landed.get("id").cloned().unwrap_or(Value::Null)));
                    }
                    report(&ctx2, &id, &job2, &patch);
                }
                Err(e) if cancelled => {
                    let _ = e;
                    report(&ctx2, &id, &job2, &[("state", json!("cancelled"))]);
                }
                Err(e) => report(&ctx2, &id, &job2, &[("state", json!("failed")), ("error", json!(e))]),
            }
            {
                let mut jobs = lock(&me.jobs);
                if jobs.get(&id).is_some_and(|j| Arc::ptr_eq(j, &job2)) {
                    jobs.remove(&id);
                }
            }
            let _ = tx.send(Some(result));
        });
        Ok(Started::New(job))
    }
}

enum Started {
    Running(Arc<Job>),
    New(Arc<Job>),
}

/// `report(sessionId, job, patch)`: update the progress and tell the UI.
fn report(ctx: &Ctx, session_id: &str, job: &Job, patch: &[(&str, Value)]) {
    // Held throughout, so two reports reach the UI in one order.
    let mut p = lock(&job.progress);
    for (k, val) in patch {
        p.insert((*k).to_string(), val.clone());
    }
    let event = json!({ "type": "compaction", "sessionId": session_id, "progress": Value::Object(p.clone()) });
    ctx.hub.publish("agent:event", event, false);
}

/// `run(session, job)`: summarize, then land the summary.
async fn run(
    ctx: &Ctx,
    store: &Arc<nekko_store::SessionStore>,
    session: Value,
    provider: Value,
    job: &Arc<Job>,
) -> Result<Value, String> {
    let session_id = session.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let model = session.get("modelId").map(js::display).unwrap_or_default();
    let resolved = crate::providers::resolve(ctx, &provider).await?;
    let resolved = crate::admission::host_provider_config(ctx, &resolved);
    // The window the model was loaded with when the daemon last asked, else the id's guess.
    let window = crate::providers::known_context_window(&provider, &model) as f64;
    let messages: Vec<Value> = session.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let plan = v::compaction_plan(&messages, window)?;

    let config: ProviderConfig = serde_json::from_value(resolved.clone()).map_err(|e| format!("provider: {e}"))?;
    let settings = crate::settings::current(ctx).await;
    // One shield for every part of the summary, so a value keeps one placeholder throughout.
    let shield = crate::privacy::shield_for(&session, &settings, &provider);
    let summary = {
        let calls = SummaryCalls {
            shield,
            config,
            resolved: resolved.clone(),
            model: model.clone(),
            session_id: session_id.clone(),
            max_output_tokens: v::compaction_sizes(window).1,
            prompt_caching: settings.get("promptCaching") != Some(&json!(false)),
            ctx: ctx.clone(),
            job: job.clone(),
        };
        let calls = &calls;
        v::summarize_with(
            &plan.text,
            window,
            |chunk| calls.call(chunk),
            |done, total| report(ctx, &session_id, job, &[("done", json!(done)), ("total", json!(total))]),
        )
        .await?
    };
    if job.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Compaction cancelled.".into());
    }

    let marker = v::summary_message(
        &format!("compact_{}", uuid()),
        &summary,
        plan.summarized,
        plan.created_at.as_ref().unwrap_or(&json!(now_ms())),
    );
    let target_new = lock(&job.progress).get("target") == Some(&json!("new"));
    let (st, id, before) = (store.clone(), session_id.clone(), session.clone());
    tokio::task::spawn_blocking(move || land(&st, &id, &before, &plan, &marker, target_new))
        .await
        .map_err(|e| e.to_string())?
}

/// The write: refused when the chat changed meanwhile, else the summary in
/// place (or a new chat that starts from it).
fn land(
    store: &nekko_store::SessionStore,
    id: &str,
    before: &Value,
    plan: &v::CompactionPlan,
    marker: &Value,
    target_new: bool,
) -> Result<Value, String> {
    let changed = "The conversation changed during compaction. The original history was kept.".to_string();
    let unchanged = |latest: &serde_json::Map<String, Value>| {
        latest.get("updatedAt") == before.get("updatedAt")
            && js::stringify(latest.get("messages").unwrap_or(&Value::Null))
                == js::stringify(before.get("messages").unwrap_or(&Value::Null))
    };
    if target_new {
        let Some(Value::Object(latest)) = store.get(id) else { return Err(changed) };
        if !unchanged(&latest) {
            return Err(changed);
        }
        let title = latest.get("title").map_or("undefined".into(), js::display);
        let mut next = store.fork(id, &Value::Null)?.ok_or("Session not found.")?;
        let (title, messages) = v::continued_chat(&title, marker, &plan.recent);
        next["title"] = json!(title);
        next["messages"] = Value::Array(messages);
        store.save_whole(&mut next)?;
        return Ok(next);
    }
    let landed = store.update_if(id, |latest| {
        if !unchanged(latest) {
            return Err(changed.clone());
        }
        let messages: Vec<Value> = latest.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let compacted = v::compacted_transcript(&messages, plan, marker)?;
        latest.insert("messages".into(), Value::Array(compacted));
        Ok(true)
    })?;
    landed.ok_or(changed)
}

/// One compaction's summary calls on the Rust providers.
struct SummaryCalls {
    /// Privacy Shield: the chunk goes out redacted, the summary comes back restored.
    shield: Option<Arc<Mutex<nekko_privacy::Shield>>>,
    config: ProviderConfig,
    resolved: Value,
    model: String,
    session_id: String,
    max_output_tokens: u64,
    prompt_caching: bool,
    ctx: Ctx,
    job: Arc<Job>,
}

impl SummaryCalls {
    async fn call(&self, chunk: String) -> Result<String, String> {
        let cancelled = || self.job.cancelled.load(std::sync::atomic::Ordering::SeqCst);
        if cancelled() {
            return Err("Compaction cancelled.".into());
        }
        let provider = create_provider(self.config.clone());
        let token_key = self.resolved.get("tokenKey").and_then(Value::as_str).map(str::to_string);
        let subscription = self.resolved.get("auth").and_then(Value::as_str) == Some("subscription");
        let lock_shield = |s: &Arc<Mutex<nekko_privacy::Shield>>| {
            s.lock().unwrap_or_else(|e| e.into_inner()).redact(&v::summary_prompt(&chunk))
        };
        let prompt = match &self.shield {
            Some(s) => lock_shield(s),
            None => v::summary_prompt(&chunk),
        };
        let system = match &self.shield {
            Some(_) => format!("{}{}", v::SUMMARY_SYSTEM, nekko_privacy::SYSTEM_NOTE),
            None => v::SUMMARY_SYSTEM.to_string(),
        };
        let mut user = ChatMessage::new(Role::User, prompt);
        user.id = uuid();
        user.extra.insert("createdAt".into(), json!(now_ms()));
        let request = ChatRequest {
            model: self.model.clone(),
            messages: vec![user],
            system: Some(system),
            // A summary needs no deliberation, and a reasoning model left on its
            // default effort spends minutes per chunk.
            effort: Some(EffortLevel::Low),
            think: Some(false),
            prompt_caching: Some(self.prompt_caching),
            max_output_tokens: Some(self.max_output_tokens),
            signal: Some(self.job.abort.signal()),
            ..Default::default()
        };
        let mut stream = nekko_agent::Provider::chat(&provider, request);
        let mut answer = String::new();
        let read = async {
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(ProviderChunk::Text { delta }) => answer.push_str(&delta),
                    Ok(usage @ ProviderChunk::Usage { .. }) => {
                        let item = serde_json::to_value(&usage).unwrap_or(Value::Null);
                        let record = v::compaction_usage_record(
                            &self.resolved,
                            &self.model,
                            &self.session_id,
                            &item,
                            now_ms() as f64,
                        );
                        self.ctx.accounts.usage_line(&record);
                    }
                    Ok(ProviderChunk::Done) => {
                        if subscription && let Some(key) = token_key.clone() {
                            let accounts = self.ctx.accounts.clone();
                            tokio::spawn(async move {
                                accounts.poll(&key).await;
                            });
                        }
                        break;
                    }
                    Ok(_) => {}
                    Err(e) => return Err(e.message),
                }
            }
            Ok(())
        };
        let outcome = tokio::time::timeout(Duration::from_millis(v::SUMMARY_CALL_TIMEOUT_MS), read).await;
        if cancelled() {
            return Err("Compaction cancelled.".into());
        }
        match outcome {
            Err(_) => Err(format!(
                "The model took more than {} minutes on one part of the summary.",
                v::SUMMARY_CALL_TIMEOUT_MS / 60_000
            )),
            Ok(Err(e)) => Err(e),
            Ok(Ok(())) => Ok(match &self.shield {
                Some(s) => s.lock().unwrap_or_else(|e| e.into_inner()).restore(&answer),
                None => answer,
            }),
        }
    }
}
