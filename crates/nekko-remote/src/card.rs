//! The iPhone's one Live Activity card, built on the computer so the relay can
//! push it while iOS has suspended the app (Part 4 of the always-on voice plan).
//!
//! `build_card` is `buildCard` in apps/ios/Protocol/Sources/NekkoProtocol/LiveCard.swift
//! rule for rule: both run packages/shared/fixtures/live-card.json, so change
//! them together. A card goes out as ActivityKit's `ContentState`, so dates are
//! seconds since 2001-01-01 (the default `JSONDecoder` date form) and the size
//! guard counts bytes as Swift's `JSONEncoder` writes them.
//!
//! `Cards` keeps the card for the relay agent: what each chat's run is doing
//! (from its events), the chat list (titles, replies, watches), which level
//! each phone asked for (`card:set`) and when a phone last sent to a chat.

use serde_json::{Map, Value, json};

/// Unix time of 2001-01-01, where ActivityKit's dates count from.
pub const REFERENCE_DATE: f64 = 978_307_200.0;
pub const MAX_CHATS: usize = 8;
/// A finished chat stays on the card this long (seconds).
pub const FINISHED_TAIL: f64 = 2.0 * 3600.0;
/// The encoded state's budget, under ActivityKit's 4 KB.
pub const MAX_BYTES: usize = 3500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LiveLevel {
    None,
    Minimal,
    Standard,
    Detailed,
}

impl LiveLevel {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "standard" => Self::Standard,
            "detailed" => Self::Detailed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveChatState {
    NeedsYou,
    Working,
    Watching,
    Done,
    Failed,
}

impl LiveChatState {
    /// A state from a newer computer reads as working, as on the phone.
    pub fn parse(s: &str) -> Self {
        match s {
            "needsYou" => Self::NeedsYou,
            "watching" => Self::Watching,
            "done" => Self::Done,
            "failed" => Self::Failed,
            _ => Self::Working,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsYou => "needsYou",
            Self::Working => "working",
            Self::Watching => "watching",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }

    /// Sort order on the card: what needs you first.
    fn rank(self) -> u8 {
        self as u8
    }

    fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LiveChat {
    pub id: String,
    pub short: String,
    pub state: LiveChatState,
    pub step: String,
    pub reply: String,
    pub close_word: String,
    /// Seconds since 2001.
    pub finished_at: Option<f64>,
    pub started_at: Option<f64>,
    pub call_id: Option<String>,
    pub severity: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LiveCardState {
    pub chats: Vec<LiveChat>,
    pub focus_id: Option<String>,
    pub more: usize,
    pub listening: bool,
    pub heard: String,
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// A date as Swift's `JSONEncoder` writes a `Date`: whole seconds without ".0".
fn date(t: f64) -> Value {
    if t.fract() == 0.0 && t.abs() < 9e15 { json!(t as i64) } else { json!(t) }
}

impl LiveChat {
    /// The tolerant read the phone does: anything but the id and state may be missing.
    pub fn from_value(v: &Value) -> Option<Self> {
        Some(Self {
            id: v.get("id")?.as_str()?.to_string(),
            state: LiveChatState::parse(v.get("state")?.as_str()?),
            short: text(v, "short"),
            step: text(v, "step"),
            reply: text(v, "reply"),
            close_word: text(v, "closeWord"),
            finished_at: v.get("finishedAt").and_then(Value::as_f64),
            started_at: v.get("startedAt").and_then(Value::as_f64),
            call_id: v.get("callId").and_then(Value::as_str).map(str::to_string),
            severity: v.get("severity").and_then(Value::as_str).map(str::to_string),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("id".into(), json!(self.id));
        o.insert("short".into(), json!(self.short));
        o.insert("state".into(), json!(self.state.as_str()));
        o.insert("step".into(), json!(self.step));
        o.insert("reply".into(), json!(self.reply));
        o.insert("closeWord".into(), json!(self.close_word));
        if let Some(t) = self.finished_at {
            o.insert("finishedAt".into(), date(t));
        }
        if let Some(t) = self.started_at {
            o.insert("startedAt".into(), date(t));
        }
        if let Some(c) = &self.call_id {
            o.insert("callId".into(), json!(c));
        }
        if let Some(s) = &self.severity {
            o.insert("severity".into(), json!(s));
        }
        Value::Object(o)
    }
}

impl LiveCardState {
    pub fn from_value(v: &Value) -> Self {
        Self {
            chats: v
                .get("chats")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(LiveChat::from_value).collect())
                .unwrap_or_default(),
            focus_id: v.get("focusId").and_then(Value::as_str).map(str::to_string),
            more: v.get("more").and_then(Value::as_u64).unwrap_or(0) as usize,
            listening: v.get("listening").and_then(Value::as_bool).unwrap_or(false),
            heard: text(v, "heard"),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("chats".into(), Value::Array(self.chats.iter().map(LiveChat::to_value).collect()));
        if let Some(f) = &self.focus_id {
            o.insert("focusId".into(), json!(f));
        }
        o.insert("more".into(), json!(self.more));
        o.insert("listening".into(), json!(self.listening));
        o.insert("heard".into(), json!(self.heard));
        Value::Object(o)
    }
}

/// The state's size as Swift's `JSONEncoder` writes it, which escapes "/".
pub fn encoded_len(state: &LiveCardState) -> usize {
    let s = state.to_value().to_string();
    s.len() + s.matches('/').count()
}

/// `Transcript.oneLine`: whitespace runs collapsed to one space, at most `max`
/// characters ending in "…". shortcut: counts chars, Swift counts graphemes; an
/// emoji sequence near the cut can clip differently (harmless, both stay short).
pub fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max { flat.chars().take(max - 1).collect::<String>() + "…" } else { flat }
}

/// Builds the card from every chat, or `None` when there is nothing to show
/// (no chats left, or the level is None). `now` is seconds since 2001.
pub fn build_card(
    chats: &[LiveChat],
    previous: Option<&LiveCardState>,
    pinned_focus: Option<&str>,
    level: LiveLevel,
    now: f64,
) -> Option<LiveCardState> {
    if level == LiveLevel::None {
        return None;
    }
    let mut live: Vec<(usize, &LiveChat)> = chats
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.state.finished() || c.finished_at.is_none_or(|at| now - at <= FINISHED_TAIL))
        .collect();
    // Most recent first within a state; ties keep the caller's order.
    live.sort_by(|(ia, a), (ib, b)| {
        let (ta, tb) = (a.finished_at.unwrap_or(f64::MIN), b.finished_at.unwrap_or(f64::MIN));
        a.state.rank().cmp(&b.state.rank()).then(tb.total_cmp(&ta)).then(ia.cmp(ib))
    });
    if live.is_empty() {
        return None;
    }
    let mut kept: Vec<LiveChat> = live.iter().take(MAX_CHATS).map(|(_, c)| (*c).clone()).collect();
    let more = live.len() - kept.len();

    let mut before: Vec<(&str, LiveChatState)> = Vec::new();
    for c in previous.map(|p| p.chats.as_slice()).unwrap_or_default() {
        if !before.iter().any(|(id, _)| *id == c.id) {
            before.push((&c.id, c.state));
        }
    }
    let was = |id: &str| before.iter().find(|(b, _)| *b == id).map(|(_, s)| *s);
    let focus = previous.and_then(|_| {
        kept.iter().find(|c| c.state == LiveChatState::NeedsYou && was(&c.id) != Some(LiveChatState::NeedsYou))
    });
    let focus = focus.map(|c| c.id.clone());
    let pinned = pinned_focus.filter(|id| kept.iter().any(|c| c.id == *id)).map(str::to_string);

    for c in &mut kept {
        c.step = one_line(&c.step, 60);
        if level == LiveLevel::Minimal {
            c.short.clear();
            c.step.clear();
        }
        if level != LiveLevel::Detailed {
            c.reply.clear();
        }
    }
    let focus_id = focus.or(pinned).unwrap_or_else(|| kept[0].id.clone());
    let mut card = LiveCardState {
        chats: kept,
        focus_id: Some(focus_id),
        more,
        listening: previous.is_some_and(|p| p.listening),
        heard: previous.map(|p| p.heard.clone()).unwrap_or_default(),
    };
    // ActivityKit refuses a state over 4 KB: replies go first, then the last
    // chats move into "+N", never the focused one.
    if encoded_len(&card) > MAX_BYTES {
        for c in &mut card.chats {
            c.reply.clear();
        }
    }
    while encoded_len(&card) > MAX_BYTES {
        let Some(last) = card.chats.iter().rposition(|c| Some(&c.id) != card.focus_id.as_ref()) else { break };
        card.chats.remove(last);
        card.more += 1;
    }
    Some(card)
}

/// The first word, plus the second when both fit in 8 characters; a longer
/// first word is cut to 8 and ends in "…".
pub fn short_title(title: &str) -> String {
    let words: Vec<&str> = title.split_whitespace().collect();
    let Some(first) = words.first() else { return String::new() };
    let n = first.chars().count();
    if n > 8 {
        return first.chars().take(8).collect::<String>() + "…";
    }
    match words.get(1) {
        Some(second) if n + 1 + second.chars().count() <= 8 => format!("{first} {second}"),
        _ => first.to_string(),
    }
}

const CLOSE_WORDS: [&str; 5] = ["Looks good", "Cool", "Excellent", "Nice", "Perfect"];

/// "Got it" for a failure, else one of five words picked by FNV-1a of the id.
pub fn close_word(id: &str, failed: bool) -> &'static str {
    if failed {
        return "Got it";
    }
    let h = id.bytes().fold(2_166_136_261u32, |h, b| (h ^ u32::from(b)).wrapping_mul(16_777_619));
    CLOSE_WORDS[(h % 5) as usize]
}

/// Swift's `Character.isNewline`.
fn is_newline(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// The card's reply line (Detailed): the first sentence of the agent's latest
/// reply, or its first line, at most 60 characters.
pub fn reply_line(text: &str) -> String {
    let t = text.trim();
    let mut end = t.len();
    let mut chars = t.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if is_newline(c) {
            end = i;
            break;
        }
        if ".!?".contains(c) && chars.peek().is_none_or(|(_, n)| n.is_whitespace()) {
            end = i + c.len_utf8();
            break;
        }
    }
    let spaces = |c: char| c.is_whitespace() && !is_newline(c);
    let line = t[..end].trim_matches(spaces);
    if line.chars().count() > 60 {
        line.chars().take(59).collect::<String>().trim_matches(spaces).to_string() + "…"
    } else {
        line.to_string()
    }
}

/// The phone channel the relay agent answers itself: `card:set { level?, focus?, dismiss? }`.
pub const CARD_CHANNEL: &str = "card:set";
/// A new step waits this long after the last push (seconds); a chat changing
/// state, joining or leaving, or the focus moving goes at once.
pub const CARD_PUSH_GAP: f64 = 10.0;
/// A phone that sent to a chat this recently wants a card when its run starts.
pub const REMOTE_START_WINDOW: f64 = 2.0 * 3600.0;
/// A run with no event for this long no longer counts as working (as on the phone).
const QUIET_RUN: f64 = 30.0 * 60.0;
/// A run with no event for this long is forgotten (its end was never heard).
const FORGET_RUN: f64 = 12.0 * 3600.0;
/// How often the card is rebuilt with nothing new, so finished chats leave on time.
const RECHECK: f64 = 60.0;

/// What the events say about a chat's latest run.
#[derive(Debug, Clone)]
struct Run {
    started_at: f64,
    last_event_at: f64,
    step: String,
    needs_you: bool,
    call_id: Option<String>,
    severity: Option<String>,
    finished: Option<LiveChatState>,
    finished_at: Option<f64>,
}

/// A chat as the phone's list has it (`sessions:summaries`).
#[derive(Debug, Clone)]
struct Summary {
    id: String,
    title: String,
    reply: String,
    watching: bool,
    /// The phone lists only top-level chats (no sub-agents, tasks or training runs).
    visible: bool,
}

/// The card for the relay agent: `card` / `card-start` frames for the relay,
/// which pushes them to each phone's Live Activity (packages/shared remote.ts).
#[derive(Default)]
pub struct Cards {
    /// The level each phone asked for (`card:set`); kept while it is away, as
    /// pushes are for a phone iOS has suspended.
    levels: std::collections::HashMap<String, LiveLevel>,
    runs: std::collections::HashMap<String, Run>,
    /// Nil until the chat list was read.
    summaries: Option<Vec<Summary>>,
    wants: bool,
    /// When a card that is up last asked for the list again (a watch may end, a chat be renamed or archived).
    listed_at: f64,
    /// Focus and dismissals are shared by every phone: they are one user's.
    dismissed: std::collections::HashSet<String>,
    pinned: Option<String>,
    /// When a phone last sent to each chat (`chat:send`, `chat:queue`).
    phone_sent: std::collections::HashMap<String, f64>,
    /// The last card sent, `None` once none is up.
    sent: Option<LiveCardState>,
    sent_at: f64,
    pending: bool,
    checked_at: f64,
    /// A new relay connection: send the card again even if it did not change.
    resend: bool,
}

impl Cards {
    /// The highest level any phone asked for.
    pub fn level(&self) -> LiveLevel {
        self.levels.values().copied().max().unwrap_or(LiveLevel::None)
    }

    /// `card:set` from `device`: its level, the chat a chip tap brought up,
    /// or a finished chat closed with the card's button.
    pub fn set(&mut self, device: &str, args: &Value, now: f64) -> Vec<Value> {
        let a = args.get(0).unwrap_or(&Value::Null);
        match a.get("level").and_then(Value::as_str).and_then(LiveLevel::parse) {
            Some(LiveLevel::None) => {
                self.levels.remove(device);
            }
            Some(level) => {
                // A new level shows other text: read the list again; so does a list never read.
                self.wants |= self.levels.insert(device.to_string(), level) != Some(level) || self.summaries.is_none();
            }
            None => {}
        }
        if let Some(id) = a.get("focus").and_then(Value::as_str) {
            self.pinned = Some(id.to_string());
        }
        if let Some(id) = a.get("dismiss").and_then(Value::as_str) {
            if self.pinned.as_deref() == Some(id) {
                self.pinned = None;
            }
            self.dismissed.insert(id.to_string());
        }
        self.update(now, true, false)
    }

    /// A revoked phone.
    pub fn forget(&mut self, device: &str) {
        self.levels.remove(device);
    }

    /// The relay connection dropped: the next one gets the card again (at the next tick).
    pub fn reconnected(&mut self) {
        self.resend = true;
        self.checked_at = f64::MIN;
    }

    /// A phone's request: a prompt to a chat makes that chat's next run start a card.
    pub fn phone_call(&mut self, channel: &str, args: &Value, now: f64) {
        if channel != "chat:send" && channel != "chat:queue" {
            return;
        }
        let first = args.get(0);
        let id =
            first.and_then(Value::as_str).or_else(|| first.and_then(|a| a.get("sessionId")).and_then(Value::as_str));
        if let Some(id) = id {
            self.phone_sent.retain(|_, at| now - *at <= REMOTE_START_WINDOW);
            self.phone_sent.insert(id.to_string(), now);
        }
    }

    /// An `agent:event` (`onEvent` in RunActivities.swift).
    pub fn on_event(&mut self, e: &Value, now: f64) -> Vec<Value> {
        let (Some(sid), Some(ty)) = (e.get("sessionId").and_then(Value::as_str), e.get("type").and_then(Value::as_str))
        else {
            return Vec::new();
        };
        let sid = sid.to_string();
        let started = self.runs.get(&sid).is_none_or(|r| r.finished.is_some());
        match ty {
            "text" | "reasoning" => self.running(&sid, now, "Writing…".into(), None),
            "tool_call" => self.running(&sid, now, tool_label(&e["call"]), None),
            "tool_approval_required" => {
                let sev = e.get("severity").and_then(Value::as_str).filter(|s| matches!(*s, "high" | "medium"));
                let sev = sev.unwrap_or("low");
                let call = e["call"]["id"].as_str().map(|id| (id.to_string(), sev.to_string()));
                self.running(&sid, now, tool_label(&e["call"]), Some(call))
            }
            "question" => {
                let q =
                    e.pointer("/request/questions/0/question").and_then(Value::as_str).unwrap_or("A question for you");
                self.running(&sid, now, q.to_string(), Some(None))
            }
            "tool_result" | "question_resolved" => self.running(&sid, now, "Working…".into(), None),
            "done" => self.finish(&sid, now, LiveChatState::Done, "Finished"),
            "error" => {
                let msg = e.get("message").and_then(Value::as_str).unwrap_or("").to_lowercase();
                let stopped = msg == "stopped" || msg == "aborted";
                let (state, step) = if stopped {
                    (LiveChatState::Done, "Stopped")
                } else {
                    (LiveChatState::Failed, "Stopped with an error")
                };
                self.finish(&sid, now, state, step)
            }
            "session_meta" => self.wants = true,
            _ => return Vec::new(),
        }
        if self.summaries.as_ref().is_none_or(|list| !list.iter().any(|s| s.id == sid)) {
            self.wants = true;
        }
        let running = self.runs.get(&sid).is_some_and(|r| r.finished.is_none());
        let start = started && running && self.wants_card(&sid, now);
        self.update(now, false, start)
    }

    /// `needs`: `Some(call)` when it waits on the phone (an approval's call id and severity, or a question).
    fn running(&mut self, sid: &str, now: f64, step: String, needs: Option<Option<(String, String)>>) {
        let fresh = Run {
            started_at: now,
            last_event_at: now,
            step: String::new(),
            needs_you: false,
            call_id: None,
            severity: None,
            finished: None,
            finished_at: None,
        };
        let run = self.runs.entry(sid.to_string()).or_insert_with(|| fresh.clone());
        if run.finished.is_some() {
            *run = fresh;
        }
        run.last_event_at = now;
        run.step = step;
        run.needs_you = needs.is_some();
        (run.call_id, run.severity) = needs.flatten().map_or((None, None), |(c, s)| (Some(c), Some(s)));
        self.dismissed.remove(sid);
    }

    fn finish(&mut self, sid: &str, now: f64, state: LiveChatState, step: &str) {
        let run = self.runs.entry(sid.to_string()).or_insert_with(|| Run {
            started_at: now,
            last_event_at: now,
            step: String::new(),
            needs_you: false,
            call_id: None,
            severity: None,
            finished: None,
            finished_at: None,
        });
        run.last_event_at = now;
        run.finished = Some(state);
        run.finished_at = Some(now);
        run.step = step.to_string();
        run.needs_you = false;
        run.call_id = None;
        // Its reply line changed.
        self.wants = true;
    }

    /// The remote-start rule: a phone sent to this chat in the last two hours,
    /// or a watch woke it (the chat list had it watching).
    fn wants_card(&self, sid: &str, now: f64) -> bool {
        self.phone_sent.get(sid).is_some_and(|at| now - at <= REMOTE_START_WINDOW)
            || self.summaries.iter().flatten().any(|s| s.id == sid && s.watching)
    }

    /// Whether to read the chat list now (once until `set_summaries`), and only
    /// while a phone wants a card.
    pub fn wants_summaries(&mut self) -> bool {
        let ask = self.wants && self.level() != LiveLevel::None;
        if ask {
            self.wants = false;
        }
        ask
    }

    /// The chat list (`sessions:summaries`) arrived.
    pub fn set_summaries(&mut self, list: &Value, now: f64) -> Vec<Value> {
        let mut rows: Vec<(f64, Summary)> = list
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                let id = v.get("id")?.as_str()?.to_string();
                let has = |k: &str| v.get(k).is_some_and(|x| !x.is_null());
                let summary = Summary {
                    title: text(v, "title"),
                    reply: reply_line(v.get("lastReplyText").and_then(Value::as_str).unwrap_or("")),
                    watching: v.get("activeWatchCount").and_then(Value::as_f64).unwrap_or(0.0) > 0.0,
                    visible: !has("parentSessionId") && !has("taskId") && !has("trainingRunId"),
                    // Archived chats are off the card, as on the phone.
                    id,
                };
                let archived = v.get("archivedAt").and_then(Value::as_f64).is_some_and(|a| a != 0.0);
                Some((
                    v.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0),
                    Summary { visible: summary.visible && !archived, ..summary },
                ))
            })
            .collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        let list: Vec<Summary> = rows.into_iter().map(|(_, s)| s).collect();
        self.dismissed.retain(|id| list.iter().any(|s| s.id == *id));
        self.summaries = Some(list);
        self.listed_at = now;
        self.update(now, true, false)
    }

    /// A throttled update whose wait is over, or finished chats whose two hours are up.
    pub fn tick(&mut self, now: f64) -> Vec<Value> {
        if self.levels.is_empty() {
            return Vec::new();
        }
        if self.sent.is_some() && now - self.listed_at >= RECHECK {
            self.listed_at = now;
            self.wants = true;
        }
        let due = (self.pending && now - self.sent_at >= CARD_PUSH_GAP) || now - self.checked_at >= RECHECK;
        if due { self.update(now, false, false) } else { Vec::new() }
    }

    /// The chats as the phone lists them (`liveChats` in RunActivities.swift);
    /// a chat the list does not have yet shows as "Chat" until it is read.
    fn chats(&self, now: f64) -> Vec<LiveChat> {
        let known = self.summaries.as_deref().unwrap_or_default();
        let mut runs: Vec<(&String, &Run)> =
            self.runs.iter().filter(|(id, _)| !known.iter().any(|s| s.id == **id)).collect();
        runs.sort_by(|a, b| b.1.started_at.total_cmp(&a.1.started_at).then(a.0.cmp(b.0)));
        let unknown = runs.into_iter().map(|(id, _)| (id.as_str(), None));
        let listed = known.iter().filter(|s| s.visible).map(|s| (s.id.as_str(), Some(s)));
        unknown
            .chain(listed)
            .filter(|(id, _)| !self.dismissed.contains(*id))
            .filter_map(|(id, s)| {
                let run = self.runs.get(id);
                // A run waiting on the phone stays however long it waits (only FORGET_RUN ends it).
                let live = run.filter(|r| r.finished.is_none() && (r.needs_you || now - r.last_event_at < QUIET_RUN));
                let (state, step) = if let Some(live) = live {
                    (if live.needs_you { LiveChatState::NeedsYou } else { LiveChatState::Working }, live.step.clone())
                } else if s.is_some_and(|s| s.watching) {
                    (LiveChatState::Watching, "Watching PR…".to_string())
                } else if let Some(r) = run.filter(|r| r.finished.is_some()) {
                    (r.finished?, r.step.clone())
                } else {
                    return None;
                };
                let title = s.map(|s| s.title.as_str()).filter(|t| !t.is_empty()).unwrap_or("Chat");
                let needs = state == LiveChatState::NeedsYou;
                Some(LiveChat {
                    id: id.to_string(),
                    short: short_title(title),
                    state,
                    step,
                    reply: s.map(|s| s.reply.clone()).unwrap_or_default(),
                    close_word: close_word(id, state == LiveChatState::Failed).to_string(),
                    finished_at: if state.finished() { run.and_then(|r| r.finished_at) } else { None },
                    started_at: live.map(|r| r.started_at),
                    call_id: if needs { live.and_then(|r| r.call_id.clone()) } else { None },
                    severity: if needs { live.and_then(|r| r.severity.clone()) } else { None },
                })
            })
            .collect()
    }

    /// Rebuilds the card and says what to send: nothing when it did not change
    /// or a new step must wait; `card` (an empty one ends it); `card-start`
    /// when `start` (the relay starts one only on a phone with none up).
    fn update(&mut self, now: f64, urgent: bool, start: bool) -> Vec<Value> {
        self.runs.retain(|_, r| {
            r.finished_at.is_none_or(|at| now - at <= FINISHED_TAIL) && now - r.last_event_at <= FORGET_RUN
        });
        self.checked_at = now;
        let level = self.level();
        if level == LiveLevel::None {
            self.sent = None;
            self.pending = false;
            return Vec::new();
        }
        let state = build_card(&self.chats(now), self.sent.as_ref(), self.pinned.as_deref(), level, now);
        if let Some(s) = &state
            && s.focus_id != self.pinned
        {
            self.pinned = None;
        }
        let resend = std::mem::take(&mut self.resend);
        let Some(state) = state else {
            self.pending = false;
            return match self.sent.take() {
                Some(_) => vec![json!({ "type": "card", "state": LiveCardState::empty().to_value() })],
                None => Vec::new(),
            };
        };
        let prev = self.sent.as_ref();
        if prev == Some(&state) && !start && !resend {
            self.pending = false;
            return Vec::new();
        }
        let shape = |s: &LiveCardState| -> Vec<(String, LiveChatState, Option<String>)> {
            s.chats.iter().map(|c| (c.id.clone(), c.state, c.call_id.clone())).collect()
        };
        let at_once =
            urgent || start || resend || prev.is_none_or(|p| shape(p) != shape(&state) || p.focus_id != state.focus_id);
        if !at_once && now - self.sent_at < CARD_PUSH_GAP {
            self.pending = true;
            return Vec::new();
        }
        let frame = json!({ "type": if start { "card-start" } else { "card" }, "state": state.to_value() });
        self.sent = Some(state);
        self.sent_at = now;
        self.pending = false;
        vec![frame]
    }
}

impl LiveCardState {
    pub fn empty() -> Self {
        Self { chats: Vec::new(), focus_id: None, more: 0, listening: false, heard: String::new() }
    }
}

const TOOL_KEYS: [&str; 9] = ["command", "path", "file_path", "pattern", "query", "url", "name", "prompt", "task"];

/// `Transcript.toolLabel`: a short label for a tool call, the file, command or query it acts on.
pub fn tool_label(call: &Value) -> String {
    let name = call.get("name").and_then(Value::as_str).unwrap_or("");
    let verb = match name {
        "read_file" => "Read",
        "write_file" => "Write",
        "edit_file" => "Edit",
        "list_dir" => "List",
        "glob" => "Find",
        "grep" => "Search",
        "bash" => "Run",
        "web_fetch" => "Fetch",
        "web_search" => "Search the web for",
        "spawn_agent" => "Delegate",
        "ask_user" => "Ask",
        "agent_watch" => "Watch",
        other => return label(&other.replace('_', " "), call),
    };
    label(verb, call)
}

fn label(verb: &str, call: &Value) -> String {
    let detail =
        TOOL_KEYS.iter().filter_map(|k| call.get("input")?.get(*k)?.as_str().map(str::trim)).find(|d| !d.is_empty());
    match detail {
        Some(d) => format!("{verb} {}", one_line(d, 80)),
        None => verb.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../packages/shared/fixtures/live-card.json")).unwrap()
    }

    /// The rules the iPhone runs (`buildCard` in LiveCard.swift), from the shared
    /// fixture both read (packages/shared/fixtures/live-card.json).
    #[test]
    fn the_shared_fixture() {
        let f = fixture();
        let now = f["now"].as_f64().unwrap();
        let builds = f["build"].as_array().unwrap();
        assert!(builds.len() >= 20);
        for c in builds {
            let name = c["name"].as_str().unwrap();
            let chats: Vec<LiveChat> = c["chats"].as_array().unwrap().iter().filter_map(LiveChat::from_value).collect();
            let previous = c.get("previous").map(LiveCardState::from_value);
            let level = LiveLevel::parse(c["level"].as_str().unwrap()).unwrap();
            let card = build_card(&chats, previous.as_ref(), c["pinnedFocus"].as_str(), level, now);
            let want = c.get("card").filter(|v| !v.is_null()).map(LiveCardState::from_value);
            assert_eq!(card, want, "{name}");
            if let Some(card) = card {
                assert_eq!(encoded_len(&card), c["bytes"].as_u64().unwrap() as usize, "bytes: {name}");
                // What is pushed reads back the same.
                assert_eq!(LiveCardState::from_value(&card.to_value()), card, "round trip: {name}");
            }
        }
        for c in f["decode"].as_array().unwrap() {
            let state = LiveCardState::from_value(&c["json"]);
            let states: Vec<&str> = state.chats.iter().map(|c| c.state.as_str()).collect();
            assert_eq!(json!(states), c["states"], "{}", c["name"]);
            if let Some(at) = c.get("finishedAt") {
                assert_eq!(state.chats[0].finished_at, at.as_f64());
                // Written back as ActivityKit's default decoder reads a date: a plain number.
                assert_eq!(state.to_value()["chats"][0]["finishedAt"], *at);
                assert_eq!(state.to_value()["chats"][0]["startedAt"], c["startedAt"]);
            }
        }
        for c in f["shortTitle"].as_array().unwrap() {
            assert_eq!(short_title(c[0].as_str().unwrap()), c[1].as_str().unwrap(), "{c}");
        }
        for c in f["closeWord"].as_array().unwrap() {
            assert_eq!(close_word(c[0].as_str().unwrap(), c[1].as_bool().unwrap()), c[2].as_str().unwrap(), "{c}");
        }
        for c in f["replyLine"].as_array().unwrap() {
            assert_eq!(reply_line(c[0].as_str().unwrap()), c[1].as_str().unwrap(), "{c}");
        }
    }

    const T0: f64 = 800_000_000.0;

    fn ev(ty: &str, sid: &str, extra: Value) -> Value {
        let mut e = json!({ "type": ty, "sessionId": sid });
        e.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
        e
    }

    fn tool(sid: &str, cmd: &str) -> Value {
        ev("tool_call", sid, json!({ "call": { "id": "c1", "name": "bash", "input": { "command": cmd } } }))
    }

    fn standard() -> Cards {
        let mut c = Cards::default();
        assert!(c.set("phone-1", &json!([{ "level": "standard" }]), T0).is_empty(), "no chats yet");
        c
    }

    /// The one frame and its state.
    fn only(frames: &[Value]) -> (String, LiveCardState) {
        assert_eq!(frames.len(), 1, "{frames:?}");
        (frames[0]["type"].as_str().unwrap().to_string(), LiveCardState::from_value(&frames[0]["state"]))
    }

    #[test]
    fn nothing_goes_out_until_a_phone_asks_for_a_card() {
        let mut c = Cards::default();
        assert!(c.on_event(&tool("s1", "npm test"), T0).is_empty());
        assert!(!c.wants_summaries(), "nobody wants a card: the chat list is not read either");
        let out = c.set("phone-1", &json!([{ "level": "detailed" }]), T0 + 1.0);
        let (ty, card) = only(&out);
        assert_eq!(ty, "card");
        let chat = &card.chats[0];
        assert_eq!((chat.id.as_str(), chat.state, chat.step.as_str()), ("s1", LiveChatState::Working, "Run npm test"));
        assert_eq!(chat.short, "Chat", "no chat list yet");
        assert_eq!(chat.started_at, Some(T0));
        assert!(c.wants_summaries());
        assert!(!c.wants_summaries(), "asked once until the list arrives");
        let list = json!([
            { "id": "s1", "title": "Fix login bug", "lastReplyText": "On it. Running the tests.", "updatedAt": 2 },
            { "id": "sub", "title": "Sub", "parentSessionId": "s1", "updatedAt": 3 },
        ]);
        let (_, card) = only(&c.set_summaries(&list, T0 + 2.0));
        assert_eq!((card.chats[0].short.as_str(), card.chats[0].reply.as_str()), ("Fix", "On it."));
        // A sub-agent's chat is not on the phone's list, so not on the card.
        assert!(c.on_event(&tool("sub", "ls"), T0 + 20.0).is_empty());
    }

    #[test]
    fn text_goes_out_only_at_the_highest_level_a_phone_asked_for() {
        let mut c = Cards::default();
        c.set("phone-1", &json!([{ "level": "minimal" }]), T0);
        let (_, card) = only(&c.on_event(&tool("s1", "npm test"), T0));
        assert_eq!((card.chats[0].short.as_str(), card.chats[0].step.as_str()), ("", ""));
        // Another phone at Standard: text goes out, the relay blanks it for the first.
        let (_, card) = only(&c.set("phone-2", &json!([{ "level": "standard" }]), T0 + 1.0));
        assert_eq!(card.chats[0].step, "Run npm test");
        // It turns its card off: back to no text.
        let (_, card) = only(&c.set("phone-2", &json!([{ "level": "none" }]), T0 + 30.0));
        assert_eq!(card.chats[0].step, "");
        c.forget("phone-1");
        assert!(c.on_event(&tool("s1", "ls"), T0 + 60.0).is_empty(), "no phone wants a card");
    }

    #[test]
    fn a_new_step_waits_ten_seconds_but_a_new_state_goes_at_once() {
        let mut c = standard();
        only(&c.on_event(&tool("s1", "npm test"), T0));
        assert!(c.on_event(&tool("s1", "npm run lint"), T0 + 1.0).is_empty());
        assert!(c.tick(T0 + 5.0).is_empty());
        let (_, card) = only(&c.tick(T0 + 10.0));
        assert_eq!(card.chats[0].step, "Run npm run lint");
        assert!(c.tick(T0 + 11.0).is_empty(), "sent once");
        let approval = ev(
            "tool_approval_required",
            "s1",
            json!({ "call": { "id": "call_9", "name": "bash", "input": { "command": "rm -rf build" } }, "severity": "high" }),
        );
        let (_, card) = only(&c.on_event(&approval, T0 + 12.0));
        let chat = &card.chats[0];
        assert_eq!(chat.state, LiveChatState::NeedsYou);
        assert_eq!((chat.call_id.as_deref(), chat.severity.as_deref()), (Some("call_9"), Some("high")));
        let (_, card) = only(&c.on_event(&ev("tool_result", "s1", json!({})), T0 + 13.0));
        assert_eq!((card.chats[0].state, card.chats[0].call_id.as_deref()), (LiveChatState::Working, None));
    }

    #[test]
    fn a_finished_chat_stays_two_hours_then_the_card_ends() {
        let mut c = standard();
        only(&c.on_event(&tool("s1", "npm test"), T0));
        let (_, card) = only(&c.on_event(&ev("done", "s1", json!({})), T0 + 5.0));
        let chat = &card.chats[0];
        assert_eq!(
            (chat.state, chat.step.as_str(), chat.finished_at),
            (LiveChatState::Done, "Finished", Some(T0 + 5.0))
        );
        assert_eq!(chat.close_word, close_word("s1", false));
        assert!(c.wants_summaries(), "a finished run has a new reply line");
        let (_, card) = only(&c.on_event(&ev("error", "s2", json!({ "message": "boom" })), T0 + 6.0));
        assert_eq!(card.chats.iter().find(|c| c.id == "s2").unwrap().state, LiveChatState::Failed);
        assert!(c.tick(T0 + 5.0 + FINISHED_TAIL).is_empty());
        let (ty, card) = only(&c.tick(T0 + 7.0 + FINISHED_TAIL + 60.0));
        assert_eq!((ty.as_str(), card.chats.len()), ("card", 0), "an empty card: the relay ends it");
        assert!(c.tick(T0 + 9.0 * 3600.0).is_empty());
    }

    #[test]
    fn a_run_that_never_ends_is_forgotten_after_a_long_silence() {
        let mut c = standard();
        only(&c.on_event(&tool("s1", "sleep"), T0));
        let (_, card) = only(&c.tick(T0 + QUIET_RUN + 60.0));
        assert!(card.chats.is_empty(), "quiet: no longer shown as working");
        c.tick(T0 + FORGET_RUN + 120.0);
        assert!(c.runs.is_empty(), "a run whose end was never heard does not stay forever");
    }

    #[test]
    fn a_chat_waiting_on_the_phone_stays_however_long_it_waits() {
        let mut c = standard();
        let approval =
            ev("tool_approval_required", "s1", json!({ "call": { "id": "c9", "name": "bash", "input": {} } }));
        only(&c.on_event(&approval, T0));
        let q = ev("question", "s2", json!({ "request": { "questions": [{ "question": "Which?" }] } }));
        only(&c.on_event(&q, T0 + 1.0));
        assert!(c.tick(T0 + QUIET_RUN + 60.0).is_empty(), "31 minutes waiting: still on the card, unchanged");
        // A quiet working run does leave.
        let mut c = standard();
        only(&c.on_event(&tool("s1", "sleep"), T0));
        assert!(only(&c.tick(T0 + QUIET_RUN + 60.0)).1.chats.is_empty());
    }

    #[test]
    fn the_chat_list_is_read_again_while_a_card_is_up_and_on_a_level_change() {
        let mut c = standard();
        c.wants_summaries();
        only(&c.set_summaries(&json!([{ "id": "w", "title": "Ship it", "activeWatchCount": 1 }]), T0));
        assert!(!c.wants_summaries());
        c.tick(T0 + 30.0);
        assert!(!c.wants_summaries());
        c.tick(T0 + RECHECK);
        assert!(c.wants_summaries(), "a watch may have ended or a chat been renamed");
        c.tick(T0 + RECHECK + 1.0);
        assert!(!c.wants_summaries(), "once a minute");
        // The watch was cancelled: the card ends.
        let (_, card) = only(&c.set_summaries(&json!([{ "id": "w", "title": "Ship it" }]), T0 + RECHECK + 2.0));
        assert!(card.chats.is_empty());
        c.tick(T0 + 10.0 * RECHECK);
        assert!(!c.wants_summaries(), "no card up: nothing to refresh");
        c.set("phone-1", &json!([{ "level": "detailed" }]), T0 + 10.0 * RECHECK);
        assert!(c.wants_summaries(), "a new level reads the list again");
        c.set("phone-1", &json!([{ "focus": "w" }]), T0 + 10.0 * RECHECK);
        assert!(!c.wants_summaries(), "a focus is no level change");
    }

    #[test]
    fn a_new_relay_connection_gets_the_card_again() {
        let mut c = standard();
        only(&c.on_event(&tool("s1", "ls"), T0));
        c.reconnected();
        let (ty, card) = only(&c.tick(T0 + 1.0));
        assert_eq!((ty.as_str(), card.chats.len()), ("card", 1));
        assert!(c.tick(T0 + 2.0).is_empty(), "once");
    }

    #[test]
    fn a_stopped_run_is_done_not_failed() {
        let mut c = standard();
        let (_, card) = only(&c.on_event(&ev("error", "s1", json!({ "message": "Stopped" })), T0));
        assert_eq!((card.chats[0].state, card.chats[0].step.as_str()), (LiveChatState::Done, "Stopped"));
    }

    #[test]
    fn a_card_starts_remotely_for_a_chat_the_phone_sent_to_or_a_pr_watch_woke() {
        let mut c = standard();
        c.phone_call("chat:send", &json!([{ "sessionId": "s1", "text": "go" }]), T0);
        c.phone_call("chat:queue", &json!(["s3", { "text": "later" }]), T0 - 3.0 * 3600.0);
        c.phone_call("chat:queue", &json!(["s4", { "text": "next" }]), T0 - 1.0);
        c.phone_call("sessions:list", &json!([{ "sessionId": "s9" }]), T0);
        // A run in a chat this phone never sent to: an update for a card already up, no start.
        let (ty, _) = only(&c.on_event(&tool("s2", "ls"), T0 + 1.0));
        assert_eq!(ty, "card");
        let (ty, _) = only(&c.on_event(&ev("done", "s2", json!({})), T0 + 2.0));
        assert_eq!(ty, "card");
        // The relay knows which phones have a card up: it starts one only where none is.
        assert_eq!(only(&c.on_event(&tool("s1", "ls"), T0 + 3.0)).0, "card-start");
        // The same run carrying on is an update.
        assert!(c.on_event(&tool("s1", "pwd"), T0 + 4.0).is_empty());
        assert_eq!(only(&c.tick(T0 + 14.0)).0, "card");
        let mut c = standard();
        c.phone_call("chat:send", &json!([{ "sessionId": "s1", "text": "go" }]), T0);
        assert_eq!(only(&c.on_event(&tool("s1", "ls"), T0 + 2.0 * 3600.0 - 1.0)).0, "card-start");
        let mut c = standard();
        c.phone_call("chat:send", &json!([{ "sessionId": "s1", "text": "go" }]), T0);
        assert_eq!(only(&c.on_event(&tool("s1", "ls"), T0 + 2.0 * 3600.0 + 1.0)).0, "card", "two hours on");
        let mut c = standard();
        c.phone_call("chat:queue", &json!(["s4", { "text": "next" }]), T0);
        assert_eq!(only(&c.on_event(&ev("text", "s4", json!({ "delta": "Hi" })), T0 + 1.0)).0, "card-start");
        // A PR watch: the chat list says the chat is watching when its run starts.
        let mut c = standard();
        c.set_summaries(&json!([{ "id": "w", "title": "Ship it", "activeWatchCount": 1 }]), T0);
        let (ty, card) = only(&c.on_event(&tool("w", "gh pr checks"), T0 + 1.0));
        assert_eq!((ty.as_str(), card.chats[0].state), ("card-start", LiveChatState::Working));
    }

    #[test]
    fn a_watching_chat_is_on_the_card() {
        let mut c = standard();
        let (_, card) = only(&c.set_summaries(&json!([{ "id": "w", "title": "Ship it", "activeWatchCount": 1 }]), T0));
        assert_eq!((card.chats[0].state, card.chats[0].step.as_str()), (LiveChatState::Watching, "Watching PR…"));
    }

    #[test]
    fn focus_and_dismiss_from_the_phone() {
        let mut c = standard();
        only(&c.on_event(&tool("a", "ls"), T0));
        // A chat the list has not caught up with yet: newest first.
        let (_, card) = only(&c.on_event(&tool("b", "ls"), T0 + 1.0));
        assert_eq!(card.focus_id.as_deref(), Some("b"));
        let (_, card) = only(&c.set("phone-1", &json!([{ "focus": "a" }]), T0 + 2.0));
        assert_eq!(card.focus_id.as_deref(), Some("a"));
        only(&c.on_event(&ev("done", "b", json!({})), T0 + 3.0));
        let (_, card) = only(&c.set("phone-1", &json!([{ "dismiss": "b" }]), T0 + 4.0));
        assert_eq!(card.chats.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(card.focus_id.as_deref(), Some("a"));
        // Off the card until it runs again.
        let (_, card) = only(&c.on_event(&tool("b", "ls"), T0 + 5.0));
        assert_eq!(card.chats.len(), 2);
    }

    #[test]
    fn a_question_needs_you_with_its_text() {
        let mut c = standard();
        let q = ev(
            "question",
            "s1",
            json!({ "request": { "callId": "q1", "questions": [{ "question": "Which branch?" }] } }),
        );
        let (_, card) = only(&c.on_event(&q, T0));
        assert_eq!((card.chats[0].state, card.chats[0].step.as_str()), (LiveChatState::NeedsYou, "Which branch?"));
    }

    #[test]
    fn tool_label() {
        let call = |name: &str, input: Value| json!({ "id": "1", "name": name, "input": input });
        assert_eq!(super::tool_label(&call("read_file", json!({ "path": " src/a.rs " }))), "Read src/a.rs");
        assert_eq!(super::tool_label(&call("my_tool", json!({}))), "my tool");
        assert_eq!(super::tool_label(&call("web_search", json!({ "query": "a\n  b" }))), "Search the web for a b");
    }
}
