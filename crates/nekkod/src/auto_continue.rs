//! Keeping a chat going when it runs out of context, with nobody watching
//! (`startAutoContinue`, packages/host/src/auto-continue.ts), here when no
//! host runs beside the daemon.
//!
//! The loop already keeps a run inside the window where it can and retries an
//! overflow once with older tool output left out. When even that does not
//! fit, the reply ends with an overflow error: this compacts the chat and
//! sends it on, so the work continues instead of parking on a Retry banner.
//! It also compacts after a finished reply that left the transcript near the
//! window, which the chat pane only does while it is open.

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Automatic continuations a chat gets before it waits for the user. Reset by a reply that finishes.
pub const MAX_AUTO_CONTINUES: u32 = 2;
/// Share of the window the transcript alone may fill before a finished reply triggers compaction.
pub const COMPACT_AFTER_REPLY: f64 = 0.85;
/// How long to wait for the ending turn's after-work to let go of the chat.
const SETTLE: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(250);

/// The visible user turn that carries an overflowed chat on after compaction.
pub const CONTINUE_AFTER_COMPACTION: &str = "The conversation was compacted automatically because it no longer fit the model's context window. Continue the task from where the summary leaves off: work it lists as done is done, so do not repeat it. Re-read a file or re-run a check only when you need its current contents. If the task was already finished, give the final answer.";

type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What the loop needs of the daemon (`AutoContinueDeps`).
pub trait Deps: Send + Sync + 'static {
    fn session(&self, id: &str) -> Fut<'_, Option<Value>>;
    /// A reply running, being admitted, or a compaction under way.
    fn is_running(&self, id: &str) -> Fut<'_, bool>;
    /// Whether the provider is a Claude Agent (`claude-code`): Claude Code
    /// keeps and compacts that chat's context itself, so it is left alone.
    fn is_claude_code(&self, provider_id: &str) -> Fut<'_, bool>;
    /// The window last used for this chat's model.
    fn context_window(&self, provider_id: &str, model_id: &str) -> u64;
    fn compact(&self, id: &str) -> Fut<'_, Result<(), String>>;
    /// A user turn on the chat's own provider and model.
    fn send(&self, session: &Value, text: &str) -> Fut<'_, ()>;
    /// Tell the chat what happened, when it could not carry on.
    fn notify(&self, event: Value);
}

/// `eligible(session)`: a chat this daemon may compact and continue by itself.
pub fn eligible(session: Option<&Value>) -> bool {
    let Some(s) = session.filter(|s| s.is_object()) else { return false };
    let t = |k: &str| nekko_js::truthy(s.get(k));
    let queued = s.get("queue").and_then(Value::as_array).is_some_and(|q| !q.is_empty());
    !t("incognito")
        && !t("archivedAt")
        && !t("parentSessionId")
        && !t("trainingRunId")
        && t("providerId")
        && t("modelId")
        && !queued
}

pub struct AutoContinue<D: Deps> {
    deps: D,
    continues: Mutex<HashMap<String, u32>>,
    busy: Mutex<HashSet<String>>,
    poll: Duration,
    settle: Duration,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl<D: Deps> AutoContinue<D> {
    pub fn new(deps: D) -> Arc<Self> {
        Arc::new(Self { deps, continues: Mutex::default(), busy: Mutex::default(), poll: POLL, settle: SETTLE })
    }

    #[cfg(test)]
    fn quick(deps: D) -> Arc<Self> {
        Arc::new(Self {
            deps,
            continues: Mutex::default(),
            busy: Mutex::default(),
            poll: Duration::from_millis(1),
            settle: Duration::from_millis(50),
        })
    }

    /// One agent event; what it starts runs on its own and is returned for tests.
    pub fn on_event(self: &Arc<Self>, e: &Value) -> Option<tokio::task::JoinHandle<()>> {
        let id = e.get("sessionId").and_then(Value::as_str)?.to_string();
        match e.get("type").and_then(Value::as_str)? {
            "error" if overflow(e) => {
                let message = nekko_js::display(e.get("message").unwrap_or(&Value::Null));
                self.run(id, Work::Overflow(message))
            }
            "done" => {
                lock(&self.continues).remove(&id);
                self.run(id, Work::Reply)
            }
            _ => None,
        }
    }

    fn run(self: &Arc<Self>, id: String, work: Work) -> Option<tokio::task::JoinHandle<()>> {
        if !lock(&self.busy).insert(id.clone()) {
            return None;
        }
        let me = self.clone();
        Some(tokio::spawn(async move {
            match work {
                Work::Overflow(message) => me.after_overflow(&id, &message).await,
                Work::Reply => me.after_reply(&id).await,
            }
            lock(&me.busy).remove(&id);
        }))
    }

    /// The chat, when this daemon may compact and continue it: `eligible`, and
    /// not a Claude Agent chat.
    async fn compactable(&self, id: &str) -> Option<Value> {
        let session = self.deps.session(id).await.filter(|s| eligible(Some(s)))?;
        let provider = session.get("providerId").and_then(Value::as_str).unwrap_or_default();
        (!self.deps.is_claude_code(provider).await).then_some(session)
    }

    /// Wait for the ending turn to let go of the chat; false when it never does.
    async fn settled(&self, id: &str) -> bool {
        let until = tokio::time::Instant::now() + self.settle;
        while self.deps.is_running(id).await {
            if tokio::time::Instant::now() > until {
                return false;
            }
            tokio::time::sleep(self.poll).await;
        }
        true
    }

    async fn after_overflow(&self, id: &str, overflow_message: &str) {
        let used = lock(&self.continues).get(id).copied().unwrap_or(0);
        if used >= MAX_AUTO_CONTINUES {
            self.deps.notify(json!({
                "type": "error",
                "sessionId": id,
                "message": format!("This chat ran out of context {} times in a row and was not continued again automatically. Compact it or start a new chat from its summary.", used + 1),
            }));
            return;
        }
        if !self.settled(id).await {
            return;
        }
        let Some(session) = self.compactable(id).await else { return };
        if overhead_overflow(overflow_message, &session) {
            return;
        }
        lock(&self.continues).insert(id.to_string(), used + 1);
        if let Err(e) = self.deps.compact(id).await {
            self.deps.notify(json!({
                "type": "error",
                "sessionId": id,
                "message": format!("The chat ran out of context and could not be compacted: {e}"),
            }));
            return;
        }
        // The user sent something meanwhile.
        if self.deps.is_running(id).await {
            return;
        }
        if let Some(fresh) = self.compactable(id).await {
            self.deps.send(&fresh, CONTINUE_AFTER_COMPACTION).await;
        }
    }

    async fn after_reply(&self, id: &str) {
        if !self.settled(id).await {
            return;
        }
        let Some(session) = self.compactable(id).await else { return };
        let messages = session.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        if messages.is_empty() {
            return;
        }
        let s = |k: &str| session.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let window = self.deps.context_window(&s("providerId"), &s("modelId"));
        if window == 0
            || (nekko_turn::variants::estimate_transcript_tokens(&messages) as f64)
                < window as f64 * COMPACT_AFTER_REPLY
        {
            return;
        }
        let _ = self.deps.compact(id).await;
    }
}

enum Work {
    /// With the error's message.
    Overflow(String),
    Reply,
}

/// The overflow is the system prompt and tools, not the conversation: the
/// error names the prompt size (a local server's `n_prompt_tokens`) and the
/// transcript is under half of it. A summary would free almost nothing, so
/// the chat is left with the error, which says to load the model with a
/// larger window. (Compacting a two-message chat on an 8k window used to fail
/// with "the conversation changed during compaction" as its title landed.)
fn overhead_overflow(message: &str, session: &Value) -> bool {
    let Some((_, needed)) = nekko_loop::fit::overflow_sizes(message) else { return false };
    let messages = session.get("messages").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    (nekko_turn::variants::estimate_transcript_tokens(messages) as f64) < needed as f64 / 2.0
}

/// An `error` event that says the prompt no longer fits (`isContextOverflowError`).
fn overflow(e: &Value) -> bool {
    nekko_loop::fit::is_context_overflow(&nekko_js::display(e.get("message").unwrap_or(&Value::Null)))
}

/// The daemon's side of the loop.
struct Daemon(Ctx);

impl Deps for Daemon {
    fn session(&self, id: &str) -> Fut<'_, Option<Value>> {
        let (store, id) = (self.0.sessions.clone(), id.to_string());
        Box::pin(async move { tokio::task::spawn_blocking(move || store.get(&id)).await.ok().flatten() })
    }
    fn is_running(&self, id: &str) -> Fut<'_, bool> {
        let id = id.to_string();
        Box::pin(async move {
            let ctx = &self.0;
            ctx.compactions.is_compacting(&id)
                || ctx.admission.is_admitting(&id)
                || crate::routes::running_chats(ctx).contains(&id)
        })
    }
    fn is_claude_code(&self, provider_id: &str) -> Fut<'_, bool> {
        let id = provider_id.to_string();
        Box::pin(async move { crate::providers::kind_of(&self.0, &id).await.as_deref() == Some("claude-code") })
    }
    fn context_window(&self, provider_id: &str, model_id: &str) -> u64 {
        crate::providers::known_context_window(&json!({ "id": provider_id }), model_id)
    }
    fn compact(&self, id: &str) -> Fut<'_, Result<(), String>> {
        let id = id.to_string();
        Box::pin(async move { crate::routes::route(&self.0, "chat:compact", vec![json!(id)]).await.map(|_| ()) })
    }
    fn send(&self, session: &Value, text: &str) -> Fut<'_, ()> {
        let opts = json!({
            "sessionId": session.get("id"),
            "providerId": session.get("providerId"),
            "modelId": session.get("modelId"),
            "text": text,
        });
        Box::pin(async move {
            let _ = crate::routes::route(&self.0, "chat:send", vec![opts]).await;
        })
    }
    fn notify(&self, event: Value) {
        self.0.hub.publish("agent:event", event, false);
    }
}

/// Follow every chat's agent events for as long as the daemon runs.
pub fn start(ctx: &Ctx) {
    let me = AutoContinue::new(Daemon(ctx.clone()));
    let mut rx = ctx.hub.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if !ev.text.starts_with("{\"channel\":\"agent:event\"") {
                        continue;
                    }
                    let Ok(frame) = serde_json::from_str::<Value>(&ev.text) else { continue };
                    me.on_event(&frame["payload"]);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct Fake {
        session: Mutex<Option<Value>>,
        running: AtomicBool,
        compact_fails: AtomicBool,
        window: u64,
        log: Mutex<Vec<String>>,
    }

    impl Deps for Arc<Fake> {
        fn session(&self, _: &str) -> Fut<'_, Option<Value>> {
            let s = lock(&self.session).clone();
            Box::pin(async move { s })
        }
        fn is_running(&self, _: &str) -> Fut<'_, bool> {
            let r = self.running.load(Ordering::SeqCst);
            Box::pin(async move { r })
        }
        fn is_claude_code(&self, provider_id: &str) -> Fut<'_, bool> {
            let cc = provider_id == "cc";
            Box::pin(async move { cc })
        }
        fn context_window(&self, _: &str, _: &str) -> u64 {
            self.window
        }
        fn compact(&self, id: &str) -> Fut<'_, Result<(), String>> {
            lock(&self.log).push(format!("compact {id}"));
            let fails = self.compact_fails.load(Ordering::SeqCst);
            Box::pin(async move { if fails { Err("no summary".into()) } else { Ok(()) } })
        }
        fn send(&self, s: &Value, text: &str) -> Fut<'_, ()> {
            lock(&self.log).push(format!("send {} {}", s["id"].as_str().unwrap(), &text[..20]));
            Box::pin(async {})
        }
        fn notify(&self, e: Value) {
            lock(&self.log).push(format!("notify {}", e["message"].as_str().unwrap()));
        }
    }

    fn chat() -> Value {
        json!({ "id": "s1", "providerId": "p1", "modelId": "m", "messages": [{ "role": "user", "content": "x".repeat(400) }] })
    }

    fn overflow_event() -> Value {
        json!({ "type": "error", "sessionId": "s1", "message": "openai 400: This model's maximum context length is 8192 tokens" })
    }

    fn rig(window: u64) -> (Arc<Fake>, Arc<AutoContinue<Arc<Fake>>>) {
        let fake = Arc::new(Fake { window, ..Fake::default() });
        *lock(&fake.session) = Some(chat());
        (fake.clone(), AutoContinue::quick(fake))
    }

    fn log(f: &Fake) -> Vec<String> {
        lock(&f.log).clone()
    }

    #[test]
    fn only_plain_chats_with_a_model_and_no_queue_are_eligible() {
        assert!(eligible(Some(&chat())));
        for (k, v) in [
            ("incognito", json!(true)),
            ("archivedAt", json!(1)),
            ("parentSessionId", json!("s0")),
            ("trainingRunId", json!("r")),
            ("providerId", json!("")),
            ("modelId", Value::Null),
            ("queue", json!([{ "text": "next" }])),
        ] {
            let mut s = chat();
            s[k] = v;
            assert!(!eligible(Some(&s)), "{k}");
        }
        let mut s = chat();
        s["queue"] = json!([]);
        assert!(eligible(Some(&s)));
        assert!(!eligible(None));
    }

    #[tokio::test]
    async fn an_overflow_is_compacted_and_continued_twice_then_left_for_the_user() {
        let (fake, ac) = rig(0);
        for _ in 0..3 {
            ac.on_event(&overflow_event()).unwrap().await.unwrap();
        }
        let sent = "send s1 The conversation was";
        assert_eq!(
            log(&fake),
            vec![
                "compact s1".to_string(),
                sent.to_string(),
                "compact s1".to_string(),
                sent.to_string(),
                "notify This chat ran out of context 3 times in a row and was not continued again automatically. Compact it or start a new chat from its summary.".to_string(),
            ]
        );
        // A finished reply resets the count.
        ac.on_event(&json!({ "type": "done", "sessionId": "s1" })).unwrap().await.unwrap();
        ac.on_event(&overflow_event()).unwrap().await.unwrap();
        assert_eq!(log(&fake).last().unwrap(), sent);
    }

    #[tokio::test]
    async fn an_overflow_on_the_prompt_and_tools_alone_is_not_compacted() {
        // About 100 tokens of chat against a 10,510-token prompt: the rest is the system prompt and tools.
        let (fake, ac) = rig(0);
        for message in [
            r#"Model stream failed: Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (10510 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":10510,"n_ctx":8192}}"#,
            "The model is loaded with a 8192-token context window, and this chat needs 10510 tokens. Reload the model with a larger context length (16384 or more) in your model server, then send again.",
        ] {
            ac.on_event(&json!({ "type": "error", "sessionId": "s1", "message": message })).unwrap().await.unwrap();
        }
        assert!(log(&fake).is_empty(), "{:?}", log(&fake));
        // A conversation that is most of the prompt is still compacted.
        let message = "The model is loaded with a 8192-token context window, and this chat needs 150 tokens. Reload the model with a larger context length (16384 or more) in your model server, then send again.";
        ac.on_event(&json!({ "type": "error", "sessionId": "s1", "message": message })).unwrap().await.unwrap();
        assert_eq!(log(&fake)[0], "compact s1");
    }

    #[tokio::test]
    async fn a_failed_compaction_is_reported_and_nothing_is_sent() {
        let (fake, ac) = rig(0);
        fake.compact_fails.store(true, Ordering::SeqCst);
        ac.on_event(&overflow_event()).unwrap().await.unwrap();
        assert_eq!(
            log(&fake),
            vec!["compact s1", "notify The chat ran out of context and could not be compacted: no summary"]
        );
    }

    #[tokio::test]
    async fn a_chat_that_stays_busy_or_is_not_eligible_is_left_alone() {
        let (fake, ac) = rig(0);
        fake.running.store(true, Ordering::SeqCst);
        ac.on_event(&overflow_event()).unwrap().await.unwrap();
        fake.running.store(false, Ordering::SeqCst);
        lock(&fake.session).as_mut().unwrap()["incognito"] = json!(true);
        ac.on_event(&overflow_event()).unwrap().await.unwrap();
        assert!(log(&fake).is_empty(), "{:?}", log(&fake));
        // Neither an overflow nor an ending: nothing.
        assert!(
            ac.on_event(&json!({ "type": "error", "sessionId": "s1", "message": "429 rate limit: tokens per min" }))
                .is_none()
        );
        assert!(ac.on_event(&json!({ "type": "text", "sessionId": "s1" })).is_none());
    }

    #[tokio::test]
    async fn a_claude_agent_chat_is_never_compacted_or_continued() {
        let (fake, ac) = rig(110);
        lock(&fake.session).as_mut().unwrap()["providerId"] = json!("cc");
        ac.on_event(&overflow_event()).unwrap().await.unwrap();
        ac.on_event(&json!({ "type": "done", "sessionId": "s1" })).unwrap().await.unwrap();
        assert!(log(&fake).is_empty(), "{:?}", log(&fake));
    }

    #[tokio::test]
    async fn a_finished_reply_near_the_window_is_compacted() {
        // 400 characters are about 100 tokens: past 85% of a 110-token window, not of a 200-token one.
        let (fake, ac) = rig(110);
        ac.on_event(&json!({ "type": "done", "sessionId": "s1" })).unwrap().await.unwrap();
        assert_eq!(log(&fake), vec!["compact s1"]);
        let (fake, ac) = rig(200);
        ac.on_event(&json!({ "type": "done", "sessionId": "s1" })).unwrap().await.unwrap();
        assert!(log(&fake).is_empty());
    }
}
