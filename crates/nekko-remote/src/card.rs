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
}
