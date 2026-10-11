//! The Rust summarizer against the TS one.
//!
//! `golden/summaries.json` is written by the real `summarizeSession`
//! (packages/host/src/session-summary.golden.test.ts, which also fails if it
//! goes stale), from the fixtures in `golden/sessions` (make-fixtures.mjs).
//! Every summary must match exactly: key order included, since the renderer
//! may be handed either side's output.

use nekko_store::{SessionStore, summarize};
use serde_json::Value;
use std::path::Path;

fn golden() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

#[test]
fn every_fixture_summarizes_exactly_as_the_ts_host_does() {
    let expected: serde_json::Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("summaries.json")).unwrap()).unwrap();
    assert!(expected.len() >= 10, "the golden set is too small to mean anything");
    for (id, want) in &expected {
        let raw = std::fs::read_to_string(golden().join("sessions").join(format!("{id}.json"))).unwrap();
        let session: Value = serde_json::from_str(&raw).unwrap();
        let got = summarize(&session).unwrap_or(Value::Null);
        assert_eq!(&got, want, "summary of {id} differs");
        // Same keys in the same order, not just equal maps.
        if let (Some(g), Some(w)) = (got.as_object(), want.as_object()) {
            assert_eq!(g.keys().collect::<Vec<_>>(), w.keys().collect::<Vec<_>>(), "key order of {id} differs");
        }
    }
}

#[test]
fn the_store_lists_the_golden_set_as_the_ts_lister_would() {
    // SessionStore reads `<data>/sessions`; the fixtures dir is laid out that way.
    let store = SessionStore::new(golden());
    let summaries = store.summaries();
    // The one fixture summarizeSession throws on is skipped, as the TS lister skips it.
    assert!(summaries.iter().all(|s| s["id"] != "s_nomsgs"));
    assert_eq!(summaries.len(), std::fs::read_dir(golden().join("sessions")).unwrap().count() - 1);
    assert!(summaries.iter().all(|s| s.get("messages").is_none()));
}

/// `updatedAt` is the save time, the one field the two sides cannot agree on.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("\"updatedAt\": ") {
        let start = i + "\"updatedAt\": ".len();
        out.push_str(&rest[..start]);
        let digits = rest[start..].bytes().take_while(u8::is_ascii_digit).count();
        out.push('0');
        rest = &rest[start + digits..];
    }
    out.push_str(rest);
    out
}

#[test]
fn every_write_leaves_the_file_the_ts_host_would() {
    let expected: serde_json::Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("writes.json")).unwrap()).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(golden().join("ops.json")).unwrap()).unwrap();
    for case in cases {
        let fixture = case["fixture"].as_str().unwrap();
        let data = std::env::temp_dir().join(format!("nekko-writes-{}-{fixture}", std::process::id()));
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        std::fs::copy(
            golden().join("sessions").join(format!("{fixture}.json")),
            data.join("sessions").join(format!("{fixture}.json")),
        )
        .unwrap();
        let store = SessionStore::new(&data);
        for op in case["ops"].as_array().unwrap() {
            let op = op.as_array().unwrap();
            let arg = op.get(1).cloned().unwrap_or(Value::Null);
            let r = match op[0].as_str().unwrap() {
                "setOptions" => store.set_options(fixture, &arg),
                "setWorkspace" => store.set_workspace(fixture, arg.as_str()),
                "setSupporting" => store.set_supporting(fixture, &arg),
                "setAttachments" => store.set_attachments(fixture, &arg),
                "setSpecLinked" => store.set_spec_linked(fixture, &arg),
                "truncate" => store.truncate(fixture, &arg),
                "queue" => store.queue(fixture, &arg),
                "dequeue" => store.dequeue(fixture, &arg),
                other => panic!("unknown op {other}"),
            };
            assert!(r.unwrap().is_some(), "{fixture}: the chat vanished");
        }
        let text = std::fs::read_to_string(data.join("sessions").join(format!("{fixture}.json"))).unwrap();
        assert_eq!(normalize(&text), expected[fixture].as_str().unwrap(), "{fixture}: file differs");
        std::fs::remove_dir_all(&data).ok();
    }
}

#[test]
fn set_options_accepts_git_isolation() {
    let data = std::env::temp_dir().join(format!("nekko-options-{}", std::process::id()));
    let store = SessionStore::new(&data);
    let s = store.create(Some("w1")).unwrap();
    let id = s["id"].as_str().unwrap();
    let saved = store.set_options(id, &serde_json::json!({ "gitIsolation": false })).unwrap().unwrap();
    assert_eq!(saved["gitIsolation"], false);
    std::fs::remove_dir_all(&data).ok();
}

#[test]
fn creates_and_deletes_chats_the_way_the_ts_host_does() {
    let data = std::env::temp_dir().join(format!("nekko-create-{}", std::process::id()));
    let store = SessionStore::new(&data);
    let s = store.create(Some("w1")).unwrap();
    let id = s["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("s_") && id.len() > 12, "{id}");
    let keys: Vec<&String> = s.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "title", "gitIsolation", "workspaceId", "messages", "createdAt", "updatedAt"]);
    assert_eq!(s["gitIsolation"], true);
    assert_eq!(store.get(&id).unwrap()["title"], "New chat");
    assert!(store.create(None).unwrap().get("workspaceId").is_none());
    store.delete(&id).unwrap();
    assert!(store.get(&id).is_none());
    store.delete(&id).unwrap(); // deleting twice is fine
    std::fs::remove_dir_all(&data).ok();
}

#[test]
fn clear_matches_the_ts_host() {
    let cases: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("clear.json")).unwrap()).unwrap();
    for c in cases {
        let data =
            std::env::temp_dir().join(format!("nekko-clear-{}-{}", std::process::id(), c["scope"].as_str().unwrap()));
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        for s in c["sessions"].as_array().unwrap() {
            let id = s["id"].as_str().unwrap();
            std::fs::write(data.join("sessions").join(format!("{id}.json")), s.to_string()).unwrap();
            std::fs::write(data.join("sessions").join(format!("{id}.commands.log")), "log").unwrap();
        }
        std::fs::write(data.join("sessions/broken.json"), "{").unwrap();
        let store = SessionStore::new(&data);
        store.summaries();
        assert_eq!(
            store.clear_since(c["scope"] == "all", c["cutoff"].as_f64().unwrap()).unwrap(),
            c["count"].as_u64().unwrap() as usize
        );
        for s in c["sessions"].as_array().unwrap() {
            let id = s["id"].as_str().unwrap();
            let kept = c["remaining"].as_array().unwrap().contains(&s["id"]);
            assert_eq!(store.get(id).is_some(), kept);
            // Sidecars are host-owned; the daemon coordinates their queue via callback.
            assert!(data.join("sessions").join(format!("{id}.commands.log")).exists());
        }
        assert_eq!(store.summaries().len(), c["remaining"].as_array().unwrap().len());
        assert!(data.join("sessions/broken.json").exists());
        std::fs::remove_dir_all(data).unwrap();
    }
}

/// `JSON.stringify(v, null, 2)`, as both sides write a chat file.
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap()
}

#[test]
fn a_running_turn_saves_exactly_as_save_turn_session_does() {
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(golden().join("turn-saves.json")).unwrap()).unwrap();
    let cases = file["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let fixture = c["fixture"].as_str().unwrap();
        let want = &file["expected"][name];
        let data =
            std::env::temp_dir().join(format!("nekko-turn-save-{}-{}", std::process::id(), name.replace(' ', "_")));
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        let path = data.join("sessions").join(format!("{fixture}.json"));
        std::fs::copy(golden().join("sessions").join(format!("{fixture}.json")), &path).unwrap();
        let original: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let store = SessionStore::new(&data);
        for op in c["disk"].as_array().unwrap() {
            let op = op.as_array().unwrap();
            let arg = op.get(1).cloned().unwrap_or(Value::Null);
            match op[0].as_str().unwrap() {
                "setOptions" => store.set_options(fixture, &arg).unwrap(),
                "setSpecLinked" => store.set_spec_linked(fixture, &arg).unwrap(),
                "queue" => store.queue(fixture, &arg).unwrap(),
                other => panic!("unknown op {other}"),
            };
        }
        if c["deleted"] == true {
            std::fs::remove_file(&path).unwrap();
        }
        let mut copy = original.clone();
        for (k, v) in c["turn"].as_object().unwrap() {
            if k == "messagesAppend" {
                copy["messages"].as_array_mut().unwrap().extend(v.as_array().unwrap().iter().cloned());
            } else {
                copy[k] = v.clone();
            }
        }
        let queued = c.get("queued").map(|q| (q["index"].as_u64().unwrap() as usize, &q["item"]));
        let error = store.save_turn(&mut copy, queued).err();
        assert_eq!(error.map(Value::String).unwrap_or(Value::Null), want["error"], "{name}: error");
        let written = std::fs::read_to_string(&path).ok().map(|t| normalize(&t));
        assert_eq!(written.map(Value::String).unwrap_or(Value::Null), want["written"], "{name}: file");
        assert_eq!(Value::String(normalize(&pretty(&copy))), want["memory"], "{name}: memory");
        std::fs::remove_dir_all(data).ok();
    }
}
