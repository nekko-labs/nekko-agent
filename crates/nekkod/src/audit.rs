//! One audit trail per chat (P1 of the agent data security plan): what the
//! agent did and who allowed it, never the data itself.
//!
//! `<data>/audit/<chat id>.jsonl`, one event per line, appended:
//!
//! - `turn`: a turn started, with the chat's mode, provider and model;
//! - `tool`: a tool ran, its outcome and a value-free detail (the host a
//!   fetch reached, the file a read or write touched, the program a shell
//!   command ran, the MCP server, how many recipients);
//! - `approval`: what was asked and the answer, and who gave it: this
//!   computer, a phone (by device id), Telegram, or nobody (YOLO, a workflow).
//!   [`name_devices`] adds the device's current name when the trail is read,
//!   so a renamed phone shows its new name and the file keeps only the id;
//! - `taint`: the chat read untrusted content, and which tool brought it;
//! - `redactions`: what the Privacy Shield hid, by kind and count.
//!
//! Never written: tool arguments, full URLs, approval reasons (they quote
//! URLs and recipients), tool output, message text. Incognito chats write
//! nothing. The file goes with its chat, and keeps at most [`MAX_BYTES`] plus
//! one older file.

use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

/// When the current file passes this, it becomes `<id>.1.jsonl`.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("audit")
}

fn files(data_dir: &Path, session_id: &str) -> Option<(PathBuf, PathBuf)> {
    if !nekko_store::valid_id(session_id) {
        return None;
    }
    let d = dir(data_dir);
    Some((d.join(format!("{session_id}.1.jsonl")), d.join(format!("{session_id}.jsonl"))))
}

/// Append `event` to the chat's trail, stamped with the time.
pub fn record(data_dir: &Path, session_id: &str, mut event: Value) {
    let Some((older, current)) = files(data_dir, session_id) else { return };
    if let Some(o) = event.as_object_mut() {
        o.insert("at".into(), json!(nekko_js::now_ms()));
    }
    let _ = std::fs::create_dir_all(dir(data_dir));
    if std::fs::metadata(&current).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(&current, &older);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&current) {
        let _ = f.write_all(format!("{event}\n").as_bytes());
    }
}

/// The chat's trail, oldest first.
pub fn read(data_dir: &Path, session_id: &str) -> Vec<Value> {
    let Some((older, current)) = files(data_dir, session_id) else { return Vec::new() };
    [older, current]
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .flat_map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect::<Vec<Value>>())
        .collect()
}

/// Forget the chat's trail, with the chat.
pub fn delete(data_dir: &Path, session_id: &str) {
    if let Some((older, current)) = files(data_dir, session_id) {
        let _ = std::fs::remove_file(older);
        let _ = std::fs::remove_file(current);
    }
}

/// Add `by.deviceName` from the paired devices registry (`remote:devices`)
/// to every answer given on a phone or a paired computer that is still known.
pub fn name_devices(trail: &mut [Value], devices: &Value) {
    let names: std::collections::HashMap<&str, &str> = devices
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| Some((d.get("id")?.as_str()?, d.get("name")?.as_str()?)))
        .filter(|(_, name)| !name.trim().is_empty())
        .collect();
    for event in trail {
        let Some(by) = event.get_mut("by").and_then(Value::as_object_mut) else { continue };
        if let Some(name) = by.get("device").and_then(Value::as_str).and_then(|id| names.get(id)) {
            by.insert("deviceName".into(), json!(name));
        }
    }
}

/// A tool call's value-free detail: what it touched, never what it carried.
pub fn detail(name: &str, input: &Value) -> Value {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or_default();
    let home = |p: &str| match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) if !h.is_empty() && p.starts_with(&h) => format!("~{}", &p[h.len()..]),
        _ => p.to_string(),
    };
    match name {
        "fetch_url" => json!({ "host": url::Url::parse(s("url")).ok().and_then(|u| u.host_str().map(str::to_string)) }),
        "read_file" | "write_file" | "edit_file" | "list_dir" => json!({ "path": home(s("path")) }),
        // The program only: a command line can carry a token.
        "bash" | "start_process" => {
            json!({ "program": s("command").split_whitespace().next().map(|p| p.rsplit('/').next().unwrap_or(p)) })
        }
        "browser" => json!({ "action": input.get("action") }),
        _ if name.starts_with("mcp__") => json!({
            "server": name.strip_prefix("mcp__").and_then(|r| r.split_once("__")).map(|(id, _)| id),
            "recipients": crate::outward::recipients(input).len(),
        }),
        _ => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_reads_and_forgets_a_chat_trail() {
        let tmp = tempfile::tempdir().unwrap();
        record(tmp.path(), "s_a", json!({ "type": "tool", "tool": "read_file" }));
        record(tmp.path(), "s_a", json!({ "type": "approval", "answer": "approved" }));
        let trail = read(tmp.path(), "s_a");
        assert_eq!(trail.len(), 2);
        assert_eq!(trail[1]["answer"], "approved");
        assert!(trail[0]["at"].is_number());
        delete(tmp.path(), "s_a");
        assert!(read(tmp.path(), "s_a").is_empty());
    }

    #[test]
    fn refuses_an_id_that_is_not_a_chat_id() {
        let tmp = tempfile::tempdir().unwrap();
        record(tmp.path(), "../escape", json!({}));
        assert!(!tmp.path().join("escape.jsonl").exists());
        assert!(read(tmp.path(), "../escape").is_empty());
    }

    #[test]
    fn names_the_devices_it_still_knows() {
        let mut trail = vec![
            json!({ "type": "approval", "by": { "via": "phone", "device": "d1" } }),
            json!({ "type": "approval", "by": { "via": "paired computer", "device": "gone" } }),
            json!({ "type": "approval", "by": { "via": "this computer" } }),
            json!({ "type": "approval", "by": null }),
        ];
        let devices = json!([{ "id": "d1", "name": "Davide's Pixel" }, { "id": "d2", "name": "" }]);
        name_devices(&mut trail, &devices);
        assert_eq!(trail[0]["by"], json!({ "via": "phone", "device": "d1", "deviceName": "Davide's Pixel" }));
        assert_eq!(
            trail[1]["by"],
            json!({ "via": "paired computer", "device": "gone" }),
            "an unknown device keeps its id"
        );
        assert_eq!(trail[2]["by"], json!({ "via": "this computer" }));
        assert_eq!(trail[3]["by"], Value::Null);
    }

    #[test]
    fn details_never_carry_the_data() {
        let d = detail("fetch_url", &json!({ "url": "https://collect.example/c?d=pineapple" }));
        assert_eq!(d, json!({ "host": "collect.example" }));
        let d = detail("bash", &json!({ "command": "/usr/bin/curl -H 'Authorization: secret' https://x" }));
        assert_eq!(d, json!({ "program": "curl" }));
        let d = detail("mcp__slack__post_message", &json!({ "channel": "general", "text": "pineapple" }));
        assert_eq!(d, json!({ "server": "slack", "recipients": 1 }));
        assert!(!d.to_string().contains("pineapple"));
    }
}
