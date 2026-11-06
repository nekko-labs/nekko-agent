//! The `decide` tool's request: `decideRequestFromTool`
//! (`packages/core/src/agent/tools.ts`) and `checkDecisionRequest`
//! (`packages/host/src/engine/decisions.ts`). The request is the decision
//! model's input, so its key order is JavaScript's: insertion order, with
//! integer-like keys first in numeric order.

use serde_json::{Map, Value, json};

const MAX_STATE_CHARS: usize = 50_000;
const MAX_QUESTIONS: usize = 64;

/// An object built key by key as JavaScript builds one: a repeated key keeps
/// its first place and takes the last value; integer-like keys come first.
fn js_object(entries: Vec<(String, Value)>) -> Map<String, Value> {
    let mut order: Vec<(String, Value)> = Vec::new();
    for (k, v) in entries {
        match order.iter_mut().find(|(o, _)| *o == k) {
            Some(slot) => slot.1 = v,
            None => order.push((k, v)),
        }
    }
    let (mut indexed, rest): (Vec<_>, Vec<_>) =
        order.into_iter().partition(|(k, _)| nekko_js::array_index(k).is_some());
    indexed.sort_by_key(|(k, _)| nekko_js::array_index(k));
    indexed.into_iter().chain(rest).collect()
}

/// `String(v ?? '')` for an option label.
fn label_of(o: &Value) -> String {
    match o {
        Value::Object(m) => {
            let pick = ["label", "name", "value"].iter().find_map(|k| m.get(*k).filter(|v| !v.is_null()));
            pick.map(nekko_js::display).unwrap_or_default()
        }
        Value::Array(_) => String::new(),
        Value::Null => String::new(),
        other => nekko_js::display(other),
    }
}

/// An option's description, when it is a string.
fn desc_of(o: &Value) -> Option<&str> {
    match o {
        Value::Object(m) => m.get("description").and_then(Value::as_str),
        _ => None,
    }
}

/// `decideRequestFromTool(input)`: the tool's flat question list as the
/// decision API's named questions.
pub fn decide_request_from_tool(input: &Value) -> Value {
    let get = |k: &str| input.as_object().and_then(|m| m.get(k));
    let state = match get("state") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "\"\"".to_string(),
        Some(v) => nekko_js::stringify(v),
    };
    let list = get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut entries = Vec::new();
    for (n, q) in list.iter().enumerate() {
        let item = |k: &str| q.as_object().and_then(|m| m.get(k));
        let id = match item("id") {
            Some(Value::String(s)) if !nekko_js::trim(s).is_empty() => nekko_js::trim(s).to_string(),
            _ => format!("q{}", n + 1),
        };
        let ty = item("type")
            .and_then(Value::as_str)
            .filter(|t| matches!(*t, "choice" | "score" | "noul"))
            .unwrap_or("noul");
        let instructions = match (item("instructions"), item("question")) {
            (Some(Value::String(s)), _) => s.clone(),
            (_, Some(Value::String(s))) => s.clone(),
            _ => String::new(),
        };
        let raw = match (item("options"), item("criteria")) {
            (Some(Value::Array(a)), _) => Some(a),
            (_, Some(Value::Array(a))) => Some(a),
            _ => None,
        };
        let labels: Vec<String> =
            raw.map(|r| r.iter().map(label_of).filter(|l| !l.is_empty()).collect()).unwrap_or_default();
        let described = ty == "choice" && raw.is_some_and(|r| r.iter().any(|o| desc_of(o).is_some()));
        let criteria = if labels.is_empty() || ty == "noul" {
            None
        } else if described {
            let pairs: Vec<(String, Value)> = raw
                .into_iter()
                .flatten()
                .map(|o| {
                    let label = label_of(o);
                    let value = desc_of(o).map(str::to_string).unwrap_or_else(|| label.clone());
                    (label, json!(value))
                })
                .filter(|(k, _)| !k.is_empty())
                .collect();
            Some(Value::Object(js_object(pairs)))
        } else {
            Some(json!(labels))
        };
        let mut question = Map::new();
        question.insert("type".into(), json!(ty));
        question.insert("instructions".into(), json!(instructions));
        if let Some(c) = criteria {
            question.insert("criteria".into(), c);
        }
        entries.push((id, Value::Object(question)));
    }
    json!({ "state": state, "questions": Value::Object(js_object(entries)) })
}

/// `n.toLocaleString('en-US')` for a whole number.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `checkDecisionRequest(request)`: why the request cannot be asked, if it cannot.
pub fn check_decision_request(request: &Value) -> Option<String> {
    let Some(m) = request.as_object() else { return Some("Send a state and at least one question.".into()) };
    let state = match m.get("state") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "\"\"".to_string(),
        Some(v) => nekko_js::stringify(v),
    };
    if nekko_js::trim(&state).is_empty() {
        return Some("The state is empty.".into());
    }
    if nekko_js::len16(&state) > MAX_STATE_CHARS {
        return Some(format!("The state is over {} characters.", grouped(MAX_STATE_CHARS)));
    }
    let questions = m.get("questions").and_then(Value::as_object).map_or(0, Map::len);
    if questions == 0 {
        return Some("Ask at least one question.".into());
    }
    if questions > MAX_QUESTIONS {
        return Some(format!("Ask at most {MAX_QUESTIONS} questions at once."));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_group_as_en_us() {
        assert_eq!(grouped(50_000), "50,000");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_234_567), "1,234,567");
    }
}
