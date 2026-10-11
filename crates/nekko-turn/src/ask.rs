//! `parseAskRequest` and `formatAskAnswers` (packages/shared/src/ask.ts).

use nekko_js as js;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

const MAX_QUESTIONS: usize = 4;
const MAX_OPTIONS: usize = 5;

fn trimmed_str(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| js::trim(s).to_string()).unwrap_or_default()
}

/// Options as written, as plain strings, or as objects missing a label.
fn normalize_options(value: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(list)) = value else { return Vec::new() };
    let mut out = Vec::new();
    for o in list {
        if let Value::String(s) = o {
            let t = js::trim(s);
            if !t.is_empty() {
                out.push(json!({ "label": t }));
            }
            continue;
        }
        let label = trimmed_str(o.get("label"));
        if label.is_empty() {
            continue;
        }
        let description = trimmed_str(o.get("description"));
        let mut opt = Map::new();
        opt.insert("label".into(), json!(label));
        if !description.is_empty() {
            opt.insert("description".into(), json!(description));
        }
        out.push(Value::Object(opt));
    }
    out
}

/// `parseAskRequest(callId, input, now)`: the request, or the reason it cannot be read.
pub fn parse_ask_request(call_id: &str, input: &Value, now: u64) -> Result<Value, String> {
    let list = match input.get("questions") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => {
            return Err("ask_user needs a non-empty `questions` array. Each entry needs `header`, `question`, and 2 or more `options`.".into());
        }
    };
    let mut questions = Vec::new();
    for (i, q) in list.iter().take(MAX_QUESTIONS).enumerate() {
        let question = trimmed_str(q.get("question"));
        if question.is_empty() {
            return Err(format!("Question {} has no `question` text.", i + 1));
        }
        let options = normalize_options(q.get("options"));
        if options.len() < 2 {
            return Err(format!(
                "Question {} (\"{}\") needs at least 2 `options`. Ask a question worth a choice, or just do the work.",
                i + 1,
                js::slice16(&question, 40)
            ));
        }
        let header = match q.get("header").and_then(Value::as_str).map(js::trim) {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => js::slice16(&question, 24).to_string(),
        };
        let mut entry = Map::new();
        entry.insert("id".into(), json!(format!("q{}", i + 1)));
        entry.insert("header".into(), json!(header));
        entry.insert("question".into(), json!(question));
        entry.insert("options".into(), Value::Array(options.into_iter().take(MAX_OPTIONS).collect()));
        if q.get("multiSelect") == Some(&Value::Bool(true)) {
            entry.insert("multiSelect".into(), json!(true));
        }
        questions.push(Value::Object(entry));
    }
    Ok(json!({ "callId": call_id, "questions": questions, "askedAt": now }))
}

/// `formatAskAnswers(request, answers)`: the answers as the model reads them back.
pub fn format_ask_answers(request: &Value, answers: &Value) -> String {
    let mut by_id: HashMap<String, &Value> = HashMap::new();
    for a in answers.as_array().into_iter().flatten() {
        by_id.insert(a.get("questionId").map(js::display).unwrap_or_default(), a);
    }
    let lines: Vec<String> = request
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|q| {
            let a = q.get("id").and_then(Value::as_str).and_then(|id| by_id.get(id));
            let picked: Vec<String> = a
                .and_then(|a| a.get("labels"))
                .and_then(Value::as_array)
                .map(|l| l.iter().filter(|v| js::truthy(Some(v))).map(js::display).collect())
                .unwrap_or_default();
            let note = a.and_then(|a| a.get("note")).and_then(Value::as_str).map(js::trim).unwrap_or_default();
            let answer = [picked.join(", "), note.to_string()]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" \u{2014} ");
            let question = q.get("question").map(js::display).unwrap_or_default();
            format!("Q: {question}\nA: {}", if answer.is_empty() { "(not answered)" } else { &answer })
        })
        .collect();
    format!(
        "The user answered:\n\n{}\n\nWork to these answers. Do not ask again about anything settled here.",
        lines.join("\n\n")
    )
}
