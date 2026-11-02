//! `summarizeSession` (packages/shared/src/session-summary.ts), ported.
//!
//! A summary is what every list in the app draws from: the session's own fields
//! without its transcript, plus a few facts dug out of the transcript. It must
//! equal the TS host's output exactly, because the renderer cannot tell which
//! side produced it and both sides serve it during the migration; the golden
//! test (`tests/golden.rs`) compares this against summaries the TS function
//! wrote. Each helper below names the TS function it follows.

use nekko_js as js;
use serde_json::{Map, Value, json};

/// `SUMMARY_TURNS`.
const SUMMARY_TURNS: usize = 8;
/// `SUMMARY_TURN_CHARS`.
const SUMMARY_TURN_CHARS: usize = 4_000;
/// `FIRST_PROMPT_CHARS`.
const FIRST_PROMPT_CHARS: usize = 2_000;
/// `LAST_REPLY_CHARS`.
const LAST_REPLY_CHARS: usize = 200;

fn str_field<'a>(m: &'a Value, key: &str) -> &'a str {
    m.get(key).and_then(Value::as_str).unwrap_or("")
}

fn role(m: &Value) -> &str {
    str_field(m, "role")
}

/// `historyText` (context.ts).
fn history_text(m: &Value) -> String {
    let mut parts: Vec<String> = vec![str_field(m, "content").to_string()];
    if let Some(calls) = m.get("toolCalls").and_then(Value::as_array) {
        for call in calls {
            parts.push(str_field(call, "name").to_string());
            // `call.input !== undefined`: a stored null is still serialized.
            if let Some(input) = call.get("input") {
                parts.push(js::stringify(input));
            }
        }
    }
    let result = m.get("toolResult").and_then(|r| r.get("output")).and_then(Value::as_str).unwrap_or("");
    if !result.is_empty() {
        parts.push(result.to_string());
    }
    parts.retain(|p| !p.is_empty());
    parts.join("\n")
}

/// `estimateTranscriptTokens` (context.ts): a quarter token per UTF-16 unit,
/// counted from the latest compaction summary (`sinceCompaction`).
fn transcript_tokens(all: &[Value]) -> u64 {
    let messages = match all.iter().rposition(|m| js::truthy(m.get("compaction"))) {
        Some(at) => &all[at..],
        None => all,
    };
    if messages.is_empty() {
        return 0;
    }
    let units: usize = messages.iter().map(|m| js::len16(&history_text(m))).sum::<usize>() + messages.len() - 1;
    (units.div_ceil(4)).max(1) as u64
}

/// `extractPrUrls` (pr.ts): `https?://github.com/<owner>/<repo>/pull/<n>`, each once.
fn pr_urls_in(text: &str, out: &mut Vec<String>) {
    let b = text.as_bytes();
    let seg = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'-';
    let mut i = 0;
    while i < b.len() {
        let rest = &b[i..];
        let scheme = if rest.starts_with(b"https://github.com/") {
            19
        } else if rest.starts_with(b"http://github.com/") {
            18
        } else {
            i += 1;
            continue;
        };
        let mut j = i + scheme;
        let owner = j;
        while j < b.len() && seg(b[j]) {
            j += 1;
        }
        let ok_owner = j > owner && j < b.len() && b[j] == b'/';
        let mut matched = None;
        if ok_owner {
            j += 1;
            let repo = j;
            while j < b.len() && seg(b[j]) {
                j += 1;
            }
            if j > repo && b[j..].starts_with(b"/pull/") {
                j += 6;
                let digits = j;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j > digits {
                    matched = Some(j);
                }
            }
        }
        match matched {
            Some(end) => {
                let url = &text[i..end];
                if !out.iter().any(|u| u == url) {
                    out.push(url.to_string());
                }
                i = end;
            }
            None => i += 1,
        }
    }
}

/// `collectSessionPrUrls` (pr.ts).
fn pr_urls(messages: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for m in messages {
        let Some(result) = m.get("toolResult") else { continue };
        if js::truthy(result.get("isError")) {
            continue;
        }
        let id = str_field(result, "toolCallId");
        let call = messages
            .iter()
            .flat_map(|m| m.get("toolCalls").and_then(Value::as_array).into_iter().flatten())
            .find(|c| str_field(c, "id") == id && str_field(c, "name") == "bash");
        let Some(call) = call else { continue };
        let command = call.get("input").map(|i| str_field(i, "command")).unwrap_or("").trim();
        if !command.starts_with("gh ") || command.contains(['\r', '\n', ';', '&', '|', '`']) {
            continue;
        }
        let words: Vec<_> = command.split_whitespace().collect();
        let cli = words.get(..3) == Some(&["gh", "pr", "create"][..]);
        let api = words
            .get(..3)
            .is_some_and(|w| w[0] == "gh" && w[1] == "api" && w[2].starts_with("repos/") && w[2].ends_with("/pulls"))
            && words.windows(2).any(|w| (w[0] == "-X" || w[0] == "--method") && w[1] == "POST");
        if !cli && !api {
            continue;
        }
        let line = str_field(result, "output").trim();
        let mut urls = Vec::new();
        pr_urls_in(line, &mut urls);
        if urls.len() == 1 && urls[0] == line && !out.contains(&urls[0]) {
            out.push(urls.remove(0));
        }
    }
    out
}

/// A JavaScript template-literal rendering of a JSON number (`${n}`).
fn num_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) => js::stringify(&Value::Number(n.clone())),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".into(),
        Some(other) => js::stringify(other),
        None => "undefined".into(),
    }
}

/// `recentTurns` (session-board.ts), then the summary's per-turn cap.
fn recent_turns(messages: &[Value], limit: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages.iter().rev() {
        if out.len() >= limit {
            break;
        }
        let r = role(m);
        if r != "user" && r != "assistant" {
            continue;
        }
        let text = js::trim(str_field(m, "content"));
        let has_images = m.get("images").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
        let generated = if r == "assistant" && has_images { m.get("generated").filter(|g| !g.is_null()) } else { None };
        if text.is_empty() && generated.is_none() {
            continue;
        }
        let text = if text.is_empty() {
            let g = generated.expect("checked above");
            format!("{}×{} image", num_text(g.get("width")), num_text(g.get("height")))
        } else {
            text.to_string()
        };
        let mut t = Map::new();
        if let Some(id) = m.get("id") {
            t.insert("id".into(), id.clone());
        }
        t.insert("role".into(), json!(r));
        t.insert("text".into(), json!(js::cap(&text, SUMMARY_TURN_CHARS)));
        if let Some(at) = m.get("createdAt") {
            t.insert("at".into(), at.clone());
        }
        if js::truthy(m.get("interrupted")) {
            t.insert("interrupted".into(), json!(true));
        }
        if let Some(g) = generated {
            let mut image = Map::new();
            for key in ["width", "height", "seed"] {
                if let Some(v) = g.get(key) {
                    image.insert(key.into(), v.clone());
                }
            }
            t.insert("image".into(), Value::Object(image));
        }
        out.push(Value::Object(t));
    }
    out.reverse();
    out
}

/// `summarizeSession`. `None` where the TS function would throw (no
/// transcript array), which the TS lister also skips.
pub fn summarize(session: &Value) -> Option<Value> {
    let obj = session.as_object()?;
    let messages = obj.get("messages")?.as_array()?;
    let mut out = Map::new();
    for (k, v) in obj {
        if k != "messages" {
            out.insert(k.clone(), v.clone());
        }
    }
    let exchange = messages.iter().filter(|m| matches!(role(m), "user" | "assistant")).count();
    let first_user = messages.iter().find(|m| role(m) == "user");
    let mut last_reply = None;
    let mut last_reply_at: Option<&Value> = None;
    for m in messages.iter().rev() {
        if role(m) != "assistant" {
            continue;
        }
        if last_reply_at.is_none() {
            last_reply_at = m.get("createdAt");
        }
        if !js::trim(str_field(m, "content")).is_empty() {
            last_reply = Some(m);
            break;
        }
    }
    out.insert("messageCount".into(), json!(messages.len()));
    out.insert("exchangeCount".into(), json!(exchange));
    if let Some(u) = first_user {
        out.insert("firstUserText".into(), json!(js::cap(str_field(u, "content"), FIRST_PROMPT_CHARS)));
    }
    if let Some(r) = last_reply {
        let folded = js::fold_space(js::trim(str_field(r, "content")));
        out.insert("lastReplyText".into(), json!(js::cap(&folded, LAST_REPLY_CHARS)));
    }
    if let Some(at) = last_reply_at {
        out.insert("lastReplyAt".into(), at.clone());
    }
    out.insert("transcriptTokens".into(), json!(transcript_tokens(messages)));
    let stalled = messages.last().is_some_and(|m| role(m) == "assistant" && js::truthy(m.get("interrupted")));
    out.insert("stalled".into(), json!(stalled));
    out.insert("recentTurns".into(), Value::Array(recent_turns(messages, SUMMARY_TURNS)));
    out.insert("prUrls".into(), json!(pr_urls(messages)));
    let images: usize = messages
        .iter()
        .filter(|m| role(m) == "assistant" && js::truthy(m.get("generated")))
        .map(|m| m.get("images").and_then(Value::as_array).map_or(0, Vec::len))
        .sum();
    out.insert("imageCount".into(), json!(images));
    if let Some(phase) = crate::phase::loop_phase(messages) {
        out.insert("phase".into(), json!(phase));
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_pr_urls_once_and_stops_at_the_number() {
        let mut out = Vec::new();
        pr_urls_in(
            "see (https://github.com/o/r/pull/7). and http://github.com/a.b/c-d/pull/12x https://github.com/o/r/pull/7 https://github.com/o/pull/3",
            &mut out,
        );
        assert_eq!(out, vec!["https://github.com/o/r/pull/7", "http://github.com/a.b/c-d/pull/12"]);
    }
    #[test]
    fn only_created_prs_attach() {
        let url = "https://github.com/o/r/pull/1";
        let messages = vec![
            serde_json::json!({"role":"assistant","content":url}),
            serde_json::json!({"toolCalls":[{"id":"c","name":"bash","input":{"command":"gh pr create"}}]}),
            serde_json::json!({"toolResult":{"toolCallId":"c","output":url}}),
        ];
        assert_eq!(pr_urls(&messages), vec![url]);
        assert!(pr_urls(&messages[..1]).is_empty());
    }
}
