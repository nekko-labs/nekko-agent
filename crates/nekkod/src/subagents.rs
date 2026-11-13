//! Claude Code's sub-agents as child chats.
//!
//! Claude Code runs a sub-agent inside the chat's own session, so Nekko only
//! reads about it in the stream. Each one becomes an ordinary child chat, with
//! its own [`Mapper`] over its own lines, so the agents panel, the wall, the
//! delegation rows and the phones show it the way they show a `spawn_agent`
//! child. Claude Code keeps the real history: this copy is for watching, and
//! `chat:send` refuses it (admission.rs). Nothing here sends anything to
//! Claude Code, and its usage is already in the parent's `result`.

use crate::harness::Harness;
use crate::hub::Hub;
use nekko_harness::{Mapped, Mapper, Outcome, Subagent};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// A sub-agent still running.
pub struct Run {
    mapper: Mapper,
    session: Arc<Mutex<Value>>,
    /// Outlives the turn that started it, until its `task_notification`.
    pub background: bool,
    /// The model was read off its first reply.
    model_known: bool,
}

impl Run {
    pub fn chat_id(&self) -> String {
        lock(&self.session).get("id").and_then(Value::as_str).unwrap_or_default().to_string()
    }
}

/// Who the sub-agents of a turn belong to.
pub struct Parent {
    pub id: String,
    pub workspace: Option<String>,
    pub supporting: Vec<Value>,
    pub provider_id: Value,
    pub model_id: Value,
    pub settings: Value,
}

#[derive(Clone)]
pub struct Sink {
    pub harness: Arc<Harness>,
    pub store: Arc<SessionStore>,
    pub hub: Hub,
}

impl Sink {
    /// Read a turn's sub-agent events in order, until the turn drops the sender.
    pub async fn drive(self, parent: Parent, mut events: mpsc::UnboundedReceiver<Subagent>) {
        while let Some(event) = events.recv().await {
            match event {
                Subagent::Started { call_id, title, task, background } => {
                    if let Err(e) = self.start(&parent, &call_id, title, task, background).await {
                        eprintln!("nekkod: could not make a sub-agent's child chat: {e}");
                    }
                }
                Subagent::Line { call_id, line } => {
                    let model = line.pointer("/message/model").and_then(Value::as_str).map(str::to_string);
                    let run = self.harness.with_subagent(&parent.id, &call_id, |run| {
                        let model = model.filter(|_| !std::mem::replace(&mut run.model_known, true));
                        if let (Some(m), Some(obj)) = (&model, lock(&run.session).as_object_mut()) {
                            obj.insert("modelId".into(), json!(m));
                        }
                        (run.session.clone(), run.mapper.map(&line), model.is_some())
                    });
                    if let Some((session, mapped, renamed)) = run {
                        self.apply(&session, mapped, renamed).await;
                    }
                }
                // Kept past the end of this turn, until its notification.
                Subagent::Backgrounded { call_id } => {
                    self.harness.with_subagent(&parent.id, &call_id, |run| run.background = true);
                }
                Subagent::Ended { call_id, outcome } => self.end(&parent.id, &call_id, outcome).await,
            }
        }
    }

    /// Close what the turn left open. A process that went away takes the
    /// background ones with it.
    pub async fn sweep(&self, parent_id: &str, background_too: bool) {
        for call_id in self.harness.open_subagents(parent_id, background_too) {
            self.end(parent_id, &call_id, Outcome::Interrupted).await;
        }
    }

    async fn end(&self, parent_id: &str, call_id: &str, outcome: Outcome) {
        // Also reached for a background command's notification, which has no child.
        let Some(mut run) = self.harness.remove_subagent(parent_id, call_id) else { return };
        let mut mapped = run.mapper.close(outcome);
        // What the stream missed, from the transcript Claude Code saved.
        let (store, snapshot) = (self.store.clone(), lock(&run.session).clone());
        let filled = tokio::task::spawn_blocking(move || saved_transcript(&store, &snapshot)).await.ok().flatten();
        let filled = filled.is_some_and(|messages| {
            if let Some(obj) = lock(&run.session).as_object_mut() {
                obj.insert("messages".into(), Value::Array(messages));
                obj.insert("transcriptFilledAt".into(), json!(nekko_js::now_ms()));
            }
            true
        });
        if filled {
            // The saved transcript already holds the step that was in progress.
            mapped.retain(|m| !matches!(m, Mapped::Message(_)));
        }
        self.apply(&run.session, mapped, filled).await;
    }

    async fn start(
        &self,
        parent: &Parent,
        call_id: &str,
        title: String,
        task: String,
        background: bool,
    ) -> Result<(), String> {
        let title = crate::spawn::child_title(Some(&title), &task);
        let provider_id = parent.provider_id.clone();
        let model_id = parent.model_id.clone();
        let (store, parent_id, call) = (self.store.clone(), parent.id.clone(), call_id.to_string());
        let (workspace, supporting, settings) =
            (parent.workspace.clone(), json!(parent.supporting), parent.settings.clone());
        let session = tokio::task::spawn_blocking(move || -> Result<Value, String> {
            let made = store.create_with_mode_defaults(
                workspace.as_deref(),
                Some(&parent_id),
                Some(&supporting),
                &settings,
                true,
            )?;
            let id = made.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            store.assign(
                &id,
                &[
                    ("title", json!(title)),
                    ("providerId", provider_id),
                    ("modelId", model_id),
                    ("claudeCodeSubagent", json!(true)),
                    ("spawnCallId", json!(call)),
                ],
            )?;
            store.get(&id).ok_or_else(|| "The child chat was not saved.".to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        let id = session.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let session = Arc::new(Mutex::new(session));
        let first =
            json!({ "id": format!("{id}_task"), "role": "user", "content": task, "createdAt": nekko_js::now_ms() });
        let mapped = vec![Mapped::Message(first)];
        let run = Run { mapper: Mapper::new(id.clone()), session: session.clone(), background, model_known: false };
        self.harness.add_subagent(&parent.id, call_id, run);
        self.apply(&session, mapped, true).await;
        // Marks it working everywhere until its first real event.
        self.hub.publish("agent:event", json!({ "type": "text", "sessionId": id, "delta": "" }), false);
        Ok(())
    }

    /// Save before anyone is told, so a pane that reloads on `done` finds it.
    async fn apply(&self, session: &Arc<Mutex<Value>>, mapped: Vec<Mapped>, meta: bool) {
        let mut events = Vec::new();
        let mut changed = meta;
        for item in mapped {
            match item {
                Mapped::Message(m) => {
                    if let Some(all) = lock(session).get_mut("messages").and_then(Value::as_array_mut) {
                        all.push(m);
                    }
                    changed = true;
                }
                Mapped::Event(e) => events.push(e),
                _ => {}
            }
        }
        if changed {
            let (store, sess) = (self.store.clone(), session.clone());
            let saved = tokio::task::spawn_blocking(move || store.save_turn_shared(&sess, None)).await;
            if let Ok(Err(e)) = saved {
                eprintln!("nekkod: could not save a sub-agent's chat: {e}");
            }
        }
        if meta {
            let id = lock(session).get("id").cloned().unwrap_or(Value::Null);
            self.hub.publish("agent:event", json!({ "type": "session_meta", "sessionId": id }), false);
        }
        for event in events {
            self.hub.publish("agent:event", event, false);
        }
    }
}

/// A Claude Code sub-agent's child chat, filled from the transcript Claude
/// Code saved for it (`subagents/agent-*.jsonl`): its opening task message,
/// then every saved step. `None` unless that holds more than the chat has and
/// every tool call the chat already shows, so a wrong or older file never
/// replaces it. Sub-agent lines reach Nekko only while it reads the stream,
/// and a background one could outlive that (#2645).
pub fn saved_transcript(store: &SessionStore, child: &Value) -> Option<Vec<Value>> {
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if child.get("claudeCodeSubagent") != Some(&Value::Bool(true)) {
        return None;
    }
    let (id, parent_id, call) = (text(child, "id")?, text(child, "parentSessionId")?, text(child, "spawnCallId")?);
    let parent = store.meta(&parent_id)?.into_value();
    let session = text(&parent, "claudeCodeSessionId")?;
    let config = nekko_harness::claude_config_dir(text(&parent, "claudeCodeAccount").as_deref())?;
    let path = nekko_harness::find_transcript(&config, &session, &call)?;
    let saved = nekko_harness::transcript_messages(&nekko_harness::read_transcript(&path), &id, &call);
    let have: &[Value] = child.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let task = have.first().filter(|m| m.get("id").and_then(Value::as_str).is_some_and(|i| i.ends_with("_task")));
    let (had_ids, saved_ids) = (nekko_harness::tool_call_ids(have), nekko_harness::tool_call_ids(&saved));
    let more = saved_ids.len() > had_ids.len() || saved.len() > have.len() - usize::from(task.is_some());
    if saved.is_empty() || !more || !had_ids.is_subset(&saved_ids) {
        return None;
    }
    Some(task.cloned().into_iter().chain(saved).collect())
}

/// At startup: fill the child chats of Claude Code sub-agents that ended
/// short, from the transcripts Claude Code saved (until #2645 a background
/// sub-agent's chat stopped recording when the turn that started it ended).
/// A filled chat keeps its `updatedAt`, so the chat lists do not reorder.
/// Chats untouched for over 30 days are left alone. Returns how many it filled.
pub fn fill_short_chats(store: &SessionStore) -> usize {
    const RECENT_MS: u64 = 30 * 24 * 60 * 60 * 1000;
    let now = nekko_js::now_ms();
    let mut filled = 0;
    for mut child in store.list_containing("\"claudeCodeSubagent\"") {
        let updated = child.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
        if child.get("transcriptFilledAt").is_some() || now.saturating_sub(updated) > RECENT_MS {
            continue;
        }
        let Some(messages) = saved_transcript(store, &child) else { continue };
        if let Some(obj) = child.as_object_mut() {
            obj.insert("messages".into(), Value::Array(messages));
            obj.insert("transcriptFilledAt".into(), json!(now));
        }
        match store.put_synced(&child) {
            Ok(()) => filled += 1,
            Err(e) => eprintln!("nekkod: could not fill a sub-agent's chat: {e}"),
        }
    }
    filled
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
