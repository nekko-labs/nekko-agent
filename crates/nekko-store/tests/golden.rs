//! The Rust summarizer against the TS one.
//!
//! `golden/summaries.json` is a frozen record of what the deleted TS
//! `summarizeSession` gave for the fixtures in `golden/sessions`
//! (make-fixtures.mjs); edit it by hand per docs/runbooks/golden-fixtures.md.
//! Every summary must match exactly: key order included, since the renderer
//! may be handed either side's output.

use nekko_store::{SessionStore, summarize};
use serde_json::{Value, json};
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
        let mut errors: Vec<String> = Vec::new();
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
                "editQueued" => store.edit_queued(fixture, &arg, op.get(2).unwrap_or(&Value::Null)),
                "autoTitle" => store.set_auto_title(fixture, arg.as_str().unwrap()).map(|_| Some(Value::Null)),
                "configureSandbox" => store
                    .configure_sandbox(fixture, arg.as_str().unwrap(), op[2].as_str().unwrap(), op[3].as_f64().unwrap())
                    .map(Some),
                other => panic!("unknown op {other}"),
            };
            match r {
                Ok(saved) => assert!(saved.is_some(), "{fixture}: the chat vanished"),
                Err(e) => errors.push(e),
            }
        }
        let text = std::fs::read_to_string(data.join("sessions").join(format!("{fixture}.json"))).unwrap();
        assert_eq!(normalize(&text), expected[fixture].as_str().unwrap(), "{fixture}: file differs");
        let refusals = expected.get(&format!("{fixture}:errors")).and_then(Value::as_str).unwrap_or("[]");
        assert_eq!(serde_json::to_string(&errors).unwrap(), refusals, "{fixture}: refusals differ");
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
    // The order createSession writes (golden/creates.json holds the TS output).
    assert_eq!(keys, ["id", "title", "workspaceId", "gitIsolation", "messages", "createdAt", "updatedAt"]);
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
        // A save that failed leaves the fixture as checked out, which may have CRLF line ends.
        let written = std::fs::read_to_string(&path).ok().map(|t| normalize(&t.replace("\r\n", "\n")));
        assert_eq!(written.map(Value::String).unwrap_or(Value::Null), want["written"], "{name}: file");
        assert_eq!(Value::String(normalize(&pretty(&copy))), want["memory"], "{name}: memory");
        std::fs::remove_dir_all(data).ok();
    }
}

/// A fork's new id and save times, the top-level lines only
/// (`normalizeFork` in the deleted TS fork test).
fn normalize_fork(text: &str) -> String {
    let mut seen = [false; 3];
    text.lines()
        .map(|line| {
            for (i, (key, out)) in [
                ("  \"id\": \"", "  \"id\": \"<fork>\","),
                ("  \"createdAt\": ", "  \"createdAt\": 0"),
                ("  \"updatedAt\": ", "  \"updatedAt\": 0"),
            ]
            .iter()
            .enumerate()
            {
                if !seen[i] && line.starts_with(key) {
                    seen[i] = true;
                    let comma = if i > 0 && line.ends_with(',') { "," } else { "" };
                    return format!("{out}{comma}");
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn a_fork_is_the_file_the_ts_host_would_write() {
    let expected: serde_json::Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("forks.json")).unwrap()).unwrap();
    let cases: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(golden().join("fork-cases.json")).unwrap()).unwrap();
    assert!(cases.len() >= 8, "the golden set is too small to mean anything");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let src = &case["session"];
        let id = src["id"].as_str().unwrap();
        let data = std::env::temp_dir().join(format!("nekko-fork-{}-{name}", std::process::id()));
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        let src_file = data.join("sessions").join(format!("{id}.json"));
        let src_text = pretty(src);
        std::fs::write(&src_file, &src_text).unwrap();
        let store = SessionStore::new(&data);
        let fork = store.fork(id, case.get("before").unwrap_or(&Value::Null)).unwrap().expect("a fork");
        assert_eq!(std::fs::read_to_string(&src_file).unwrap(), src_text, "{name}: the source changed");
        let fork_id = fork["id"].as_str().unwrap();
        assert!(fork_id.starts_with("s_") && fork_id != id, "{name}: {fork_id}");
        let text = std::fs::read_to_string(data.join("sessions").join(format!("{fork_id}.json"))).unwrap();
        assert_eq!(normalize_fork(&text), expected[name].as_str().unwrap(), "{name}: fork differs");
        // What the call returns is what it wrote.
        assert_eq!(pretty(&fork), text, "{name}: returned chat differs from the file");
        std::fs::remove_dir_all(&data).ok();
    }
    assert_eq!(expected["no_such_chat"], Value::Null);
    let data = std::env::temp_dir().join(format!("nekko-fork-{}-absent", std::process::id()));
    assert!(SessionStore::new(&data).fork("s_absent", &Value::Null).unwrap().is_none());
    assert!(SessionStore::new(&data).fork("../escape", &Value::Null).unwrap().is_none());
}

#[test]
fn archive_purge_deletes_what_the_ts_host_deletes() {
    let c: Value = serde_json::from_str(&std::fs::read_to_string(golden().join("purge.json")).unwrap()).unwrap();
    let data = std::env::temp_dir().join(format!("nekko-purge-{}", std::process::id()));
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    for s in c["sessions"].as_array().unwrap() {
        let id = s["id"].as_str().unwrap();
        std::fs::write(data.join("sessions").join(format!("{id}.json")), s.to_string()).unwrap();
    }
    std::fs::write(data.join("sessions/broken.json"), "{").unwrap();
    std::fs::write(data.join("sessions/s_null.json"), "null").unwrap();
    // An archived chat whose id names no file of its own is left alone.
    std::fs::write(
        data.join("sessions/s_bad.json"),
        serde_json::json!({ "id": "../s_bad", "messages": [], "archivedAt": 1 }).to_string(),
    )
    .unwrap();
    let store = SessionStore::new(&data);
    store.summaries();
    let seen = std::sync::Mutex::new(Vec::new());
    let count = store
        .purge_archived_with(c["now"].as_f64().unwrap(), |id| {
            seen.lock().unwrap().push(id.to_string());
            Ok(())
        })
        .unwrap();
    assert_eq!(count, c["count"].as_u64().unwrap() as usize);
    assert_eq!(seen.lock().unwrap().len(), count, "the host is told about each chat before it goes");
    let mut remaining: Vec<String> = std::fs::read_dir(data.join("sessions"))
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .filter(|n| n != "s_bad")
        .collect();
    remaining.sort();
    let want: Vec<String> =
        c["remaining"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(remaining, want);
    assert!(data.join("sessions/s_bad.json").exists());
    assert_eq!(store.summaries().len(), want.iter().filter(|n| n.starts_with("s_") && *n != "s_null").count() + 1);
    std::fs::remove_dir_all(&data).ok();
}

#[test]
fn a_failed_purge_callback_keeps_the_chat() {
    let data = std::env::temp_dir().join(format!("nekko-purge-fail-{}", std::process::id()));
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let file = data.join("sessions/s_old.json");
    std::fs::write(&file, serde_json::json!({ "id": "s_old", "messages": [], "archivedAt": 1 }).to_string()).unwrap();
    let store = SessionStore::new(&data);
    assert!(store.purge_archived(|_| Err("log busy".into())).is_err());
    assert!(file.exists());
    assert_eq!(store.purge_archived(|_| Ok(())).unwrap(), 1);
    assert!(!file.exists());
    std::fs::remove_dir_all(&data).ok();
}

#[test]
fn every_new_chat_is_the_one_create_session_makes() {
    let cases: Value =
        serde_json::from_str(&std::fs::read_to_string(golden().join("create-cases.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(golden().join("creates.json")).unwrap()).unwrap();
    let starter: Value = serde_json::from_str(nekko_store::STARTER_MODES).unwrap();
    assert_eq!(starter, expected["starterModes"], "STARTER_MODES drifted from saved-modes.ts");
    for (i, k) in cases["cases"].as_array().unwrap().iter().enumerate() {
        let data = std::env::temp_dir().join(format!("nekko-create-{}-{i}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        for (id, parent) in cases["parents"].as_object().unwrap() {
            std::fs::write(data.join("sessions").join(format!("{id}.json")), parent.to_string()).unwrap();
        }
        let store = SessionStore::new(&data);
        let want = &expected["results"][i];
        let made = store
            .create_with(k["workspaceId"].as_str(), k["parent"].as_str(), k.get("supporting"), &want["settings"])
            .unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        let shape = id.starts_with("s_") && id.len() > 12;
        assert_eq!(shape, want["idShape"] == json!(true), "case {i}: {id}");
        let text = std::fs::read_to_string(data.join("sessions").join(format!("{id}.json"))).unwrap();
        let mut saved: serde_json::Map<String, Value> = serde_json::from_str(&text).unwrap();
        saved.insert("id".into(), json!("<id>"));
        saved.insert("createdAt".into(), json!(0));
        saved.insert("updatedAt".into(), json!(0));
        assert_eq!(
            serde_json::to_string(&Value::Object(saved)).unwrap(),
            serde_json::to_string(&want["saved"]).unwrap(),
            "case {i}: {k}"
        );
        std::fs::remove_dir_all(&data).ok();
    }
}
