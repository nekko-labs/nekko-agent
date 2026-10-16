//! Compaction, image turns and starting a queued prompt against the TS
//! functions: `golden/variants.json` is written by
//! `packages/host/src/turn-variants.golden.test.ts` (UPDATE_GOLDEN=1), inputs
//! and outputs side by side, and every input must give the same output here,
//! compared as JSON text so key order counts.

use nekko_turn::variants::*;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("variants.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn cases<'a>(all: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = all[key].as_array().unwrap_or_else(|| panic!("no {key} cases"));
    assert!(list.len() >= 2, "too few {key} cases");
    list
}

fn text(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

fn list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn err(e: impl Into<String>) -> Value {
    json!({ "error": e.into() })
}

#[test]
fn the_summary_instructions_match() {
    assert_eq!(golden()["system"], SUMMARY_SYSTEM);
}

#[test]
fn transcripts_clips_and_splits_match() {
    let all = golden();
    for (i, c) in cases(&all, "transcripts").iter().enumerate() {
        assert_eq!(json!(transcript_text(&list(&c["input"]))), c["output"], "transcript {i}");
    }
    for (i, c) in cases(&all, "clips").iter().enumerate() {
        let got = clip(c["input"]["text"].as_str().unwrap(), c["input"]["max"].as_u64().unwrap() as usize);
        assert_eq!(json!(got), c["output"], "clip {i}");
    }
    for (i, c) in cases(&all, "splits").iter().enumerate() {
        let got = split_transcript(c["input"]["text"].as_str().unwrap(), c["input"]["max"].as_u64().unwrap() as usize);
        assert_eq!(json!(got), c["output"], "split {i}");
    }
    for (i, c) in cases(&all, "sizes").iter().enumerate() {
        assert_eq!(text(&compaction_sizes_json(c["input"].as_f64().unwrap())), text(&c["output"]), "sizes {i}");
    }
}

#[test]
fn plans_refusals_edits_and_usage_match() {
    let all = golden();
    for (i, c) in cases(&all, "plans").iter().enumerate() {
        let got = match compaction_plan(&list(&c["input"]["messages"]), c["input"]["window"].as_f64().unwrap()) {
            Ok(p) => p.to_json(),
            Err(e) => err(e),
        };
        assert_eq!(text(&got), text(&c["output"]), "plan {i}");
    }
    for (i, c) in cases(&all, "refusals").iter().enumerate() {
        let got = compaction_refusal(
            Some(&c["input"]["session"]),
            c["input"].get("provider"),
            c["input"]["offlineAllowed"].as_bool().unwrap(),
        );
        assert_eq!(got.map_or(Value::Null, |s| json!(s)), c["output"], "refusal {i}");
    }
    for (i, c) in cases(&all, "edits").iter().enumerate() {
        let messages = list(&c["input"]["messages"]);
        // The plan is replayed as recorded (the plans case above checks how it is made).
        let plan = plan_from(&c["input"]["plan"]);
        let marker = &c["input"]["marker"];
        let here = match compacted_transcript(&messages, &plan, marker) {
            Ok(m) => json!({ "messages": m }),
            Err(e) => err(e),
        };
        assert_eq!(text(&here), text(&c["output"]["here"]), "edit {i}");
        let (title, m) = continued_chat(c["input"]["title"].as_str().unwrap(), marker, &plan.recent);
        assert_eq!(text(&json!({ "title": title, "messages": m })), text(&c["output"]["next"]), "new chat {i}");
    }
    for (i, c) in cases(&all, "usage").iter().enumerate() {
        let x = &c["input"];
        let got = compaction_usage_record(
            &x["config"],
            x["model"].as_str().unwrap(),
            x["sessionId"].as_str().unwrap(),
            &x["item"],
            x["ts"].as_f64().unwrap(),
        );
        assert_eq!(text(&got), text(&c["output"]), "usage {i}");
    }
}

fn plan_from(p: &Value) -> CompactionPlan {
    CompactionPlan {
        base: p["base"].as_u64().unwrap() as usize,
        summarized: p["summarized"].as_u64().unwrap() as usize,
        recent: list(&p["recent"]),
        text: p["text"].as_str().unwrap().to_string(),
        created_at: p.get("createdAt").cloned(),
    }
}

/// The TS test's scripted model: each summary a shorter digest of its chunk.
fn digest(chunk: &str) -> String {
    let n = chunk.encode_utf16().count();
    format!("  S{n}:{}  ", "z".repeat(n / 3))
}

#[tokio::test]
async fn summary_passes_match() {
    let all = golden();
    for (i, c) in cases(&all, "summaries").iter().enumerate() {
        let x = &c["input"];
        let reply = x["reply"].as_str().unwrap().to_string();
        let prompts = Mutex::new(Vec::<String>::new());
        let progress = Mutex::new(Vec::<Vec<usize>>::new());
        let calls = Mutex::new(0usize);
        let call = |chunk: String| {
            prompts.lock().unwrap().push(summary_prompt(&chunk));
            let n = {
                let mut c = calls.lock().unwrap();
                *c += 1;
                *c
            };
            let reply = reply.clone();
            async move {
                match reply.as_str() {
                    "empty" => Ok(" \n ".to_string()),
                    "throw" => Err("Model request failed (HTTP 500): boom".to_string()),
                    "blank-second" if n == 2 => Ok(String::new()),
                    _ => Ok(digest(&chunk)),
                }
            }
        };
        let out = summarize_with(x["text"].as_str().unwrap(), x["window"].as_f64().unwrap(), call, |d, t| {
            progress.lock().unwrap().push(vec![d, t])
        })
        .await;
        let got = match out {
            Ok(s) => {
                json!({ "summary": s, "prompts": *prompts.lock().unwrap(), "progress": *progress.lock().unwrap() })
            }
            Err(e) => err(e),
        };
        assert_eq!(text(&got), text(&c["output"]), "summary {i}");
    }
}

#[test]
fn image_turns_match() {
    let all = golden();
    for (i, c) in cases(&all, "imageSizes").iter().enumerate() {
        assert_eq!(json!(image_size(&c["input"])), c["output"], "size {i}");
    }
    for (i, c) in cases(&all, "imageLabels").iter().enumerate() {
        let got = image_stage_label(c["input"]["stage"].as_str().unwrap(), c["input"]["size"].as_str().unwrap());
        assert_eq!(json!(got), c["output"], "label {i}");
    }
    for (i, c) in cases(&all, "images").iter().enumerate() {
        let x = &c["input"];
        let mut session = x["session"].clone();
        let opts = json!({ "sessionId": session["id"], "prompt": x["prompt"], "params": x["params"] });
        let started =
            match start_image_turn(&mut session, &opts, x["now"].as_u64().unwrap(), x["seed"].as_u64().unwrap()) {
                Ok(s) => json!({ "request": s.request, "text": s.text, "seed": s.seed }),
                Err(e) => err(e),
            };
        assert_eq!(text(&started), text(&c["output"]["started"]), "image start {i}");
        assert_eq!(text(&session), text(&c["output"]["session"]), "image session {i}");
    }
    for (i, c) in cases(&all, "replies").iter().enumerate() {
        let x = &c["input"];
        let got =
            image_reply(&x["result"], &x["params"], &x["seed"], x["ms"].as_u64().unwrap(), x["now"].as_u64().unwrap());
        assert_eq!(text(&got), text(&c["output"]), "reply {i}");
    }
    for (i, c) in cases(&all, "failures").iter().enumerate() {
        let x = &c["input"];
        let got =
            image_failure(x["stopped"].as_bool().unwrap(), x["message"].as_str().unwrap(), x["now"].as_u64().unwrap());
        assert_eq!(text(&got), text(&c["output"]), "failure {i}");
    }
}

#[test]
fn starting_a_queued_prompt_matches() {
    let all = golden();
    let chats = list(&all["queuedChats"]);
    for (i, c) in cases(&all, "indices").iter().enumerate() {
        let chat = &chats[c["input"]["chat"].as_u64().unwrap() as usize];
        // An absent index (`undefined`) crossed JSON as null.
        let got = queued_index_valid(chat, &c["input"]["index"]).is_some();
        assert_eq!(json!(got), c["output"], "index {i}: {}", c["input"]);
    }
    for (i, c) in cases(&all, "interrupts").iter().enumerate() {
        let x = &c["input"];
        let chat = &chats[x["chat"].as_u64().unwrap() as usize];
        let brain = x.get("brain").cloned().unwrap_or(Value::Null);
        let got = match interrupt_queued_plan(chat, x["index"].as_u64().unwrap() as usize, &brain, &x["defaults"]) {
            Ok((opts, item)) => json!({ "opts": opts, "index": x["index"], "item": item }),
            Err(e) => err(e),
        };
        assert_eq!(text(&got), text(&c["output"]), "interrupt {i}");
    }
}
