//! The vault: each private value gets a placeholder (`[PII_EMAIL_1]`) the
//! first time it is seen, and keeps it for as long as the shield lives, so a
//! value reads the same in every message of a request and in every request
//! of a reply. What a model sends back has its placeholders put back
//! ([`Shield::restore`]), so tools run on the real values and the transcript
//! on disk keeps them: only the request on the wire carries placeholders.

use crate::detect::{Kind, scan};
use crate::policy::Policy;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Every placeholder starts with this, so a reader can find them cheaply.
pub const TOKEN_PREFIX: &str = "[PII_";

/// The longest placeholder a stream may be holding back mid-token.
const TOKEN_MAX: usize = 40;

/// What the system prompt gains while a shield is on, so the model treats a
/// placeholder as a value and passes it through rather than asking about it.
pub const SYSTEM_NOTE: &str = "\n\n## Private values\n\
Some values in this conversation were replaced on the user's computer before it reached you, as placeholders \
like [PII_EMAIL_1], [PII_USER_1] or [PII_SECRET_1]. Treat each one as the real value: use it verbatim in replies, \
file contents, paths and tool arguments, and the user's computer swaps the real value back in before anything \
runs or is shown. Do not ask what a placeholder stands for, and do not invent a different value for it.";

/// One value the shield replaced: what it was, what the model saw instead,
/// and how many times it was replaced.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub kind: Kind,
    pub value: String,
    pub token: String,
    pub count: u64,
}

#[derive(Default)]
pub struct Shield {
    policy: Policy,
    /// (kind, value) -> placeholder.
    tokens: HashMap<(Kind, String), String>,
    /// placeholder -> value.
    values: HashMap<String, String>,
    next: HashMap<Kind, u32>,
    /// Placeholder-shaped text already in the chat (a file about this very
    /// feature, say): never handed out, so restoring cannot rewrite it.
    reserved: HashSet<String>,
    counts: HashMap<String, u64>,
    order: Vec<String>,
}

fn label_of(token: &str) -> Option<&str> {
    let inner = token.strip_prefix(TOKEN_PREFIX)?.strip_suffix(']')?;
    let (label, n) = inner.rsplit_once('_')?;
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && !label.is_empty()).then_some(label)
}

/// The placeholder-shaped tokens in `text`, with their byte ranges.
fn tokens_in(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(TOKEN_PREFIX) {
        let start = from + at;
        let rest = &text[start..];
        let end = rest
            .char_indices()
            .take_while(|(i, _)| *i <= TOKEN_MAX)
            .find(|(i, c)| *i > 0 && !(c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_'))
            .filter(|(_, c)| *c == ']')
            .map(|(i, _)| start + i + 1);
        match end {
            Some(end) if label_of(&text[start..end]).is_some() => {
                out.push((start, end));
                from = end;
            }
            _ => from = start + 1,
        }
    }
    out
}

impl Shield {
    pub fn new(policy: Policy) -> Self {
        Self { policy, ..Default::default() }
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    fn token_for(&mut self, kind: Kind, value: &str) -> String {
        if let Some(t) = self.tokens.get(&(kind, value.to_string())) {
            return t.clone();
        }
        let token = loop {
            let n = self.next.entry(kind).or_insert(0);
            *n += 1;
            let t = format!("{TOKEN_PREFIX}{}_{n}]", kind.label());
            if !self.reserved.contains(&t) {
                break t;
            }
        };
        self.tokens.insert((kind, value.to_string()), token.clone());
        self.values.insert(token.clone(), value.to_string());
        self.order.push(token.clone());
        token
    }

    /// Note placeholder-shaped text that is really in the chat, before any
    /// placeholder is handed out.
    pub fn reserve(&mut self, text: &str) {
        for (s, e) in tokens_in(text) {
            if !self.values.contains_key(&text[s..e]) {
                self.reserved.insert(text[s..e].to_string());
            }
        }
    }

    /// `text` with every private value the policy covers swapped for its placeholder.
    pub fn redact(&mut self, text: &str) -> String {
        let spans = {
            let policy = &self.policy;
            scan(text, &|k| policy.covers(k), &policy.usernames, &policy.terms)
        };
        if spans.is_empty() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for span in spans {
            let value = &text[span.start..span.end];
            out.push_str(&text[last..span.start]);
            if self.policy.allows(value) {
                out.push_str(value);
            } else {
                let token = self.token_for(span.kind, value);
                *self.counts.entry(token.clone()).or_default() += 1;
                out.push_str(&token);
            }
            last = span.end;
        }
        out.push_str(&text[last..]);
        out
    }

    /// Every string in a JSON value (tool arguments), redacted in place.
    pub fn redact_value(&mut self, v: &mut Value) {
        match v {
            Value::String(s) => *s = self.redact(s),
            Value::Array(a) => a.iter_mut().for_each(|x| self.redact_value(x)),
            Value::Object(o) => o.values_mut().for_each(|x| self.redact_value(x)),
            _ => {}
        }
    }

    /// A transcript message (`ChatMessage` JSON) as the provider should see
    /// it: its text, its tool calls' arguments and its tool result's output.
    /// Ids, roles, images and metadata go as they are.
    pub fn redact_message(&mut self, m: &mut Value) {
        let Some(o) = m.as_object_mut() else { return };
        if let Some(Value::String(c)) = o.get_mut("content") {
            *c = self.redact(c);
        }
        if let Some(Value::Array(calls)) = o.get_mut("toolCalls") {
            for call in calls {
                if let Some(input) = call.get_mut("input") {
                    self.redact_value(input);
                }
            }
        }
        if let Some(Value::String(out)) = o.get_mut("toolResult").and_then(|r| r.get_mut("output")) {
            *out = self.redact(out);
        }
    }

    /// Reserve the placeholder-shaped text in a message (see [`Shield::reserve`]).
    pub fn reserve_message(&mut self, m: &Value) {
        let mut texts = Vec::new();
        collect_strings(m, &mut texts);
        for t in texts {
            self.reserve(&t);
        }
    }

    /// `text` with every placeholder this shield handed out swapped back.
    /// Placeholders it never handed out are left as they are.
    pub fn restore(&self, text: &str) -> String {
        if !text.contains(TOKEN_PREFIX) || self.values.is_empty() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for (s, e) in tokens_in(text) {
            if let Some(v) = self.values.get(&text[s..e]) {
                out.push_str(&text[last..s]);
                out.push_str(v);
                last = e;
            }
        }
        out.push_str(&text[last..]);
        out
    }

    pub fn restore_value(&self, v: &mut Value) {
        match v {
            Value::String(s) => *s = self.restore(s),
            Value::Array(a) => a.iter_mut().for_each(|x| self.restore_value(x)),
            Value::Object(o) => o.values_mut().for_each(|x| self.restore_value(x)),
            _ => {}
        }
    }

    /// What has been replaced so far, in the order first seen.
    pub fn findings(&self) -> Vec<Finding> {
        let by_token: HashMap<&String, &(Kind, String)> = self.tokens.iter().map(|(k, t)| (t, k)).collect();
        self.order
            .iter()
            .filter_map(|t| {
                let (kind, value) = by_token.get(t)?;
                Some(Finding {
                    kind: *kind,
                    value: value.clone(),
                    token: t.clone(),
                    count: self.counts.get(t).copied().unwrap_or(0),
                })
            })
            .collect()
    }

    /// Replacements per kind id, for a reply's stats.
    pub fn counts_by_kind(&self) -> BTreeMap<&'static str, u64> {
        let mut out = BTreeMap::new();
        for f in self.findings() {
            *out.entry(f.kind.id()).or_default() += f.count;
        }
        out
    }

    /// A streaming restorer for one response.
    pub fn restorer(&self) -> Restorer {
        Restorer::default()
    }
}

fn collect_strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) if s.contains(TOKEN_PREFIX) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| collect_strings(x, out)),
        Value::Object(o) => o.values().for_each(|x| collect_strings(x, out)),
        _ => {}
    }
}

/// Puts placeholders back in a streamed text whose deltas may cut a
/// placeholder in two (`"[PII_EM"`, `"AIL_1] wrote"`): a tail that could
/// still become one is held until the next delta settles it.
#[derive(Default)]
pub struct Restorer {
    pending: String,
}

/// Where the held-back tail starts: the last `[` that could still open a
/// placeholder, if it is near enough the end.
fn hold_from(s: &str) -> Option<usize> {
    let at = s.rfind('[')?;
    let tail = &s[at..];
    if tail.len() > TOKEN_MAX {
        return None;
    }
    let prefix_ok = if tail.len() <= TOKEN_PREFIX.len() {
        TOKEN_PREFIX.starts_with(tail)
    } else {
        tail.starts_with(TOKEN_PREFIX)
            && tail[TOKEN_PREFIX.len()..].bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    };
    prefix_ok.then_some(at)
}

impl Restorer {
    /// What of `delta` can be shown now, restored.
    pub fn push(&mut self, shield: &Shield, delta: &str) -> String {
        self.pending.push_str(delta);
        let restored = shield.restore(&self.pending);
        match hold_from(&restored) {
            Some(at) => {
                let ready = restored[..at].to_string();
                self.pending = restored[at..].to_string();
                ready
            }
            None => {
                self.pending.clear();
                restored
            }
        }
    }

    /// Whatever is still held, at the end of the text.
    pub fn flush(&mut self, shield: &Shield) -> String {
        shield.restore(&std::mem::take(&mut self.pending))
    }
}

/// What `privacy:preview` answers: what the next message would send, and
/// every value it and the chat so far would have replaced.
pub fn preview(policy: Policy, draft: &str, messages: &[Value]) -> Value {
    let mut shield = Shield::new(policy);
    shield.reserve(draft);
    for m in messages {
        shield.reserve_message(m);
    }
    for m in messages {
        let mut m = m.clone();
        shield.redact_message(&mut m);
    }
    let in_chat: HashSet<String> = shield.order.iter().cloned().collect();
    let sent = shield.redact(draft);
    let allowed = allowed_in(&shield, draft, messages);
    let findings: Vec<Value> = shield
        .findings()
        .into_iter()
        .map(|f| {
            let mut o = Map::new();
            o.insert("kind".into(), json!(f.kind.id()));
            o.insert("value".into(), json!(f.value));
            o.insert("token".into(), json!(f.token));
            o.insert("count".into(), json!(f.count));
            o.insert("inDraft".into(), json!(sent.contains(&f.token)));
            o.insert("inChat".into(), json!(in_chat.contains(&f.token)));
            Value::Object(o)
        })
        .collect();
    json!({
        "draft": sent,
        "findings": findings,
        "allowed": allowed,
    })
}

/// Values the user chose to send as they are that occur in this chat, so
/// the panel can offer to hide them again.
fn allowed_in(shield: &Shield, draft: &str, messages: &[Value]) -> Vec<Value> {
    let policy = shield.policy();
    if policy.allow.is_empty() {
        return Vec::new();
    }
    let mut texts = vec![draft.to_string()];
    for m in messages {
        let mut all = Vec::new();
        collect_all_strings(m, &mut all);
        texts.extend(all);
    }
    let unrestricted = Policy { allow: Vec::new(), ..policy.clone() };
    let mut seen = Vec::new();
    for text in &texts {
        for span in scan(text, &|k| unrestricted.covers(k), &unrestricted.usernames, &unrestricted.terms) {
            let value = &text[span.start..span.end];
            if policy.allows(value) && !seen.iter().any(|(_, v): &(Kind, String)| v == value) {
                seen.push((span.kind, value.to_string()));
            }
        }
    }
    seen.into_iter().map(|(k, v)| json!({ "kind": k.id(), "value": v })).collect()
}

fn collect_all_strings(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|x| collect_all_strings(x, out)),
        Value::Object(o) => {
            for (k, x) in o {
                if !matches!(k.as_str(), "id" | "role" | "images" | "toolCallId" | "createdAt") {
                    collect_all_strings(x, out);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shield() -> Shield {
        Shield::new(Policy { usernames: vec!["philip".into()], ..Policy::all() })
    }

    #[test]
    fn same_value_same_placeholder_and_back() {
        let mut s = shield();
        let a = s.redact("mail jane@example.com and jane@example.com, cc bob@example.com");
        assert_eq!(a, "mail [PII_EMAIL_1] and [PII_EMAIL_1], cc [PII_EMAIL_2]");
        assert_eq!(s.restore(&a), "mail jane@example.com and jane@example.com, cc bob@example.com");
        let f = s.findings();
        assert_eq!(f[0].count, 2);
        assert_eq!(f[1].value, "bob@example.com");
    }

    #[test]
    fn literal_placeholders_are_never_handed_out_or_rewritten() {
        let mut s = shield();
        s.reserve("docs mention [PII_EMAIL_1] as an example");
        let a = s.redact("docs mention [PII_EMAIL_1] as an example, mail jane@example.com");
        assert_eq!(a, "docs mention [PII_EMAIL_1] as an example, mail [PII_EMAIL_2]");
        assert_eq!(s.restore(&a), "docs mention [PII_EMAIL_1] as an example, mail jane@example.com");
    }

    #[test]
    fn allowed_values_go_as_they_are() {
        let mut s = Shield::new(Policy { allow: vec!["jane@example.com".into()], ..Policy::all() });
        assert_eq!(s.redact("jane@example.com bob@example.com"), "jane@example.com [PII_EMAIL_1]");
    }

    #[test]
    fn messages_redact_text_calls_and_results_only() {
        let mut s = shield();
        let mut m = json!({
            "id": "m1", "role": "assistant", "content": "writing to /Users/philip/a.txt",
            "toolCalls": [{ "id": "c1", "name": "write_file", "input": { "path": "/Users/philip/a.txt", "content": "jane@example.com" } }],
            "toolResult": { "toolCallId": "c1", "output": "wrote /Users/philip/a.txt" },
            "images": ["data:image/png;base64,AAAA"],
        });
        s.redact_message(&mut m);
        assert_eq!(m["content"], "writing to /Users/[PII_USER_1]/a.txt");
        assert_eq!(m["toolCalls"][0]["input"]["path"], "/Users/[PII_USER_1]/a.txt");
        assert_eq!(m["toolCalls"][0]["input"]["content"], "[PII_EMAIL_1]");
        assert_eq!(m["toolCalls"][0]["id"], "c1");
        assert_eq!(m["toolResult"]["output"], "wrote /Users/[PII_USER_1]/a.txt");
        assert_eq!(m["images"][0], "data:image/png;base64,AAAA");
    }

    #[test]
    fn a_stream_restores_placeholders_cut_across_deltas() {
        let mut s = shield();
        s.redact("jane@example.com");
        let mut r = s.restorer();
        let mut out = String::new();
        for d in ["Hi [", "PII_EM", "AIL_1", "] and [not a token] and [PII_", "X"] {
            out.push_str(&r.push(&s, d));
        }
        out.push_str(&r.flush(&s));
        assert_eq!(out, "Hi jane@example.com and [not a token] and [PII_X");
    }

    #[test]
    fn unknown_placeholders_stay() {
        let mut s = shield();
        s.redact("jane@example.com");
        assert_eq!(s.restore("[PII_EMAIL_9] [PII_EMAIL_1]"), "[PII_EMAIL_9] jane@example.com");
    }

    #[test]
    fn preview_lists_draft_and_chat_findings() {
        let policy = Policy { allow: vec!["ok@example.com".into()], ..Policy::all() };
        let messages = vec![json!({ "id": "1", "role": "user", "content": "from bob@example.com and ok@example.com" })];
        let p = preview(policy, "send to jane@example.com and bob@example.com", &messages);
        assert_eq!(p["draft"], "send to [PII_EMAIL_2] and [PII_EMAIL_1]");
        let f = p["findings"].as_array().unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["value"], "bob@example.com");
        assert_eq!(f[0]["inChat"], true);
        assert_eq!(f[0]["inDraft"], true);
        assert_eq!(f[1]["inChat"], false);
        assert_eq!(p["allowed"], json!([{ "kind": "email", "value": "ok@example.com" }]));
    }
}
