//! The finder's text-only view of a chat: what it keeps, what it drops, and
//! that it is read once per file version.

use nekko_store::SessionStore;
use nekko_store::finder::text_view;
use serde_json::{Value, json};
use std::sync::Arc;

fn write(dir: &std::path::Path, chat: &Value) {
    std::fs::create_dir_all(dir.join("sessions")).unwrap();
    std::fs::write(
        dir.join("sessions").join(format!("{}.json", chat["id"].as_str().unwrap())),
        serde_json::to_vec(chat).unwrap(),
    )
    .unwrap();
}

fn sample() -> Value {
    json!({
        "id": "s_one", "title": "One", "updatedAt": 9, "workspaceId": "w1", "mode": "agent",
        "gitWorktrees": { "w1": { "path": "/repo/.worktrees/x", "branch": "b" }, "w2": { "path": "/other" } },
        "messages": [
            { "id": "u1", "role": "user", "content": "find the cat", "images": ["data:image/png;base64,AAAA"], "videos": ["data:video/mp4;base64,BBBB"], "skill": { "name": "s", "input": "extra words" }, "createdAt": 1 },
            { "id": "a1", "role": "assistant", "content": "", "reasoning": "secret thoughts", "createdAt": 2,
              "toolCalls": [
                { "id": "t1", "name": "write_file", "input": { "path": "docs/x.md", "content": "HUGE BODY" } },
                { "id": "t2", "name": "bash", "input": { "command": "ls" } },
                { "id": "t3", "name": "Write", "input": { "file_path": "/a/b.html", "content": "x" } },
              ] },
            { "id": "t1r", "role": "tool", "content": "TOOL OUTPUT", "toolResult": { "output": "BIG", "images": ["data:image/png;base64,CCCC"] }, "createdAt": 3 },
            { "id": "a2", "role": "assistant", "content": "the cat is at [x](/a/b.html)", "images": ["data:image/png;base64,DDDD"], "createdAt": 4 },
            { "id": "a3", "role": "assistant", "content": "   ", "createdAt": 5 },
        ],
    })
}

#[test]
fn keeps_only_what_the_finder_reads() {
    let view = text_view(&serde_json::to_vec(&sample()).unwrap()).unwrap();
    assert_eq!(view["id"], "s_one");
    assert_eq!(view["title"], "One");
    assert_eq!(view["updatedAt"], 9.0);
    assert_eq!(view["workspaceId"], "w1");
    assert_eq!(view["gitWorktrees"], json!({ "w1": { "path": "/repo/.worktrees/x" } }));
    let messages = view["messages"].as_array().unwrap();
    let ids: Vec<&str> = messages.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["u1", "a1", "a2"], "tool results and blank replies are dropped");
    assert_eq!(messages[0]["skill"], json!({ "input": "extra words" }));
    assert_eq!(
        messages[1]["toolCalls"],
        json!([{ "name": "write_file", "input": { "path": "docs/x.md" } }, { "name": "Write", "input": { "file_path": "/a/b.html" } }]),
        "only the file-naming arguments of tool calls that name a file"
    );
    let text = view.to_string();
    for gone in ["data:image", "data:video", "secret thoughts", "HUGE BODY", "TOOL OUTPUT", "BIG", "\"ls\""] {
        assert!(!text.contains(gone), "{gone} should not be in the view");
    }
}

#[test]
fn survives_odd_shapes_and_refuses_non_chats() {
    let odd = json!({ "id": "s_odd", "updatedAt": "soon", "messages": [
        { "id": 7, "role": "user", "content": "kept", "createdAt": "x", "toolCalls": "nope" },
        { "role": "assistant", "content": "x", "toolCalls": [{ "name": "Read", "input": "a string" }, { "name": "Read", "input": { "file_path": 5 } }, { "input": { "path": "a.md" } }] },
    ] });
    let view = text_view(&serde_json::to_vec(&odd).unwrap()).unwrap();
    assert_eq!(view["updatedAt"], Value::Null);
    assert_eq!(view["messages"][0]["content"], "kept");
    assert!(view["messages"][1].get("toolCalls").is_some(), "a nameless call that names a path is still kept");
    assert!(text_view(b"not json").is_none());
    assert!(text_view(br#"{"id":"x"}"#).is_none(), "no transcript, no view");
}

#[test]
fn reads_a_chat_once_per_file_version() {
    let dir = std::env::temp_dir().join(format!("nekko-finder-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    write(&dir, &sample());
    let store = SessionStore::new(&dir);
    let first = store.finder_text("s_one").unwrap();
    let again = store.finder_text("s_one").unwrap();
    assert!(Arc::ptr_eq(&first, &again), "a second ask is served from memory");

    // The file is replaced (as a save does): the view is made again.
    let mut changed = sample();
    changed["messages"][0]["content"] = json!("find the dog, now longer");
    write(&dir, &changed);
    let next = store.finder_text("s_one").unwrap();
    assert!(!Arc::ptr_eq(&first, &next));
    assert_eq!(next["messages"][0]["content"], "find the dog, now longer");

    // Gone, bad ids and non-chats answer None.
    std::fs::remove_file(dir.join("sessions/s_one.json")).unwrap();
    assert!(store.finder_text("s_one").is_none());
    assert!(store.finder_text("../escape").is_none());
    assert!(store.finder_text("").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
