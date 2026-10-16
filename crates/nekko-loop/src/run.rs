//! `runAgent` (packages/core/src/agent/loop.ts): stream a model response, run
//! any tool calls it asked for, feed the results back, and repeat until it
//! stops calling tools, then report the events a chat draws from. There is no
//! tool-step limit: a reply ends when the model answers, a safeguard (loop
//! detector, runaway stream) trips, a stream fails, or the run is cancelled.
//!
//! The loop is generic over the model client and the tool runner, so it runs
//! against the real providers (`nekko-agent`) and tools (`nekko-tools`) and,
//! in the parity test, against a scripted model that replays the same
//! responses the TS test replays. Events and the transcript it appends are the
//! TS shapes (`AgentEvent`, `ChatMessage`), as JSON.

use crate::fit::{ELIDE_ALL, apply_elision, elidable, elision_for, is_context_overflow};
use crate::history::{as_seen_by_chat_model, from_latest_compaction, latest_compaction_index, window_history};
use crate::progress::{LOOP_WRAP_UP_PROMPT, LoopDetector, loop_note, loop_nudge};
use crate::resume::{INTERRUPTED_NOTE, RESUME_PROMPT, repair_interrupted_history};
use crate::runaway::{RUNAWAY_NOTE, RunawayGuard};
use nekko_js as js;
use serde_json::{Map, Value, json};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// One piece of a streamed model response (`ProviderChunk`).
#[derive(Clone, Debug, PartialEq)]
pub enum Chunk {
    Text(String),
    Phase(String),
    Reasoning(String),
    /// A complete `ToolCall` (`{ id, name, input }`).
    ToolCall(Value),
    Usage {
        input_tokens: f64,
        cache_read_tokens: Option<f64>,
        cache_write_tokens: Option<f64>,
        output_tokens: f64,
        output_ms: Option<f64>,
    },
    Done,
}

/// What the loop asks a model for (`ChatRequest`, minus the callbacks).
#[derive(Clone, Debug, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Value>,
    pub system: String,
    /// Tool specs (`{ name, description, parameters }`); empty offers none.
    pub tools: Vec<Value>,
    pub temperature: Option<f64>,
    pub effort: Option<String>,
    pub think: Option<bool>,
    /// None enables caching; Some(false) explicitly disables request caching.
    pub prompt_caching: Option<bool>,
    pub max_output_tokens: Option<u64>,
}

/// Stop a run. The loop checks between chunks and before each step; a client
/// registers `on_cancel` to stop its request at once, so a stream waiting on
/// a long prompt does not have to deliver another chunk before it notices.
#[derive(Clone, Default)]
pub struct Cancel(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    done: AtomicBool,
    hooks: Mutex<Vec<Box<dyn Fn() + Send + Sync>>>,
    /// Wakes `cancelled()`.
    notify: tokio::sync::Notify,
}

impl Cancel {
    pub fn cancel(&self) {
        if self.0.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooks = std::mem::take(&mut *self.0.hooks.lock().unwrap_or_else(|e| e.into_inner()));
        for hook in hooks {
            hook();
        }
        self.0.notify.notify_waiters();
    }

    /// Resolves once the run is cancelled (at once, if it already was). A
    /// wait between retries selects on this so Stop does not sit out a backoff.
    pub async fn cancelled(&self) {
        let notified = self.0.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.done.load(Ordering::SeqCst)
    }

    /// Run `hook` when the run is cancelled (at once, if it already was).
    pub fn on_cancel(&self, hook: impl Fn() + Send + Sync + 'static) {
        let mut hooks = self.0.hooks.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_cancelled() {
            drop(hooks);
            hook();
        } else {
            hooks.push(Box::new(hook));
        }
    }
}

pub trait ChunkStream: Send {
    /// The next chunk, an error that ends the response, or `None` at its end.
    fn next(&mut self) -> impl Future<Output = Option<Result<Chunk, String>>> + Send;
}

pub trait ModelClient: Sync {
    type Stream: ChunkStream;
    fn chat(&self, req: ChatRequest, cancel: Cancel) -> impl Future<Output = Result<Self::Stream, String>> + Send;
}

pub trait ToolRunner: Sync {
    /// Run one call and return its `ToolResult`; an `Err` becomes an error result.
    fn run(&self, call: &Value) -> impl Future<Output = Result<Value, String>> + Send;
}

pub struct RunOptions<'a> {
    pub session_id: String,
    pub model: String,
    pub system: String,
    /// The transcript so far; the loop appends its messages to it.
    pub history: &'a mut Vec<Value>,
    pub tools: Vec<Value>,
    pub temperature: Option<f64>,
    pub effort: Option<String>,
    pub think: Option<bool>,
    /// None enables caching; Some(false) explicitly disables request caching.
    pub prompt_caching: Option<bool>,
    pub max_history_turns: Option<f64>,
    /// The model's context window in tokens (`contextWindow`): older tool
    /// outputs are elided from what is sent once the prompt nears it (fit.rs).
    pub context_window: Option<f64>,
    pub max_output_tokens: Option<u64>,
    pub resume: bool,
    pub cancel: Cancel,
    /// Messages the user sent while the reply runs (`loop:steer`). Drained at
    /// each tool boundary into the transcript, as `pullSteering` is in TS.
    pub steering: Steering,
}

/// The steering inbox of one run: the host pushes, the loop drains.
pub type Steering = Arc<Mutex<Vec<Value>>>;

/// How much of a looping stream is kept (`RUNAWAY_KEEP_CHARS`, UTF-16 units).
const RUNAWAY_KEEP_CHARS: usize = 4_000;

const EMPTY_NUDGE: &str = "Please continue and give your answer.";
const STALLED: &str =
    "_The model returned an empty response and stopped. It may have run out of steam: try again, or rephrase._";

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
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

/// `id(prefix)`: `<prefix>_<time base36>_<counter>`.
fn id(prefix: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{prefix}_{}_{n}", base36(now_ms()))
}

/// A JavaScript number as JSON: whole numbers as integers.
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

fn trim_runaway(s: &str) -> String {
    if js::len16(s) <= RUNAWAY_KEEP_CHARS {
        s.to_string()
    } else {
        format!("{}\n\n[…cut off here: the model started repeating itself.]", js::slice16(s, RUNAWAY_KEEP_CHARS))
    }
}

/// Attempts a model call gets before the reply ends as interrupted
/// (`MAX_STREAM_ATTEMPTS` in providers/errors.ts).
pub const MAX_STREAM_ATTEMPTS: u32 = 5;

/// Statuses a second attempt usually gets past; 529 is Anthropic's "overloaded".
const TRANSIENT_STATUSES: &[u16] = &[408, 409, 425, 429, 500, 502, 503, 504, 529];

/// Whether a model-call failure is worth sending again
/// (`isTransientProviderError`). Provider errors arrive here as text, so the
/// status is read out of it ("anthropic 529: ..."), and the ways a connection
/// dies underneath a request are matched by their wording.
pub fn is_transient_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    if lower.contains("abort") {
        return false;
    }
    let mut digits = String::new();
    for ch in message.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        if digits.len() == 3
            && let Ok(status) = digits.parse::<u16>()
            && TRANSIENT_STATUSES.contains(&status)
        {
            return true;
        }
        digits.clear();
    }
    [
        "overloaded",
        "rate limit",
        "rate_limit",
        "ratelimit",
        "too many requests",
        "temporarily",
        "try again",
        "connection reset",
        "connection refused",
        "connection closed",
        "econnreset",
        "econnrefused",
        "etimedout",
        "epipe",
        "eai_again",
        "socket hang up",
        "premature close",
        "stream ended unexpectedly",
        "timed out",
        "timeout",
        "broken pipe",
        "fetch failed",
        "terminated",
        "network error",
        "error sending request",
        "error decoding response body",
        "stopped sending",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// How long to wait before attempt `attempt` (1-based): 1 s doubling to a
/// 30 s cap, plus up to a second of jitter so parallel chats spread out
/// (`retryDelayMs`).
pub fn retry_delay(attempt: u32) -> Duration {
    let base = (1_000u64 << attempt.saturating_sub(1).min(5)).min(30_000);
    let jitter = (now_ms() % 1_000).min(base);
    Duration::from_millis(base + jitter)
}

/// What one streamed response accumulated (`Turn`).
#[derive(Default)]
struct Turn {
    phase: Option<String>,
    text: String,
    reasoning: String,
    reasoning_seconds: Option<u64>,
    calls: Vec<Value>,
    runaway: bool,
}

impl Turn {
    fn is_empty(&self) -> bool {
        js::trim(&self.text).is_empty() && js::trim(&self.reasoning).is_empty() && self.calls.is_empty()
    }
}

fn user_nudge(content: &str) -> Value {
    json!({ "id": id("nudge"), "role": "user", "content": content, "createdAt": now_ms() })
}

/// `{ reasoning, reasoningSeconds }` when there is reasoning (an absent
/// duration stays absent, as `undefined` does in JSON).
fn put_reasoning(m: &mut Map<String, Value>, reasoning: String, seconds: Option<u64>) {
    m.insert("reasoning".into(), json!(reasoning));
    if let Some(s) = seconds {
        m.insert("reasoningSeconds".into(), json!(s));
    }
}

struct Loop<'o, 'a, C, T, E> {
    opts: &'o mut RunOptions<'a>,
    client: &'o C,
    tools: &'o T,
    emit: &'o mut E,
    /// Oldest bulky tool outputs this run elides from what it sends (`elided`).
    elided: usize,
    /// A context-overflow error has had its one squeeze retry (`squeezed`).
    squeezed: bool,
    /// Elidable tool outputs in the last request (`sentEligible`).
    sent_eligible: usize,
}

impl<C: ModelClient, T: ToolRunner, E: FnMut(Value, &[Value]) + Send> Loop<'_, '_, C, T, E> {
    fn event(&mut self, kind: &str, fields: Value) {
        let mut e = Map::new();
        e.insert("type".into(), json!(kind));
        e.insert("sessionId".into(), json!(self.opts.session_id));
        if let Value::Object(f) = fields {
            e.extend(f);
        }
        (self.emit)(Value::Object(e), self.opts.history);
    }

    /// `stream`: one response into `turn`. `extra` is sent but never kept.
    async fn stream(&mut self, turn: &mut Turn, extra: Vec<Value>, send_tools: bool) -> Result<(), String> {
        let mut reasoning_started: Option<Instant> = None;
        let mut text_guard = RunawayGuard::default();
        let mut reasoning_guard = RunawayGuard::default();
        // Only a compacted transcript is copied; most are sent as they are.
        let compacted = latest_compaction_index(self.opts.history).map(|_| from_latest_compaction(self.opts.history));
        let sent: &[Value] = compacted.as_deref().unwrap_or(self.opts.history);
        let mut messages: Vec<Value> =
            window_history(sent, self.opts.max_history_turns).iter().map(as_seen_by_chat_model).collect();
        messages.extend(extra);
        let tools = if send_tools { self.opts.tools.clone() } else { Vec::new() };
        self.elided = elision_for(&self.opts.system, &tools, &messages, self.opts.context_window, self.elided);
        self.sent_eligible = elidable(&messages).len();
        let messages = apply_elision(messages, self.elided);
        let req = ChatRequest {
            model: self.opts.model.clone(),
            messages,
            system: self.opts.system.clone(),
            tools,
            temperature: self.opts.temperature,
            effort: self.opts.effort.clone(),
            think: self.opts.think,
            prompt_caching: Some(self.opts.prompt_caching.unwrap_or(true)),
            max_output_tokens: self.opts.max_output_tokens,
        };
        let settle = |turn: &mut Turn, started: Option<Instant>| {
            if let Some(t) = started
                && turn.reasoning_seconds.is_none()
            {
                turn.reasoning_seconds = Some((t.elapsed().as_millis() as f64 / 1000.0).round() as u64);
            }
        };
        let mut stream = self.client.chat(req, self.opts.cancel.clone()).await?;
        loop {
            let Some(item) = stream.next().await else { break };
            let chunk = match item {
                Ok(c) => c,
                // A stream cut off for looping is not a failure to report.
                Err(_) if turn.runaway => break,
                Err(e) => return Err(e),
            };
            match chunk {
                Chunk::Phase(phase) => turn.phase = Some(phase),
                Chunk::Text(delta) => {
                    settle(turn, reasoning_started);
                    turn.text.push_str(&delta);
                    let tripped = text_guard.push(&delta);
                    self.event("text", json!({ "delta": delta }));
                    turn.runaway |= tripped;
                }
                Chunk::Reasoning(delta) => {
                    reasoning_started.get_or_insert_with(Instant::now);
                    turn.reasoning.push_str(&delta);
                    let tripped = reasoning_guard.push(&delta);
                    self.event("reasoning", json!({ "delta": delta }));
                    turn.runaway |= tripped;
                }
                Chunk::ToolCall(call) => {
                    settle(turn, reasoning_started);
                    turn.calls.push(call.clone());
                    self.event("tool_call", json!({ "call": call }));
                }
                Chunk::Usage { input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, output_ms } => {
                    let mut f = json!({ "inputTokens": num(input_tokens), "outputTokens": num(output_tokens) });
                    if let Some(tokens) = cache_read_tokens {
                        f["cacheReadTokens"] = num(tokens);
                    }
                    if let Some(tokens) = cache_write_tokens {
                        f["cacheWriteTokens"] = num(tokens);
                    }
                    if let Some(ms) = output_ms {
                        f["outputMs"] = num(ms);
                    }
                    self.event("usage", f);
                }
                Chunk::Done => {}
            }
            // Cut a degenerate stream off rather than waiting out the output cap;
            // dropping the stream closes the request.
            if turn.runaway {
                break;
            }
            if self.opts.cancel.is_cancelled() {
                return Err("This operation was aborted".into());
            }
        }
        settle(turn, reasoning_started);
        Ok(())
    }

    /// `streamWithRetry`: one model call, sent again after a transient failure
    /// (an overloaded provider, a stream that went quiet, a dropped connection).
    /// Each attempt starts `turn` over from where it stood before the call, and
    /// a `retry` event tells the UI to drop what the failed attempt showed.
    async fn stream_with_retry(&mut self, turn: &mut Turn, extra: Vec<Value>, send_tools: bool) -> Result<(), String> {
        let mut attempt: u32 = 1;
        loop {
            let before = Turn {
                phase: turn.phase.clone(),
                text: turn.text.clone(),
                reasoning: turn.reasoning.clone(),
                reasoning_seconds: turn.reasoning_seconds,
                calls: turn.calls.clone(),
                runaway: turn.runaway,
            };
            match self.stream(turn, extra.clone(), send_tools).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    // The prompt no longer fits: send it once more with every
                    // older tool output elided before giving up on the reply.
                    if !self.opts.cancel.is_cancelled()
                        && !self.squeezed
                        && is_context_overflow(&e)
                        && self.elided < self.sent_eligible
                    {
                        self.squeezed = true;
                        self.elided = ELIDE_ALL;
                        *turn = before;
                        self.event(
                            "retry",
                            json!({
                                "attempt": attempt,
                                "maxAttempts": MAX_STREAM_ATTEMPTS,
                                "delayMs": 0,
                                "reason": "The conversation no longer fits the context window: retrying with older tool output left out",
                            }),
                        );
                        attempt = 1;
                        continue;
                    }
                    if self.opts.cancel.is_cancelled() || attempt >= MAX_STREAM_ATTEMPTS || !is_transient_error(&e) {
                        return Err(e);
                    }
                    *turn = before;
                    let delay = retry_delay(attempt);
                    self.event(
                        "retry",
                        json!({
                            "attempt": attempt,
                            "maxAttempts": MAX_STREAM_ATTEMPTS,
                            "delayMs": delay.as_millis() as u64,
                            "reason": e,
                        }),
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = self.opts.cancel.cancelled() => return Err(e),
                    }
                    attempt += 1;
                }
            }
        }
    }

    /// `endInterrupted`: keep what the broken reply produced, and say so.
    fn end_interrupted(&mut self, turn: &Turn, error: String) {
        let partial = js::trim(&if turn.runaway { trim_runaway(&turn.text) } else { turn.text.clone() }).to_string();
        let reasoning = js::trim(&turn.reasoning).to_string();
        if !partial.is_empty() || !reasoning.is_empty() {
            let content = [partial.as_str(), INTERRUPTED_NOTE]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut m = Map::new();
            m.insert("id".into(), json!(id("msg")));
            m.insert("role".into(), json!("assistant"));
            if let Some(phase) = &turn.phase {
                m.insert("phase".into(), json!(phase));
            }
            m.insert("content".into(), json!(content));
            if !reasoning.is_empty() {
                put_reasoning(&mut m, reasoning, turn.reasoning_seconds);
            }
            m.insert("interrupted".into(), json!(true));
            m.insert("createdAt".into(), json!(now_ms()));
            self.opts.history.push(Value::Object(m));
        }
        // A stop the user asked for is not a failure, and doesn't read as one.
        let message = if self.opts.cancel.is_cancelled() { "Stopped".to_string() } else { error };
        self.event("error", json!({ "message": message }));
    }

    async fn run(&mut self) {
        let mut resume_extra = Vec::new();
        // A normal follow-up after Stop needs the same valid history as Resume.
        repair_interrupted_history(self.opts.history);
        if self.opts.resume
            && self.opts.history.last().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant")
        {
            resume_extra.push(user_nudge(RESUME_PROMPT));
        }
        let nudge = user_nudge(EMPTY_NUDGE);
        // Loop detection (progress.rs): the first trip nudges, the second wraps up.
        let mut loops = LoopDetector::default();
        let mut loop_extra: Vec<Value> = Vec::new();
        let mut nudged = false;
        let mut steps: usize = 0;
        let mut first_pass = true;

        let loop_reason = loop {
            if self.opts.cancel.is_cancelled() {
                self.event("error", json!({ "message": "Aborted" }));
                return;
            }
            let mut turn = Turn::default();
            let first_call = std::mem::take(&mut first_pass);
            if !first_call {
                // Steering joins the transcript at the step boundary (never
                // mid-stream), so the next call sees it without a restart.
                let steered: Vec<Value> =
                    std::mem::take(&mut *self.opts.steering.lock().unwrap_or_else(|e| e.into_inner()));
                for m in steered {
                    let message_id = m.get("id").cloned().unwrap_or(Value::Null);
                    self.opts.history.push(m);
                    self.event("steered", json!({ "messageId": message_id }));
                }
            }
            let first = if first_call { std::mem::take(&mut resume_extra) } else { std::mem::take(&mut loop_extra) };
            let mut result = self.stream_with_retry(&mut turn, first, true).await;
            // An empty response gets one retry with a nudge, so the turn does not
            // silently stall (common with some local models mid-loop).
            if result.is_ok() && turn.is_empty() && !self.opts.cancel.is_cancelled() {
                result = self.stream_with_retry(&mut turn, vec![nudge.clone()], true).await;
            }
            if let Err(e) = result {
                self.end_interrupted(&turn, e);
                return;
            }

            let stalled = turn.is_empty();
            let mut m = Map::new();
            m.insert("id".into(), json!(id("msg")));
            m.insert("role".into(), json!("assistant"));
            if let Some(phase) = &turn.phase {
                m.insert("phase".into(), json!(phase));
            }
            if turn.runaway {
                let content = [js::trim(&trim_runaway(&turn.text)), RUNAWAY_NOTE]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .copied()
                    .collect::<Vec<_>>()
                    .join("\n\n");
                m.insert("content".into(), json!(content));
                if !turn.reasoning.is_empty() {
                    put_reasoning(&mut m, trim_runaway(&turn.reasoning), turn.reasoning_seconds);
                }
            } else {
                m.insert("content".into(), json!(if stalled { STALLED.to_string() } else { turn.text.clone() }));
                if !turn.reasoning.is_empty() {
                    put_reasoning(&mut m, turn.reasoning.clone(), turn.reasoning_seconds);
                }
                if !turn.calls.is_empty() {
                    m.insert("toolCalls".into(), Value::Array(turn.calls.clone()));
                }
            }
            m.insert("createdAt".into(), json!(now_ms()));
            let message_id = m["id"].clone();
            self.opts.history.push(Value::Object(m));

            // A looping model does not recover by being asked again; and no tool
            // calls means the turn is complete.
            if turn.runaway || (turn.calls.is_empty() && turn.phase.as_deref() != Some("commentary")) {
                let stop = if turn.runaway { "runaway" } else { "complete" };
                self.event("done", json!({ "messageId": message_id, "stop": stop, "steps": steps }));
                return;
            }

            if !turn.calls.is_empty() {
                steps += 1;
            }
            // The request for these tools is in the transcript now; the host
            // saves it here, so a tool that never returns still leaves the step.
            self.event("step", json!({ "messageId": message_id }));
            let mut tripped: Option<String> = None;
            for call in &turn.calls {
                let result = match self.tools.run(call).await {
                    Ok(r) => r,
                    Err(e) => {
                        json!({ "toolCallId": call.get("id").cloned().unwrap_or(Value::Null), "output": format!("Error: {e}"), "isError": true })
                    }
                };
                self.opts.history.push(json!({ "id": id("msg"), "role": "tool", "content": "", "toolResult": result, "createdAt": now_ms() }));
                self.event("tool_result", json!({ "result": result }));
                if tripped.is_none() {
                    tripped = loops.push(call, &result);
                }
            }

            if let Some(reason) = tripped {
                if nudged {
                    break reason;
                }
                nudged = true;
                loops.reset();
                loop_extra = vec![user_nudge(&loop_nudge(&reason))];
            }
        };

        // The loop detector tripped twice: one last pass with the tools
        // withheld, so the work comes back as an answer rather than an error.
        if self.opts.cancel.is_cancelled() {
            self.event("error", json!({ "message": "Aborted" }));
            return;
        }
        let mut wrap = Turn::default();
        if let Err(e) = self.stream_with_retry(&mut wrap, vec![user_nudge(LOOP_WRAP_UP_PROMPT)], false).await {
            self.end_interrupted(&wrap, e);
            return;
        }
        let note = if wrap.runaway { RUNAWAY_NOTE.to_string() } else { loop_note(&loop_reason) };
        let wrap_text = js::trim(&if wrap.runaway { trim_runaway(&wrap.text) } else { wrap.text.clone() }).to_string();
        let mut m = Map::new();
        m.insert("id".into(), json!(id("msg")));
        m.insert("role".into(), json!("assistant"));
        if let Some(phase) = &wrap.phase {
            m.insert("phase".into(), json!(phase));
        }
        m.insert("content".into(), json!(if wrap_text.is_empty() { note } else { format!("{wrap_text}\n\n{note}") }));
        if !wrap.reasoning.is_empty() {
            let r = if wrap.runaway { trim_runaway(&wrap.reasoning) } else { wrap.reasoning.clone() };
            put_reasoning(&mut m, r, wrap.reasoning_seconds);
        }
        m.insert("createdAt".into(), json!(now_ms()));
        let message_id = m["id"].clone();
        self.opts.history.push(Value::Object(m));
        self.event("done", json!({ "messageId": message_id, "stop": "loop", "steps": steps }));
    }
}

/// Run the agent loop to the end of one reply, calling `emit` with each
/// `AgentEvent` as it happens and the transcript as it stands at that moment
/// (a host checkpoints it on `tool_result`, `done` and `error`).
pub async fn run_agent<C: ModelClient, T: ToolRunner, E: FnMut(Value, &[Value]) + Send>(
    mut opts: RunOptions<'_>,
    client: &C,
    tools: &T,
    emit: &mut E,
) {
    Loop { opts: &mut opts, client, tools, emit, elided: 0, squeezed: false, sent_eligible: 0 }.run().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn cancel_runs_each_hook_once_even_when_registered_late() {
        let c = Cancel::default();
        let n = Arc::new(AtomicUsize::new(0));
        let n1 = n.clone();
        c.on_cancel(move || {
            n1.fetch_add(1, Ordering::SeqCst);
        });
        c.cancel();
        c.cancel();
        assert_eq!(n.load(Ordering::SeqCst), 1);
        let n2 = n.clone();
        c.on_cancel(move || {
            n2.fetch_add(10, Ordering::SeqCst);
        });
        assert_eq!(n.load(Ordering::SeqCst), 11);
        assert!(c.is_cancelled());
    }
}
