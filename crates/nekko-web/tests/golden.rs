//! The Rust `fetch_url` against the TS one.
//!
//! `golden/fetch.json` is written by `packages/host/src/web-fetch.golden.test.ts`
//! (UPDATE_GOLDEN=1) from the real TS functions; every case must come out the
//! same here.

use nekko_web::fetch::{Reply, decode_entities, describe_fetched, html_to_text, max_chars, page_from_reply, parse_url};
use serde_json::Value;
use std::path::Path;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("fetch.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn list<'a>(all: &'a Value, key: &str) -> &'a Vec<Value> {
    let l = all[key].as_array().unwrap_or_else(|| panic!("no {key}"));
    assert!(!l.is_empty(), "no {key} cases");
    l
}

#[test]
fn html_to_text_matches() {
    let all = golden();
    for (i, c) in list(&all, "html").iter().enumerate() {
        let got = html_to_text(c["html"].as_str().unwrap(), c["base"].as_str());
        assert_eq!(got, c["text"].as_str().unwrap(), "html case {i}: {}", c["html"]);
    }
}

#[test]
fn entities_match() {
    let all = golden();
    for c in list(&all, "entities") {
        assert_eq!(decode_entities(c["input"].as_str().unwrap()), c["output"].as_str().unwrap(), "{}", c["input"]);
    }
}

#[test]
fn replies_match() {
    let all = golden();
    for (i, c) in list(&all, "replies").iter().enumerate() {
        let r = &c["reply"];
        let body: Vec<u8> = match &r["body"] {
            Value::String(s) => s.as_bytes().to_vec(),
            Value::Array(a) => a.iter().map(|b| b.as_u64().unwrap() as u8).collect(),
            other => panic!("body {other}"),
        };
        let result = parse_url(r["url"].as_str().unwrap()).and_then(|url| {
            let reply = Reply {
                status: r["status"].as_u64().unwrap_or(200) as u16,
                final_url: r["finalUrl"].as_str().unwrap_or_default().to_string(),
                content_type: r["type"].as_str().map(str::to_string),
                content_length: r["length"].as_str().map(str::to_string),
                body,
            };
            page_from_reply(&url, reply, max_chars(r["maxChars"].as_f64()))
        });
        match (result, c.get("error")) {
            (Ok(page), None) => {
                let want = &c["page"];
                assert_eq!(serde_json::to_value(&page).unwrap(), *want, "reply case {i}");
                assert_eq!(describe_fetched(&page), c["output"].as_str().unwrap(), "reply case {i} output");
            }
            (Err(e), Some(want)) => assert_eq!(e, want.as_str().unwrap(), "reply case {i} error"),
            (got, _) => panic!("reply case {i}: got {got:?}, want {c}"),
        }
    }
}
