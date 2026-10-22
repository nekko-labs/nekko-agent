//! The Rust accounting against the TS functions.
//!
//! `golden/expected.json` is written by `packages/host/src/usage.golden.test.ts`
//! (UPDATE_GOLDEN=1), inputs and outputs side by side; every input runs
//! through the port and must print exactly what the TS printed (as
//! `JSON.stringify` would, key order included).

use nekko_usage::{
    LimitsError, Problem, Tokens, UsageFiles, classify_limits_error, estimate_cost, limits_backoff_ms,
    parse_chatgpt_usage, parse_openrouter_key, parse_retry_after, quota_history_record, side_usage_record,
    turn_reply_record, turn_usage_record, usage_summary,
};
use serde_json::{Value, json};
use std::path::Path;

fn expected() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn cases<'a>(all: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = all.pointer(key).and_then(Value::as_array).unwrap_or_else(|| panic!("no {key} cases"));
    assert!(!list.is_empty(), "no {key} cases");
    list
}

/// The same text `JSON.stringify` prints for both.
fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

fn now(all: &Value) -> f64 {
    all["now"].as_f64().unwrap()
}

fn opt_num(v: Option<f64>) -> Value {
    v.map_or(Value::Null, nekko_usage::num)
}

#[test]
fn cost_estimates_match() {
    let all = expected();
    for (i, c) in cases(&all, "/costs").iter().enumerate() {
        let u = &c["usage"];
        let tokens = Tokens {
            input: u.get("inputTokens"),
            output: u.get("outputTokens"),
            cache_read: u.get("cacheReadTokens"),
            cache_write: u.get("cacheWriteTokens"),
            subscription: u.get("auth") == Some(&json!("subscription")),
        };
        let got = estimate_cost(Some(&c["modelId"]), tokens).unwrap();
        same(&opt_num(got), &c["output"], &format!("cost case {i}: {c}"));
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

#[test]
fn usage_summaries_match() {
    let all = expected();
    for c in cases(&all, "/summaries") {
        let files =
            UsageFiles { settings: text(&c["settings"]), usage: text(&c["usage"]), replies: text(&c["replies"]) };
        let got = usage_summary(&files).unwrap();
        same(&got, &c["output"], &format!("summary {}", c["name"]));
    }
}

#[test]
fn summaries_read_the_files_from_a_data_directory() {
    let all = expected();
    let c = cases(&all, "/summaries").iter().find(|c| c["name"] == "usage and replies together").unwrap();
    let dir = std::env::temp_dir().join(format!("nekko-usage-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for (name, key) in [("settings.json", "settings"), ("usage.jsonl", "usage"), ("replies.jsonl", "replies")] {
        std::fs::write(dir.join(name), c[key].as_str().unwrap()).unwrap();
    }
    let got = usage_summary(&UsageFiles::read(&dir)).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    same(&got, &c["output"], "summary from disk");
}

#[test]
fn a_record_without_a_valid_date_fails_the_summary_as_in_ts() {
    let files = UsageFiles {
        usage: Some(r#"{"providerId":"p","modelId":"gpt-4o","inputTokens":1,"outputTokens":1}"#.into()),
        ..Default::default()
    };
    assert!(usage_summary(&files).is_err());
    let files = UsageFiles { replies: Some("null\n".into()), ..Default::default() };
    assert!(usage_summary(&files).is_err());
}

#[test]
fn log_lines_match() {
    let all = expected();
    for (i, c) in cases(&all, "/usageLines").iter().enumerate() {
        let inp = &c["input"];
        let got = turn_usage_record(&inp["opts"], &inp["provider"], &inp["event"], inp["ts"].as_u64().unwrap());
        assert_eq!(nekko_js::stringify(&got), c["output"].as_str().unwrap(), "usage line {i}");
    }
    for (i, c) in cases(&all, "/replyLines").iter().enumerate() {
        let inp = &c["input"];
        let finished = Some(&inp["finished"]).filter(|f| !f.is_null());
        let got = turn_reply_record(
            &inp["opts"],
            inp["incognito"] == json!(true),
            inp["startedAt"].as_u64().unwrap(),
            &inp["event"],
            finished,
            inp["ts"].as_u64().unwrap(),
        );
        assert_eq!(got.map(|v| nekko_js::stringify(&v)), text(&c["output"]), "reply line {i}");
    }
    for (i, c) in cases(&all, "/sideLines").iter().enumerate() {
        let inp = &c["input"];
        let opt = |k: &str| Some(&inp[k]).filter(|v| !v.is_null());
        let got = side_usage_record(
            &inp["provider"],
            opt("modelId"),
            opt("sessionId"),
            &inp["item"],
            inp["ts"].as_u64().unwrap(),
        );
        assert_eq!(nekko_js::stringify(&got), c["output"].as_str().unwrap(), "side line {i}");
    }
    for (i, c) in cases(&all, "/quota").iter().enumerate() {
        let inp = &c["input"];
        let got = quota_history_record(
            inp["providers"].as_array().unwrap(),
            inp["tokenKey"].as_str().unwrap(),
            inp["source"].as_str().unwrap(),
            &inp["limits"],
        );
        assert_eq!(got.map(|v| nekko_js::stringify(&v)), text(&c["output"]), "quota line {i}");
    }
}

#[test]
fn limit_parsers_match() {
    let all = expected();
    let now = now(&all);
    for (i, c) in cases(&all, "/limits/chatgpt").iter().enumerate() {
        same(&parse_chatgpt_usage(c["input"].as_object().unwrap(), now), &c["output"], &format!("chatgpt {i}"));
    }
    for (i, c) in cases(&all, "/limits/openrouter").iter().enumerate() {
        let body = Some(&c["input"]).filter(|v| !v.is_null());
        let got = match parse_openrouter_key(body, 200, now) {
            Ok(v) => v,
            Err(e) => json!({ "error": { "kind": e.kind, "status": e.status } }),
        };
        same(&got, &c["output"], &format!("openrouter {i}"));
    }
    for (i, c) in cases(&all, "/limits/retryAfter").iter().enumerate() {
        same(&opt_num(parse_retry_after(c["input"].as_str(), now)), &c["output"], &format!("retry-after {i}"));
    }
    for (i, c) in cases(&all, "/limits/classify").iter().enumerate() {
        let inp = &c["input"];
        let problem = match inp.get("message") {
            Some(m) => Problem::Message(m.as_str().unwrap().into()),
            None => Problem::Read(LimitsError {
                kind: match inp["limits"].as_str().unwrap() {
                    "rate_limited" => "rate_limited",
                    "http" => "http",
                    "auth_expired" => "auth_expired",
                    other => panic!("{other}"),
                },
                status: inp["status"].as_u64().map(|s| s as u16),
                retry_after_ms: inp["retryAfterMs"].as_f64(),
            }),
        };
        let e = classify_limits_error(&problem);
        let mut got = json!({ "kind": e.kind });
        if let Some(s) = e.status {
            got["status"] = json!(s);
        }
        if let Some(r) = e.retry_after_ms {
            got["retryAfterMs"] = nekko_usage::num(r);
        }
        same(&got, &c["output"], &format!("classify {i}"));
    }
    for (i, c) in cases(&all, "/limits/backoff").iter().enumerate() {
        let got = limits_backoff_ms(c["input"]["failures"].as_f64().unwrap(), c["input"]["retryAfterMs"].as_f64());
        same(&nekko_usage::num(got), &c["output"], &format!("backoff {i}"));
    }
}
