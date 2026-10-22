//! The Rust tool hooks against the TS ones: `golden/hooks.json` is a frozen
//! record of the deleted TS functions (edit it by hand per
//! docs/runbooks/golden-fixtures.md).

use nekko_tools::hooks::{HookOutcome, decision_of, has_tool_hooks, label, matching_hooks, rules};
use serde_json::{Value, json};
use std::path::Path;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("hooks.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn matching_and_tool_hooks_match() {
    let g = golden();
    let all = rules(&g["rules"]);
    for c in g["matching"].as_array().unwrap() {
        let ids: Vec<Value> = matching_hooks(&all, c["event"].as_str().unwrap(), c["tool"].as_str())
            .iter()
            .map(|r| r.0["id"].clone())
            .collect();
        assert_eq!(Value::Array(ids), c["ids"], "{c}");
    }
    for c in g["hasToolHooks"].as_array().unwrap() {
        assert_eq!(json!(has_tool_hooks(&rules(&c["hooks"]))), c["has"], "{c}");
    }
}

#[test]
fn decisions_and_labels_match() {
    let g = golden();
    for c in g["decisions"].as_array().unwrap() {
        let o = &c["outcome"];
        let outcome = HookOutcome {
            code: o["code"].as_i64().map(|n| n as i32),
            stdout: o["stdout"].as_str().unwrap().into(),
            stderr: o["stderr"].as_str().unwrap().into(),
            timed_out: false,
        };
        let got = match decision_of(&outcome) {
            Some(reason) => json!({ "block": true, "reason": reason }),
            None => json!({ "block": false, "reason": "" }),
        };
        assert_eq!(got, c["decision"], "{o}");
    }
    for c in g["labels"].as_array().unwrap() {
        let rule = rules(&json!([c["rule"]])).remove(0);
        assert_eq!(label(&rule), c["label"].as_str().unwrap(), "{c}");
    }
}
