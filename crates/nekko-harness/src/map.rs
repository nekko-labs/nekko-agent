//! Claude Code's stream-json, line by line, as Nekko's agent events
//! (`AgentEvent`, packages/shared/src/chat.ts) and transcript messages
//! (`ChatMessage`), so a Claude Agent chat streams, stores, searches and
//! syncs like any other.
//!
//! | Claude Code | Nekko |
//! |---|---|
//! | `system/init` | [`Mapped::Init`] (session id, model, MCP servers) |
//! | `stream_event` `text_delta` / `thinking_delta` | `text` / `reasoning` |
//! | `assistant` text or thinking not streamed as deltas | `text` / `reasoning` |
//! | `assistant` `tool_use` | `tool_call` (`executedBy: claude-code`) |
//! | the step's last block, before its tool results | assistant message, `step` |
//! | `user` `tool_result` | tool message, `tool_result` |
//! | `parent_tool_use_id` set (a sub-agent) | `tool_call` / `tool_result` with `parentToolCallId`, no transcript |
//! | `system/api_retry` | `retry` |
//! | `system/permission_denied` | the call's `tool_result` marked `denied` |
//! | `assistant` with `is_api_error_message` | `error` |
//! | `command_lifecycle` (a message Nekko wrote, queued / started / completed), its `isReplay` echo | [`Mapped::Command`] |
//! | `result` | [`Mapped::End`]; then [`Mapper::finish`] gives `usage` + `done`, or `error` |
//! | main-thread `assistant` `message.usage`, `result.modelUsage[model].contextWindow` | [`TurnEnd::context`] (what the context gauge shows) |
//! | `result` `terminal_reason: aborted_*` | an interrupted turn, not a failure |
//!
//! With `--include-partial-messages` text arrives twice: as deltas, then as
//! the complete `assistant` block. A message whose deltas were seen is not
//! sent again; one that never streamed (an older CLI, a resumed turn) is sent
//! whole.

use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

/// The message a user's Stop ends the turn with, as Nekko's own loop does.
pub const USER_STOPPED: &str = "Stopped";

/// What Claude Code says when it has no sign-in, reworded for Nekko.
const SIGNED_OUT: &str = "Claude Code is not signed in. Open a terminal, run `claude` and sign in with /login, then send your message again.";

static COUNTER: AtomicU64 = AtomicU64::new(0);

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

/// `msg_<time base36>_<counter>`, the shape Nekko's loop gives its messages.
fn new_id() -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    format!("msg_{}_h{n}", base36(nekko_js::now_ms()))
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// One mapped piece of the stream, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Mapped {
    /// An `AgentEvent`, `sessionId` filled in.
    Event(Value),
    /// A finished transcript message (`ChatMessage`): an assistant step, a
    /// tool result, or a steering message. Append it before the events that
    /// follow it, which may checkpoint the transcript.
    Message(Value),
    /// `system/init`: Claude Code's session, at the start of each of its turns.
    Init(Init),
    /// The answer to a control request Nekko sent.
    ControlResponse { request_id: String, error: Option<String> },
    /// A control request from Claude Code. Nekko asks for none, so it is declined.
    ControlRequest { request_id: String, subtype: String },
    /// Where a message Nekko wrote stands (`queued`, `started`, `completed`),
    /// by the `uuid` it was written with.
    Command { uuid: String, state: String },
    /// `result`: Claude Code's turn is over.
    End(TurnEnd),
    /// A stdout line that was not JSON (kept for an exit's diagnostics).
    Unparsed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Init {
    pub session_id: String,
    pub model: Option<String>,
    /// `(name, status)` of every MCP server, `connected` when it is up.
    pub mcp_servers: Vec<(String, String)>,
    pub version: Option<String>,
    /// How Claude Code is authenticated for this run (`ANTHROPIC_API_KEY`, `none`, ...).
    pub api_key_source: Option<String>,
}

impl Init {
    /// Whether the named MCP server connected.
    pub fn connected(&self, server: &str) -> bool {
        self.mcp_servers.iter().any(|(n, s)| n == server && s == "connected")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Completed,
    /// An interrupt (`terminal_reason: aborted_streaming` or `aborted_tools`).
    Interrupted,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnd {
    pub outcome: Outcome,
    pub session_id: Option<String>,
    /// Claude Code's own estimate. Shown only for non-plan auth (policy, H5).
    pub cost_usd: Option<f64>,
    pub num_turns: Option<u64>,
    /// The turn's tokens, as a `usage` event's fields (no `type`/`sessionId`).
    pub usage: Option<Value>,
    pub terminal_reason: Option<String>,
    /// How full Claude Code's context is, as it reports it. Never summed
    /// into `usage`, which stays the turn's total over every call.
    pub context: Option<ReportedContext>,
}

/// Claude Code's context occupancy against its window, from its own figures.
///
/// `used` is the input side of the last main-thread model call: the sum of
/// `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`
/// in its `assistant` event. That is everything the call sent, Claude Code's
/// system prompt and tools included, and it drops on its own once Claude Code
/// compacts.
/// `result.usage` cannot stand in for it: it sums every call of the turn, and
/// its `iterations` holds only one of them (the recorded two-call turn in
/// `permission-denied.jsonl` lists just the last). A sub-agent's calls
/// (`parent_tool_use_id` set) run in their own context and are left out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReportedContext {
    pub used: Option<u64>,
    /// `result.modelUsage[<the init model>].contextWindow`.
    pub window: Option<u64>,
}

/// Why an interrupt was sent: a Stop ends the Nekko turn and marks the reply
/// cut off; a Steer only makes room for the next message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopKind {
    User,
    Steer,
}

/// The assistant step being assembled from Claude Code's per-block messages.
#[derive(Default)]
struct Draft {
    claude_id: String,
    id: String,
    text: String,
    reasoning: String,
    calls: Vec<Value>,
    created_at: u64,
}

impl Draft {
    fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.reasoning.trim().is_empty() && self.calls.is_empty()
    }
}

/// The stream-json mapper for one Nekko turn (which may span several Claude
/// Code turns when the user steers).
pub struct Mapper {
    session_id: String,
    /// Claude message ids whose text arrived as deltas.
    streamed: HashSet<String>,
    /// The top-level message the deltas belong to (`message_start`).
    streaming: Option<String>,
    draft: Option<Draft>,
    /// Tool calls Claude Code denied itself, with its reason.
    denied: HashMap<String, String>,
    steps: usize,
    last_message_id: Option<String>,
    /// An `error` event was sent for this turn already.
    error_sent: bool,
    stopping: Option<StopKind>,
    /// `system/init`'s model, the key of its `result.modelUsage` entry.
    model: Option<String>,
    /// The latest reported context, kept across the Claude Code turns a
    /// steered Nekko turn spans.
    context: ReportedContext,
}

/// A user message's content for stream-json: its text, and its images as
/// base64 blocks (`data:` URLs only).
pub fn user_content(message: &Value) -> Value {
    let mut blocks = Vec::new();
    for url in message.get("images").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let Some(rest) = url.strip_prefix("data:") else { continue };
        let Some((meta, data)) = rest.split_once(',') else { continue };
        let Some(media) = meta.strip_suffix(";base64") else { continue };
        blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": data } }));
    }
    let text = match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    };
    if blocks.is_empty() {
        return json!(text);
    }
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    Value::Array(blocks)
}

/// A tool result's content as the text Nekko shows: a string as it is, text
/// blocks joined, anything else as JSON.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match (str_at(b, "type"), str_at(b, "text")) {
                (Some("text"), Some(t)) => t.to_string(),
                _ => b.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

fn num(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).unwrap_or(0)
}

/// The tokens one model call sent, from its `message.usage`; `None` when it
/// reports nothing.
fn occupancy(usage: Option<&Value>) -> Option<u64> {
    let u = usage?;
    let sent =
        num(u.get("input_tokens")) + num(u.get("cache_read_input_tokens")) + num(u.get("cache_creation_input_tokens"));
    (sent > 0).then_some(sent)
}

impl Mapper {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            streamed: HashSet::new(),
            streaming: None,
            draft: None,
            denied: HashMap::new(),
            steps: 0,
            last_message_id: None,
            error_sent: false,
            stopping: None,
            model: None,
            context: ReportedContext::default(),
        }
    }

    /// What Claude Code last reported about its context this Nekko turn, if
    /// anything.
    pub fn context(&self) -> Option<ReportedContext> {
        (self.context != ReportedContext::default()).then_some(self.context)
    }

    /// Tool round trips so far.
    pub fn steps(&self) -> usize {
        self.steps
    }

    /// An interrupt is on its way: the `result` it brings is read as `kind`.
    pub fn expect_stop(&mut self, kind: StopKind) {
        self.stopping = Some(kind);
    }

    pub(crate) fn event(&self, kind: &str, fields: Value) -> Mapped {
        let mut e = Map::new();
        e.insert("type".into(), json!(kind));
        e.insert("sessionId".into(), json!(self.session_id));
        if let Value::Object(f) = fields {
            e.extend(f);
        }
        Mapped::Event(Value::Object(e))
    }

    fn error(&mut self, message: &str) -> Mapped {
        self.error_sent = true;
        self.event("error", json!({ "message": message }))
    }

    /// One stdout line.
    pub fn map_line(&mut self, line: &str) -> Vec<Mapped> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(v) => self.map(&v),
            Err(_) => vec![Mapped::Unparsed(line.to_string())],
        }
    }

    /// One parsed stream-json event.
    pub fn map(&mut self, v: &Value) -> Vec<Mapped> {
        let mut out = Vec::new();
        let parent = str_at(v, "parent_tool_use_id").map(str::to_string);
        match str_at(v, "type") {
            Some("system") => self.system(v, &mut out),
            Some("stream_event") if parent.is_none() => {
                self.stream_event(v.get("event").unwrap_or(&Value::Null), &mut out)
            }
            Some("assistant") => self.assistant(v, parent, &mut out),
            // A message Nekko wrote, echoed as Claude Code takes it up.
            Some("user") if v.get("isReplay") == Some(&Value::Bool(true)) => out
                .push(Mapped::Command { uuid: str_at(v, "uuid").unwrap_or_default().into(), state: "started".into() }),
            Some("user") => self.user(v, parent, &mut out),
            Some("control_response") => {
                let r = v.get("response").unwrap_or(&Value::Null);
                let error = (str_at(r, "subtype") != Some("success"))
                    .then(|| str_at(r, "error").unwrap_or("The control request failed.").to_string());
                out.push(Mapped::ControlResponse {
                    request_id: str_at(r, "request_id").unwrap_or_default().into(),
                    error,
                });
            }
            Some("control_request") => out.push(Mapped::ControlRequest {
                request_id: str_at(v, "request_id").unwrap_or_default().into(),
                subtype: v.pointer("/request/subtype").and_then(Value::as_str).unwrap_or_default().into(),
            }),
            Some("command_lifecycle") => out.push(Mapped::Command {
                uuid: str_at(v, "command_uuid").unwrap_or_default().into(),
                state: str_at(v, "state").unwrap_or_default().into(),
            }),
            Some("result") => self.result(v, &mut out),
            _ => {}
        }
        out
    }

    fn system(&mut self, v: &Value, out: &mut Vec<Mapped>) {
        match str_at(v, "subtype") {
            Some("init") => {
                self.streaming = None;
                if let Some(model) = str_at(v, "model") {
                    self.model = Some(model.to_string());
                }
                let mcp_servers = v
                    .get("mcp_servers")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|s| {
                                (
                                    str_at(s, "name").unwrap_or_default().into(),
                                    str_at(s, "status").unwrap_or_default().into(),
                                )
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(Mapped::Init(Init {
                    session_id: str_at(v, "session_id").unwrap_or_default().into(),
                    model: str_at(v, "model").map(str::to_string),
                    mcp_servers,
                    version: str_at(v, "claude_code_version").map(str::to_string),
                    api_key_source: str_at(v, "apiKeySource").map(str::to_string),
                }));
            }
            Some("api_retry") => {
                // Whatever the failed call streamed is discarded and redone.
                self.draft = None;
                self.streaming = None;
                let reason = v
                    .get("error")
                    .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_string))
                    .or_else(|| v.get("error_status").map(|s| format!("HTTP {s}")))
                    .unwrap_or_else(|| "The request failed".into());
                out.push(self.event(
                    "retry",
                    json!({
                        "attempt": num(v.get("attempt")),
                        "maxAttempts": num(v.get("max_retries")),
                        "delayMs": num(v.get("retry_delay_ms")),
                        "reason": reason,
                    }),
                ));
            }
            Some("permission_denied") => {
                let id = str_at(v, "tool_use_id").unwrap_or_default().to_string();
                let reason = str_at(v, "decision_reason").or_else(|| str_at(v, "message")).unwrap_or("Denied");
                self.denied.insert(id, reason.to_string());
            }
            _ => {}
        }
    }

    fn stream_event(&mut self, e: &Value, out: &mut Vec<Mapped>) {
        match str_at(e, "type") {
            Some("message_start") => {
                self.streaming = e.pointer("/message/id").and_then(Value::as_str).map(str::to_string);
            }
            Some("content_block_delta") => {
                let Some(id) = self.streaming.clone() else { return };
                let delta = e.get("delta").unwrap_or(&Value::Null);
                let (kind, text) = match str_at(delta, "type") {
                    Some("text_delta") => ("text", str_at(delta, "text")),
                    Some("thinking_delta") => ("reasoning", str_at(delta, "thinking")),
                    _ => return,
                };
                let Some(text) = text.filter(|t| !t.is_empty()) else { return };
                self.streamed.insert(id.clone());
                let draft = self.draft_for(&id, out);
                if kind == "text" {
                    draft.text.push_str(text)
                } else {
                    draft.reasoning.push_str(text)
                }
                out.push(self.event(kind, json!({ "delta": text })));
            }
            _ => {}
        }
    }

    /// The draft for this Claude message, closing the one before it.
    fn draft_for(&mut self, claude_id: &str, out: &mut Vec<Mapped>) -> &mut Draft {
        if self.draft.as_ref().is_some_and(|d| d.claude_id != claude_id) {
            self.flush_into(false, false, out);
        }
        self.draft.get_or_insert_with(|| Draft {
            claude_id: claude_id.to_string(),
            id: new_id(),
            created_at: nekko_js::now_ms(),
            ..Default::default()
        })
    }

    fn assistant(&mut self, v: &Value, parent: Option<String>, out: &mut Vec<Mapped>) {
        let message = v.get("message").unwrap_or(&Value::Null);
        let blocks = message.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
        if v.get("is_api_error_message") == Some(&Value::Bool(true)) {
            let text = blocks.iter().filter_map(|b| str_at(b, "text")).collect::<Vec<_>>().join("\n");
            let message = if str_at(v, "error") == Some("authentication_failed") {
                SIGNED_OUT.to_string()
            } else if text.trim().is_empty() {
                "Claude Code's request failed.".to_string()
            } else {
                text
            };
            out.push(self.error(&message));
            return;
        }
        if parent.is_none()
            && let Some(used) = occupancy(message.get("usage"))
        {
            self.context.used = Some(used);
        }
        if let Some(parent) = parent {
            // A sub-agent's steps: shown under the call that started it, never
            // in the chat's own transcript (Claude Code keeps that history).
            for b in blocks.iter().filter(|b| str_at(b, "type") == Some("tool_use")) {
                let mut call = tool_call(b);
                call["parentToolCallId"] = json!(parent);
                out.push(self.event("tool_call", json!({ "call": call })));
            }
            return;
        }
        let claude_id = str_at(message, "id").unwrap_or_default().to_string();
        let streamed = self.streamed.contains(&claude_id);
        for b in &blocks {
            match str_at(b, "type") {
                Some("text") if !streamed => {
                    let text = str_at(b, "text").unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    self.draft_for(&claude_id, out).text.push_str(text);
                    out.push(self.event("text", json!({ "delta": text })));
                }
                Some("thinking") if !streamed => {
                    let text = str_at(b, "thinking").unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    self.draft_for(&claude_id, out).reasoning.push_str(text);
                    out.push(self.event("reasoning", json!({ "delta": text })));
                }
                Some("tool_use") => {
                    let call = tool_call(b);
                    self.draft_for(&claude_id, out).calls.push(call.clone());
                    out.push(self.event("tool_call", json!({ "call": call })));
                }
                _ => {}
            }
        }
    }

    fn user(&mut self, v: &Value, parent: Option<String>, out: &mut Vec<Mapped>) {
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else { return };
        for b in blocks.iter().filter(|b| str_at(b, "type") == Some("tool_result")) {
            let id = str_at(b, "tool_use_id").unwrap_or_default().to_string();
            let mut result = json!({ "toolCallId": id, "output": result_text(b.get("content")) });
            if b.get("is_error") == Some(&Value::Bool(true)) {
                result["isError"] = json!(true);
            }
            if let Some(reason) = self.denied.remove(&id) {
                result["denied"] = json!(true);
                result["deniedReason"] = json!(reason);
            }
            if let Some(parent) = &parent {
                result["parentToolCallId"] = json!(parent);
                out.push(self.event("tool_result", json!({ "result": result })));
                continue;
            }
            // The step that asked for this tool is complete: save it first.
            self.flush_into(false, false, out);
            out.push(Mapped::Message(json!({
                "id": new_id(),
                "role": "tool",
                "content": "",
                "toolResult": result,
                "createdAt": nekko_js::now_ms(),
            })));
            out.push(self.event("tool_result", json!({ "result": result })));
        }
    }

    fn result(&mut self, v: &Value, out: &mut Vec<Mapped>) {
        let reason = str_at(v, "terminal_reason").map(str::to_string);
        let aborted = reason.as_deref().is_some_and(|r| r.starts_with("aborted"));
        let stop = self.stopping.take();
        let outcome = if aborted {
            Outcome::Interrupted
        } else if v.get("is_error") == Some(&Value::Bool(true)) {
            let errors = v.get("errors").and_then(Value::as_array).map(|a| {
                a.iter().filter_map(Value::as_str).filter(|e| !e.starts_with("[ede_diagnostic]")).collect::<Vec<_>>()
            });
            let message = str_at(v, "result")
                .filter(|r| !r.trim().is_empty())
                .map(str::to_string)
                .or_else(|| errors.filter(|e| !e.is_empty()).map(|e| e.join("\n")))
                .unwrap_or_else(|| {
                    format!("Claude Code ended the turn with an error ({}).", reason.as_deref().unwrap_or("unknown"))
                });
            Outcome::Failed(message)
        } else {
            Outcome::Completed
        };
        let interrupted = outcome == Outcome::Interrupted;
        self.flush_into(interrupted, interrupted && stop != Some(StopKind::Steer), out);
        self.streaming = None;
        let u = v.get("usage").unwrap_or(&Value::Null);
        let tokens = |k: &str| num(u.get(k));
        let usage = (tokens("input_tokens") + tokens("output_tokens") > 0).then(|| {
            json!({
                "inputTokens": tokens("input_tokens"),
                "outputTokens": tokens("output_tokens"),
                "cacheReadTokens": tokens("cache_read_input_tokens"),
                "cacheWriteTokens": tokens("cache_creation_input_tokens"),
            })
        });
        if let Some(window) = self.window(v.get("modelUsage")) {
            self.context.window = Some(window);
        }
        let context = self.context();
        out.push(Mapped::End(TurnEnd {
            outcome,
            session_id: str_at(v, "session_id").map(str::to_string),
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            num_turns: v.get("num_turns").and_then(Value::as_u64),
            usage,
            terminal_reason: reason,
            context,
        }));
    }

    /// Claude Code's window for the turn's model: its `modelUsage` entry, or
    /// the only entry when none is keyed by the init model.
    fn window(&self, model_usage: Option<&Value>) -> Option<u64> {
        let entries = model_usage?.as_object()?;
        let entry = match self.model.as_deref().and_then(|m| entries.get(m)) {
            Some(e) => e,
            None if entries.len() == 1 => entries.values().next()?,
            None => return None,
        };
        entry.get("contextWindow").and_then(Value::as_u64).filter(|w| *w > 0)
    }

    /// Close the step being assembled. `interrupted` marks a reply cut off;
    /// `note` adds the line Nekko's own loop adds to a stopped reply.
    fn flush_into(&mut self, interrupted: bool, note: bool, out: &mut Vec<Mapped>) {
        let Some(d) = self.draft.take() else { return };
        if d.is_empty() {
            return;
        }
        let mut m = Map::new();
        m.insert("id".into(), json!(d.id));
        m.insert("role".into(), json!("assistant"));
        let mut content = d.text.clone();
        if note {
            let partial = content.trim().to_string();
            content = [partial.as_str(), nekko_loop::INTERRUPTED_NOTE]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n\n");
        }
        m.insert("content".into(), json!(content));
        if !d.reasoning.is_empty() {
            m.insert("reasoning".into(), json!(d.reasoning));
        }
        if !d.calls.is_empty() {
            m.insert("toolCalls".into(), Value::Array(d.calls.clone()));
        }
        if interrupted {
            m.insert("interrupted".into(), json!(true));
        }
        m.insert("createdAt".into(), json!(d.created_at));
        self.last_message_id = Some(d.id.clone());
        out.push(Mapped::Message(Value::Object(m)));
        if !d.calls.is_empty() && !interrupted {
            self.steps += 1;
            out.push(self.event("step", json!({ "messageId": d.id })));
        }
    }

    /// The process went away mid-reply (or was killed): keep what streamed.
    pub fn flush(&mut self, interrupted: bool, note: bool) -> Vec<Mapped> {
        let mut out = Vec::new();
        self.flush_into(interrupted, note, &mut out);
        out
    }

    /// The events that end the Nekko turn after Claude Code's `result`:
    /// `usage`, then `done` or `error` (a user's Stop reads "Stopped", as in
    /// Nekko's own loop). An error already shown is not repeated.
    pub fn finish(&mut self, end: &TurnEnd) -> Vec<Mapped> {
        let mut out = Vec::new();
        if let Some(u) = &end.usage {
            out.push(self.event("usage", u.clone()));
        }
        match &end.outcome {
            Outcome::Completed => {
                let id = self.last_message_id.clone().unwrap_or_default();
                out.push(self.event("done", json!({ "messageId": id, "stop": "complete", "steps": self.steps })));
            }
            Outcome::Interrupted => out.push(self.error(USER_STOPPED)),
            Outcome::Failed(message) if !self.error_sent => {
                let message = message.clone();
                out.push(self.error(&message));
            }
            Outcome::Failed(_) => {}
        }
        out
    }

    /// An error that ends the turn from outside the stream (an exit, a kill).
    pub fn fail(&mut self, message: &str) -> Vec<Mapped> {
        if self.error_sent {
            return Vec::new();
        }
        vec![self.error(message)]
    }
}

/// A Claude Code `tool_use` block as Nekko's `ToolCall`, marked as run by
/// Claude Code (display only: Nekko does not run it).
fn tool_call(b: &Value) -> Value {
    json!({
        "id": str_at(b, "id").unwrap_or_default(),
        "name": str_at(b, "name").unwrap_or_default(),
        "input": b.get("input").cloned().unwrap_or_else(|| json!({})),
        "executedBy": "claude-code",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_content_is_text_or_blocks() {
        assert_eq!(user_content(&json!({ "content": "hi" })), json!("hi"));
        let with_image = json!({ "content": "look", "images": ["data:image/png;base64,AAAA", "https://x/y.png"] });
        assert_eq!(
            user_content(&with_image),
            json!([
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } },
                { "type": "text", "text": "look" },
            ])
        );
    }

    #[test]
    fn result_text_joins_blocks() {
        assert_eq!(result_text(Some(&json!("x"))), "x");
        assert_eq!(
            result_text(Some(&json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]))),
            "a\nb"
        );
        assert_eq!(result_text(None), "");
    }
}
