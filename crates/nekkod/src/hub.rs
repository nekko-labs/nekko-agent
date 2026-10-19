//! The event fan-out: one serialized `{ channel, payload }` frame per event,
//! shared by every connected client.
//!
//! Agent events (`agent:event`) belong to a chat. Each is published with its
//! session, a sequence number and whether it is a summary event, so a socket
//! subscribed to some chats (`daemon:subscribe`, wire.rs) skips the other
//! chats' stream without parsing a frame. Summary events still reach every
//! socket: a turn's first event, waiting on a person (an approval, a
//! question), the first event after such a wait, the chat record changing
//! (`session_meta`, `compaction`) and the end (`done`, `error`). The sidebar,
//! the board, notifications and the sub-agent rail follow every chat from
//! those alone. The hub also keeps the events of each running turn, so a
//! socket that starts showing a chat mid-turn is sent what it missed
//! (`agent:replay`), and a window that connects mid-turn learns which chats
//! are running (`Hub::status`).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Who an event is for.
#[derive(Clone, Debug)]
pub enum Scope {
    /// Everyone (settings, downloads, limits, terminals, ...).
    Global,
    /// One chat's agent event.
    Session {
        id: Arc<str>,
        /// Increases with every agent event the hub publishes (all chats).
        seq: u64,
        /// Sent to sockets not subscribed to the chat too.
        summary: bool,
    },
}

#[derive(Clone, Debug)]
pub struct Event {
    /// The frame exactly as clients receive it.
    pub text: Arc<str>,
    /// Output of a daemon-owned terminal. The desktop UI reads that from the
    /// binary terminal stream instead, so its RPC socket skips these.
    pub term_data: bool,
    pub scope: Scope,
}

/// Where a chat's running turn stands, as far as its events tell.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Running,
    /// Waiting on a person (an approval or a question).
    Waiting,
}

/// A running turn's events so far.
struct Turn {
    phase: Phase,
    /// Its first event's frame: what a window that connects mid-turn is sent
    /// for a chat it does not show, to mark it running.
    /// None while the turn has only waited (resending a wait would notify again).
    first: Option<Arc<str>>,
    last: Instant,
    /// For replay: the events, deltas joined, and when each arrived (ms).
    events: Vec<Value>,
    at: Vec<u64>,
    bytes: usize,
    /// Events were dropped from the front to stay under [`REPLAY_MAX_BYTES`].
    truncated: bool,
}

/// What one chat's replay may hold. Text and reasoning deltas are joined as
/// they arrive, so this is mostly tool output; past it the oldest events go.
const REPLAY_MAX_BYTES: usize = 4 * 1024 * 1024;

/// A turn silent this long sends its next event to everyone again, so a turn
/// that died without its `done` cannot hide the next one from the sidebar.
const QUIET: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Sessions {
    seq: u64,
    turns: HashMap<Arc<str>, Turn>,
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Event>,
    sessions: Arc<Mutex<Sessions>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

/// How an agent event type is handled (see the module comment).
#[derive(PartialEq, Eq, Clone, Copy)]
enum Kind {
    /// The turn ended: everyone hears it, its log is dropped.
    End,
    /// About the chat, not the turn's output: everyone, not kept.
    Meta,
    /// Waiting on a person: everyone, kept.
    Wait,
    /// The person answered or steered: everyone, kept.
    Resume,
    /// Output: subscribers only, but for the first of a turn or after a wait.
    Stream,
}

fn kind_of(event_type: &str) -> Kind {
    match event_type {
        "done" | "error" => Kind::End,
        "session_meta" | "compaction" => Kind::Meta,
        "tool_approval_required" | "question" => Kind::Wait,
        "question_resolved" | "steered" => Kind::Resume,
        _ => Kind::Stream,
    }
}

fn is_delta(event_type: &str) -> bool {
    event_type == "text" || event_type == "reasoning"
}

fn approx_size(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len() + 2,
        Value::Array(a) => a.iter().map(approx_size).sum::<usize>() + 2,
        Value::Object(o) => o.iter().map(|(k, v)| k.len() + 3 + approx_size(v)).sum::<usize>() + 2,
        _ => 8,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Hub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(16 * 1024);
        Self { tx, sessions: Arc::default() }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    /// Serialized with `channel` as the first key (serde_json keeps insertion
    /// order, and `channel` is written first), which `?only=` filtering relies on.
    pub fn publish(&self, channel: &str, payload: Value, term_data: bool) {
        let frame: Arc<str> = serde_json::json!({ "channel": channel, "payload": payload }).to_string().into();
        if channel == "agent:event" {
            self.publish_agent(frame, &payload);
        } else {
            let _ = self.tx.send(Event { text: frame, term_data, scope: Scope::Global });
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// An agent event: scoped, numbered, and kept while its turn runs.
    fn publish_agent(&self, text: Arc<str>, payload: &Value) {
        let Some(id) = payload.get("sessionId").and_then(Value::as_str) else {
            let _ = self.tx.send(Event { text, term_data: false, scope: Scope::Global });
            return;
        };
        let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let kind = kind_of(event_type);
        let mut s = self.lock();
        s.seq += 1;
        let seq = s.seq;
        let key: Arc<str> = s.turns.get_key_value(id).map_or_else(|| id.into(), |(k, _)| k.clone());
        let summary = match (kind, s.turns.get(id)) {
            (Kind::Stream, Some(t)) => t.phase == Phase::Waiting || t.last.elapsed() >= QUIET,
            _ => true,
        };
        match kind {
            Kind::End => {
                s.turns.remove(id);
            }
            Kind::Meta => {}
            // A steer or an answer between turns starts nothing.
            Kind::Resume if !s.turns.contains_key(id) => {}
            Kind::Wait | Kind::Resume | Kind::Stream => {
                let turn = s.turns.entry(key.clone()).or_insert_with(|| Turn {
                    phase: Phase::Running,
                    first: None,
                    last: Instant::now(),
                    events: Vec::new(),
                    at: Vec::new(),
                    bytes: 0,
                    truncated: false,
                });
                turn.last = Instant::now();
                if turn.first.is_none() && kind != Kind::Wait {
                    turn.first = Some(text.clone());
                }
                turn.phase = if kind == Kind::Wait { Phase::Waiting } else { Phase::Running };
                append(turn, event_type, payload);
            }
        }
        // Sent under the lock, so a replay taken meanwhile and the live
        // stream agree on which events came before it.
        let _ = self.tx.send(Event { text, term_data: false, scope: Scope::Session { id: key, seq, summary } });
    }

    /// What a socket that starts showing these chats missed of their running
    /// turns: one `agent:replay` frame per chat that has one, with the
    /// sequence number it covers (the socket skips live events up to it).
    pub fn replay(&self, ids: &[Arc<str>]) -> Vec<(Arc<str>, u64, String)> {
        let s = self.lock();
        ids.iter()
            .filter_map(|id| {
                let turn = s.turns.get(id)?;
                let frame = serde_json::json!({
                    "channel": "agent:replay",
                    "payload": { "sessionId": id.as_ref(), "events": turn.events, "at": turn.at, "truncated": turn.truncated },
                });
                Some((id.clone(), s.seq, frame.to_string()))
            })
            .collect()
    }

    /// For a window that just connected: each running turn of a chat it does
    /// not show, as its first event, so it marks the chat running without
    /// that chat's stream. A wait is not resent (it would notify again); the
    /// window reads waits from `chat:pending`, as it always has at start.
    pub fn status(&self, except: &dyn Fn(&str) -> bool) -> Vec<Arc<str>> {
        self.lock().turns.iter().filter(|(id, _)| !except(id)).filter_map(|(_, t)| t.first.clone()).collect()
    }
}

/// Keep an event for replay, joining a delta onto the one before it.
fn append(turn: &mut Turn, event_type: &str, payload: &Value) {
    if is_delta(event_type)
        && let Some(last) = turn.events.last_mut()
        && last.get("type").and_then(Value::as_str) == Some(event_type)
        && let (Some(Value::String(prev)), Some(delta)) =
            (last.get_mut("delta"), payload.get("delta").and_then(Value::as_str))
    {
        prev.push_str(delta);
        turn.bytes += delta.len();
    } else {
        turn.bytes += approx_size(payload);
        turn.events.push(payload.clone());
        turn.at.push(now_ms());
    }
    while turn.bytes > REPLAY_MAX_BYTES && turn.events.len() > 1 {
        let dropped = turn.events.remove(0);
        turn.at.remove(0);
        turn.bytes = turn.bytes.saturating_sub(approx_size(&dropped));
        turn.truncated = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn frames_start_with_the_channel() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        hub.publish("terminal:event", json!({ "zeta": 1, "alpha": 2 }), false);
        let ev = rx.recv().await.unwrap();
        assert!(ev.text.starts_with(r#"{"channel":"terminal:event""#), "{}", ev.text);
        assert!(matches!(ev.scope, Scope::Global));
    }

    fn summaries(hub: &Hub, events: &[Value]) -> Vec<bool> {
        let mut rx = hub.subscribe();
        for e in events {
            hub.publish("agent:event", e.clone(), false);
        }
        events
            .iter()
            .map(|_| match rx.try_recv().unwrap().scope {
                Scope::Session { summary, .. } => summary,
                Scope::Global => panic!("an agent event with a session is scoped"),
            })
            .collect()
    }

    #[test]
    fn a_turns_start_waits_and_end_are_summaries_and_its_stream_is_not() {
        let hub = Hub::new();
        let e = |t: &str| json!({ "type": t, "sessionId": "s1", "delta": "x" });
        let got = summaries(
            &hub,
            &[
                e("session_meta"),
                e("text"),
                e("text"),
                e("tool_call"),
                e("tool_approval_required"),
                e("tool_result"),
                e("text"),
                e("question"),
                e("question_resolved"),
                e("text"),
                e("done"),
                e("session_meta"),
                e("text"),
            ],
        );
        assert_eq!(got, [true, true, false, false, true, true, false, true, true, false, true, true, true]);
    }

    #[test]
    fn replays_a_running_turn_with_deltas_joined_and_forgets_it_at_the_end() {
        let hub = Hub::new();
        let _rx = hub.subscribe();
        for e in [
            json!({ "type": "text", "sessionId": "s1", "delta": "Hel" }),
            json!({ "type": "text", "sessionId": "s1", "delta": "lo" }),
            json!({ "type": "tool_call", "sessionId": "s1", "call": { "id": "c1" } }),
            json!({ "type": "text", "sessionId": "s2", "delta": "other" }),
            json!({ "type": "session_meta", "sessionId": "s1" }),
        ] {
            hub.publish("agent:event", e, false);
        }
        let ids: Vec<Arc<str>> = vec!["s1".into(), "s3".into()];
        let replay = hub.replay(&ids);
        assert_eq!(replay.len(), 1, "only a chat with a running turn replays");
        let (id, seq, frame) = &replay[0];
        assert_eq!((id.as_ref(), *seq), ("s1", 5));
        let v: Value = serde_json::from_str(frame).unwrap();
        assert_eq!(v["channel"], "agent:replay");
        assert_eq!(
            v["payload"]["events"],
            json!([
                { "type": "text", "sessionId": "s1", "delta": "Hello" },
                { "type": "tool_call", "sessionId": "s1", "call": { "id": "c1" } },
            ])
        );
        assert_eq!(v["payload"]["at"].as_array().unwrap().len(), 2);
        hub.publish("agent:event", json!({ "type": "done", "sessionId": "s1" }), false);
        assert!(hub.replay(&ids).is_empty());
    }

    #[test]
    fn status_names_each_running_turn_by_its_first_event() {
        let hub = Hub::new();
        for e in [
            json!({ "type": "text", "sessionId": "s1", "delta": "a" }),
            json!({ "type": "text", "sessionId": "s1", "delta": "b" }),
            json!({ "type": "tool_call", "sessionId": "s2", "call": { "id": "c" } }),
            json!({ "type": "tool_approval_required", "sessionId": "s2", "call": { "id": "c" } }),
            json!({ "type": "text", "sessionId": "s3", "delta": "shown" }),
        ] {
            hub.publish("agent:event", e, false);
        }
        let mut got: Vec<String> = hub.status(&|id| id == "s3").iter().map(|t| t.to_string()).collect();
        got.sort();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got[0].contains(r#""delta":"a""#) && got[1].contains("tool_call"));
    }

    #[test]
    fn a_long_turns_replay_drops_its_oldest_events() {
        let hub = Hub::new();
        let big = "x".repeat(1024 * 1024);
        for i in 0..6 {
            hub.publish(
                "agent:event",
                json!({ "type": "tool_result", "sessionId": "s1", "result": { "toolCallId": i.to_string(), "output": big } }),
                false,
            );
        }
        let (_, _, frame) = hub.replay(&["s1".into()]).pop().unwrap();
        let v: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["payload"]["truncated"], true);
        let kept = v["payload"]["events"].as_array().unwrap();
        assert_eq!(kept.len(), v["payload"]["at"].as_array().unwrap().len());
        assert!(kept.len() < 6 && kept.last().unwrap()["result"]["toolCallId"] == "5");
    }
}
