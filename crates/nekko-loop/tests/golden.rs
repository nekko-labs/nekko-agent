//! The Rust loop helpers against the TS ones.
//!
//! `golden/expected.json` is written by `packages/host/src/loop-helpers.golden.test.ts`
//! (UPDATE_GOLDEN=1) from `golden/cases.json`; this test runs the same cases
//! through the ports and must match every entry.

use nekko_loop::{
    RunawayGuard, RunawayOptions, as_seen_by_chat_model, from_latest_compaction, repair_interrupted_history,
    window_history, without_images,
};
use serde_json::{Value, json};
use std::path::Path;

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn options(v: &Value) -> RunawayOptions {
    let d = RunawayOptions::default();
    let n = |k: &str, dflt: usize| v.get(k).and_then(Value::as_u64).map_or(dflt, |x| x as usize);
    RunawayOptions {
        window: n("window", d.window),
        min_chars: n("minChars", d.min_chars),
        check_every: n("checkEvery", d.check_every),
        repeats: n("repeats", d.repeats),
        probe: n("probe", d.probe),
        min_distinct_lines: n("minDistinctLines", d.min_distinct_lines),
        min_lines: n("minLines", d.min_lines),
    }
}

/// Patch ids come from a process-wide counter: `msg_repair_<n>` becomes `msg_repair_N`.
fn normalize_patch_ids(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("msg_repair_") {
        let start = at + "msg_repair_".len();
        out.push_str(&rest[..start]);
        out.push('N');
        let digits = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        rest = &rest[start + digits..];
    }
    out.push_str(rest);
    out
}

#[test]
fn every_helper_matches_the_ts_loop() {
    let cases = golden("cases.json");
    let expected = golden("expected.json");

    for (i, s) in cases["streams"].as_array().unwrap().iter().enumerate() {
        let mut guard = RunawayGuard::new(options(s.get("opts").unwrap_or(&Value::Null)));
        let mut at = -1i64;
        for (j, d) in s["deltas"].as_array().unwrap().iter().enumerate() {
            if guard.push(d.as_str().unwrap()) && at < 0 {
                at = j as i64;
            }
        }
        let want = &expected["streams"][i];
        assert_eq!(
            json!({ "name": s["name"], "trippedAt": at, "tripped": guard.tripped() }),
            *want,
            "stream {}",
            s["name"]
        );
    }

    for (i, h) in cases["histories"].as_array().unwrap().iter().enumerate() {
        let mut history = h["history"].as_array().unwrap().clone();
        let filled = repair_interrupted_history(&mut history);
        let text = normalize_patch_ids(&serde_json::to_string(&Value::Array(history)).unwrap());
        let got =
            json!({ "name": h["name"], "filled": filled, "history": serde_json::from_str::<Value>(&text).unwrap() });
        assert_eq!(got, expected["repairs"][i], "repair {}", h["name"]);
    }

    let conversation = cases["conversation"].as_array().unwrap().clone();
    for (i, w) in cases["windows"].as_array().unwrap().iter().enumerate() {
        let kept: Vec<Value> =
            window_history(&conversation, w["turns"].as_f64()).iter().map(|m| m["id"].clone()).collect();
        assert_eq!(json!({ "turns": w["turns"], "kept": kept }), expected["windows"][i], "window {}", w["turns"]);
    }

    for (i, m) in cases["seen"].as_array().unwrap().iter().enumerate() {
        assert_eq!(as_seen_by_chat_model(m), expected["seen"][i], "seen {i}");
    }

    for (i, c) in cases["compacted"].as_array().unwrap().iter().enumerate() {
        let sent = from_latest_compaction(c["history"].as_array().unwrap());
        assert_eq!(json!({ "name": c["name"], "sent": sent }), expected["compacted"][i], "compacted {}", c["name"]);
    }

    for (i, m) in cases["blind"].as_array().unwrap().iter().enumerate() {
        assert_eq!(without_images(m), expected["blind"][i], "blind {i}");
    }
}
