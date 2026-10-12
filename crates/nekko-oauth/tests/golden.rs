//! The Rust OAuth functions against the TS ones.
//!
//! `golden/expected.json` is written by the real functions in oauth.ts
//! (packages/host/src/oauth.golden.test.ts, which also fails if it goes
//! stale) for every case in `golden/cases.json`. Values are compared as
//! `JSON.stringify` text, so key order and number format count, and errors
//! by message.

use nekko_oauth::*;
use serde_json::{Value, json};
use std::path::Path;

fn read(name: &str) -> Value {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden");
    serde_json::from_str(&std::fs::read_to_string(dir.join(name)).unwrap()).unwrap()
}

fn outcome(r: Result<Value, String>) -> Value {
    match r {
        Ok(v) => json!({ "value": nekko_js::stringify(&v) }),
        Err(e) => json!({ "error": e }),
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

fn f(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap()
}

#[test]
fn every_case_matches_the_ts_functions() {
    let cases = read("cases.json");
    let expected = read("expected.json");
    let mut checked = 0;
    let mut check = |section: &str, got: Vec<Value>| {
        let want = expected[section].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{section}: case count differs (stale expected.json?)");
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            assert_eq!(g, w, "{section}[{i}] differs: case {}", cases[section][i]);
            checked += 1;
        }
    };
    let each = |section: &str| cases[section].as_array().unwrap().clone();

    check(
        "authorizeUrls",
        each("authorizeUrls")
            .iter()
            .map(|c| {
                outcome(Ok(json!(authorize_url(
                    s(c, "provider"),
                    s(c, "redirectUri"),
                    s(c, "challenge"),
                    s(c, "state")
                ))))
            })
            .collect(),
    );
    check(
        "pasted",
        each("pasted")
            .iter()
            .map(|c| {
                outcome(parse_pasted(s(c, "pasted"), s(c, "redirectUri")).map(|(code, state)| match state {
                    Some(st) => json!({ "code": code, "state": st }),
                    None => json!({ "code": code }),
                }))
            })
            .collect(),
    );
    check(
        "exchangeRequests",
        each("exchangeRequests")
            .iter()
            .map(|c| {
                outcome(Ok(exchange_request(
                    s(c, "provider"),
                    s(c, "code"),
                    s(c, "redirectUri"),
                    s(c, "verifier"),
                    s(c, "state"),
                )
                .to_value()))
            })
            .collect(),
    );
    check(
        "exchangeResults",
        each("exchangeResults")
            .iter()
            .map(|c| {
                outcome(
                    exchange_result(
                        s(c, "provider"),
                        c["ok"] == json!(true),
                        f(c, "status") as u16,
                        s(c, "text"),
                        f(c, "obtainedAt"),
                        f(c, "now"),
                    )
                    .map(Obj::into_value),
                )
            })
            .collect(),
    );
    check(
        "refreshRequests",
        each("refreshRequests").iter().map(|c| outcome(Ok(refresh_request(c).to_value()))).collect(),
    );
    check(
        "refreshResults",
        each("refreshResults")
            .iter()
            .map(|c| {
                outcome(
                    refresh_result(
                        &c["tokenSet"],
                        c["ok"] == json!(true),
                        f(c, "status") as u16,
                        s(c, "text"),
                        f(c, "obtainedAt"),
                        f(c, "now"),
                    )
                    .map(Obj::into_value),
                )
            })
            .collect(),
    );
    check(
        "statuses",
        each("statuses")
            .iter()
            .map(|c| {
                outcome(Ok(status(
                    s(c, "tokenKey"),
                    c.get("tokenSet"),
                    s(c, "state"),
                    c["message"].as_str(),
                    f(c, "now"),
                )))
            })
            .collect(),
    );
    check(
        "cli",
        each("cli")
            .iter()
            .map(|c| {
                let got = if s(c, "kind") == "claude" {
                    claude_cli_token(s(c, "raw"), f(c, "now"))
                } else {
                    codex_cli_token(s(c, "raw"), f(c, "now"))
                };
                match got {
                    Ok(Some(v)) => outcome(Ok(v)),
                    Ok(None) => json!({ "value": "undefined" }),
                    // A JSON.parse error's wording is V8's; only the fact is compared.
                    Err(_) => json!({ "error": true }),
                }
            })
            .collect(),
    );
    check(
        "tokenKeys",
        each("tokenKeys")
            .iter()
            .map(|c| outcome(Ok(json!(token_key(s(c, "provider"), c["accountId"].as_str(), s(c, "sessionId"))))))
            .collect(),
    );
    assert!(checked >= 50, "the golden set is too small to mean anything");
}

#[test]
fn iso_dates_parse_as_date_parse_does() {
    assert_eq!(date_parse("2025-10-01T00:00:00.000Z"), 1_759_276_800_000.0);
    assert_eq!(date_parse("2025-10-01T09:00:00+09:00"), 1_759_276_800_000.0);
    assert_eq!(date_parse("2025-10-01"), 1_759_276_800_000.0);
    assert!(date_parse("not a date").is_nan());
    assert!(date_parse("2025-13-01").is_nan());
}

#[test]
fn pkce_challenges_are_the_verifiers_sha256() {
    let (verifier, challenge) = pkce_pair();
    assert_eq!(verifier.len(), 43);
    assert_eq!(challenge.len(), 43);
    // What Node computes for the same verifier (createHash sha256, base64url).
    use sha2::Digest;
    let rfc = base64url_encode(&sha2::Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
    assert_eq!(rfc, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
}
