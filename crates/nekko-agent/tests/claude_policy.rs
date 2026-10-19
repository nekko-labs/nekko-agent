//! The Rust policy table must be the TS one (`packages/shared/src/claude-policy.ts`):
//! `tests/golden/claude-policy.json` is written by
//! `packages/host/src/claude-policy.golden.test.ts` (UPDATE_GOLDEN=1).

use nekko_agent::claude_policy::{
    Capability, ClaudeAuth, Policy, ReasonId, auth_for, claude_code_unsupported, reasons_json,
};
use serde_json::{Value, json};

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/claude-policy.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn table_matches_ts() {
    let g = golden();
    assert_eq!(serde_json::to_value(Policy::shipped()).unwrap(), g["policy"]);
    assert_eq!(json!(ClaudeAuth::ALL.map(ClaudeAuth::as_str)), g["auths"]);
    assert_eq!(json!(Capability::ALL.map(Capability::as_str)), g["capabilities"]);
}

#[test]
fn reasons_match_ts() {
    let g = golden();
    assert_eq!(reasons_json(), g["reasons"]);
    let awaiting: serde_json::Map<String, Value> =
        Capability::ALL.into_iter().map(|c| (c.as_str().to_string(), json!(c.awaiting_reason().as_str()))).collect();
    assert_eq!(Value::Object(awaiting), g["awaitingReason"]);
    let structural: serde_json::Map<String, Value> = Capability::ALL
        .into_iter()
        .filter_map(|c| claude_code_unsupported(c).map(|r: ReasonId| (c.as_str().to_string(), json!(r.as_str()))))
        .collect();
    assert_eq!(Value::Object(structural), g["claudeCodeUnsupported"]);
}

#[test]
fn auth_mapping_matches_ts() {
    let g = golden();
    let cases = g["authCases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let got = auth_for(&case["provider"], case.get("status"));
        assert_eq!(json!(got.map(ClaudeAuth::as_str)), case["auth"], "{case}");
    }
}
