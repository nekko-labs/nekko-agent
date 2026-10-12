//! The side calls against the TS ones: `golden/side.json` is written by
//! `packages/host/src/side-prompts.golden.test.ts` (UPDATE_GOLDEN=1), inputs
//! and outputs side by side, and every input must give the same output here,
//! compared as JSON text so key order counts.

use nekko_turn::{clean_fill, fill_prompt, parse_reply_suggestions, suggest_prompt};
use serde_json::Value;
use std::path::Path;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("side.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn cases<'a>(all: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = all[key].as_array().unwrap_or_else(|| panic!("no {key} cases"));
    assert!(list.len() >= 4, "too few {key} cases");
    list
}

fn text(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

#[test]
fn suggest_prompts_match() {
    let all = golden();
    for (i, c) in cases(&all, "suggest").iter().enumerate() {
        let got = suggest_prompt(&c["input"]).map_or(Value::Null, Value::String);
        assert_eq!(text(&got), text(&c["output"]), "suggest case {i}");
    }
}

#[test]
fn fill_prompts_match() {
    let all = golden();
    for (i, c) in cases(&all, "fill").iter().enumerate() {
        let got = fill_prompt(c["input"]["part"].as_str().unwrap(), c["input"]["draft"].as_str().unwrap());
        assert_eq!(Value::String(got), c["output"], "fill case {i}");
    }
}

#[test]
fn fill_answers_clean_the_same() {
    let all = golden();
    for (i, c) in cases(&all, "clean").iter().enumerate() {
        let got = clean_fill(c["input"].as_str().unwrap()).map_or(Value::Null, Value::String);
        assert_eq!(got, c["output"], "clean case {i}: {:?}", c["input"]);
    }
}

#[test]
fn suggestion_answers_parse_the_same() {
    let all = golden();
    for (i, c) in cases(&all, "parse").iter().enumerate() {
        let got = parse_reply_suggestions(c["input"].as_str().unwrap());
        assert_eq!(text(&got), text(&c["output"]), "parse case {i}: {:?}", c["input"]);
    }
}
