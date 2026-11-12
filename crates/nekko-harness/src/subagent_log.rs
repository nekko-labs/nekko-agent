//! A Claude Code sub-agent's transcript, as Claude Code saved it.
//!
//! Claude Code writes each sub-agent's whole conversation to
//! `<config>/projects/<project>/<session>/subagents/agent-<id>.jsonl`, with an
//! `agent-<id>.meta.json` beside it naming the `Agent` call that started it
//! (`toolUseId`). The stream does not always carry all of it: a background
//! sub-agent outlives the turn whose stream it started in, and Nekko may have
//! restarted meanwhile. So a sub-agent's child chat is filled from here when
//! it ends (#2645).
//!
//! The files are Claude Code's and are read as untrusted input: only inside
//! the Claude Code config folder, by names built here (never a path from the
//! model or the stream), size-capped, with malformed lines skipped.

use crate::map::{Mapped, Mapper};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Largest transcript read, in bytes.
const MAX_TRANSCRIPT: u64 = 32 * 1024 * 1024;
/// Largest `meta.json` read, in bytes.
const MAX_META: u64 = 64 * 1024;
/// Most project folders looked through for the session.
const MAX_PROJECTS: usize = 4096;
/// Most sub-agent files looked through in one session.
const MAX_AGENTS: usize = 2048;

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// The Claude Code config folder a chat ran on: the account's
/// (`~/.claude-<name>`), else `CLAUDE_CONFIG_DIR` as Nekko inherited it,
/// else `~/.claude`. `None` for an invalid account name.
pub fn claude_config_dir(account: Option<&str>) -> Option<PathBuf> {
    match crate::account_config_dir(account) {
        Ok(Some(dir)) => Some(dir),
        Err(_) => None,
        Ok(None) => std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|h| h.join(".claude"))),
    }
}

/// Claude Code session ids and tool-use ids: short, and nothing a path could use.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A regular file no bigger than `max`, never a link.
fn small_file(path: &Path, max: u64) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file() && m.len() <= max)
}

/// The transcript Claude Code saved for the sub-agent that `call_id` (the
/// parent's `Agent` call) started in Claude Code session `session_id`.
pub fn find_transcript(config_dir: &Path, session_id: &str, call_id: &str) -> Option<PathBuf> {
    if !plain_id(session_id) || !plain_id(call_id) {
        return None;
    }
    let projects = std::fs::read_dir(config_dir.join("projects")).ok()?;
    for project in projects.flatten().take(MAX_PROJECTS) {
        let dir = project.path().join(session_id).join("subagents");
        let Ok(agents) = std::fs::read_dir(&dir) else { continue };
        for entry in agents.flatten().take(MAX_AGENTS) {
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".meta.json")) else { continue };
            if !stem.strip_prefix("agent-").is_some_and(plain_id) {
                continue;
            }
            let meta_path = entry.path();
            if !small_file(&meta_path, MAX_META) {
                continue;
            }
            let Some(meta) = std::fs::read(&meta_path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            else {
                continue;
            };
            if meta.get("toolUseId").and_then(Value::as_str) != Some(call_id) {
                continue;
            }
            let transcript = dir.join(format!("{stem}.jsonl"));
            return small_file(&transcript, MAX_TRANSCRIPT).then_some(transcript);
        }
    }
    None
}

/// The transcript's lines, malformed ones skipped. Empty for a file that is
/// missing, a link, or too big.
pub fn read_transcript(path: &Path) -> Vec<Value> {
    if !small_file(path, MAX_TRANSCRIPT) {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).filter(Value::is_object).collect()
}

/// `2026-11-12T03:55:14.123Z` as Unix milliseconds (UTC only, as Claude Code writes it).
fn iso_ms(s: &str) -> Option<u64> {
    let (date, time) = s.strip_suffix('Z')?.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let ms: i64 = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms).ok()
}

/// Whether a saved line is about the call that started the sub-agent: a
/// fork's transcript opens with the parent's own `Agent` call and its result.
fn about_spawn(line: &Value, spawn_call: &str) -> bool {
    let blocks = line.pointer("/message/content").and_then(Value::as_array);
    blocks.is_some_and(|b| {
        !b.is_empty()
            && b.iter().all(|b| {
                b.get("id").and_then(Value::as_str) == Some(spawn_call)
                    || b.get("tool_use_id").and_then(Value::as_str) == Some(spawn_call)
            })
    })
}

/// The child chat's transcript after its opening task message, mapped from
/// the saved lines with the same [`Mapper`] the stream goes through.
pub fn transcript_messages(lines: &[Value], child_id: &str, spawn_call: &str) -> Vec<Value> {
    let mut mapper = Mapper::new(child_id);
    let mut out = Vec::new();
    let keep = |mapped: Vec<Mapped>, at: Option<u64>, out: &mut Vec<Value>| {
        for item in mapped {
            if let Mapped::Message(mut m) = item {
                if let (Some(at), Some(obj)) = (at, m.as_object_mut()) {
                    obj.insert("createdAt".into(), Value::from(at));
                }
                out.push(m);
            }
        }
    };
    for line in lines {
        if !matches!(line.get("type").and_then(Value::as_str), Some("assistant" | "user"))
            || line.get("isMeta") == Some(&Value::Bool(true))
            || about_spawn(line, spawn_call)
        {
            continue;
        }
        let at = line.get("timestamp").and_then(Value::as_str).and_then(iso_ms);
        let mapped = mapper.map(line);
        keep(mapped, at, &mut out);
    }
    keep(mapper.flush(false, false), None, &mut out);
    out
}

/// Every tool call id in a transcript.
pub fn tool_call_ids(messages: &[Value]) -> std::collections::HashSet<String> {
    messages
        .iter()
        .flat_map(|m| m.get("toolCalls").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|c| c.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekko-subagent-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn write_agent(config: &Path, session: &str, agent: &str, call: &str, lines: &[Value]) -> PathBuf {
        let sub = config.join("projects").join("C--work").join(session).join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(format!("agent-{agent}.meta.json")), json!({ "toolUseId": call }).to_string()).unwrap();
        let body: Vec<String> = lines.iter().map(Value::to_string).collect();
        let path = sub.join(format!("agent-{agent}.jsonl"));
        std::fs::write(&path, body.join("\n") + "\n{not json\n").unwrap();
        path
    }

    #[test]
    fn finds_the_transcript_by_the_call_that_started_it() {
        let config = dir("find");
        let a = write_agent(&config, "sess-1", "a1", "toolu_a", &[json!({ "type": "user" })]);
        write_agent(&config, "sess-1", "a2", "toolu_b", &[]);
        assert_eq!(find_transcript(&config, "sess-1", "toolu_a"), Some(a));
        assert_eq!(find_transcript(&config, "sess-1", "toolu_c"), None);
        assert_eq!(find_transcript(&config, "sess-2", "toolu_a"), None);
        // Nothing that could leave the folder.
        assert_eq!(find_transcript(&config, "../sess-1", "toolu_a"), None);
        assert_eq!(find_transcript(&config, "sess-1", "toolu_a/../x"), None);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn maps_the_saved_lines_like_the_stream_skipping_the_forks_own_call() {
        let at = "2026-11-12T03:55:14.250Z";
        let lines = vec![
            json!({ "type": "fork-context-ref", "agentId": "a1" }),
            json!({ "type": "assistant", "message": { "id": "m0", "role": "assistant", "content": [
                { "type": "tool_use", "id": "toolu_spawn", "name": "Agent", "input": { "prompt": "go" } }] } }),
            json!({ "type": "user", "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_spawn", "content": "the directive" }] } }),
            json!({ "type": "assistant", "timestamp": at, "message": { "id": "m1", "role": "assistant", "content": [
                { "type": "text", "text": "Opening it." }] } }),
            json!({ "type": "assistant", "timestamp": at, "message": { "id": "m1", "role": "assistant", "content": [
                { "type": "tool_use", "id": "toolu_pr", "name": "Bash", "input": { "command": "gh pr create --fill" } }] } }),
            json!({ "type": "user", "timestamp": at, "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_pr", "content": "https://github.com/o/r/pull/9" }] } }),
            json!({ "type": "user", "isMeta": true, "message": { "role": "user", "content": "meta" } }),
            json!({ "type": "assistant", "message": { "id": "m2", "role": "assistant", "content": [
                { "type": "text", "text": "Done." }] } }),
        ];
        let out = transcript_messages(&lines, "s_child", "toolu_spawn");
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0]["content"], "Opening it.");
        assert_eq!(out[0]["toolCalls"][0]["id"], "toolu_pr");
        assert_eq!(out[1]["toolResult"]["output"], "https://github.com/o/r/pull/9");
        assert_eq!(out[1]["createdAt"], json!(iso_ms(at).unwrap()));
        assert_eq!(out[2]["content"], "Done.");
        assert_eq!(tool_call_ids(&out).into_iter().collect::<Vec<_>>(), ["toolu_pr"]);
    }

    #[test]
    fn reads_only_well_formed_lines() {
        let config = dir("read");
        let path = write_agent(&config, "s", "a1", "c", &[json!({ "type": "user" }), json!({ "type": "assistant" })]);
        assert_eq!(read_transcript(&path).len(), 2);
        assert!(read_transcript(&config.join("missing.jsonl")).is_empty());
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn iso_times() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2026-11-12T03:55:14.250Z"), Some(1_794_455_714_250));
        assert_eq!(iso_ms("2000-02-29T12:00:00.5Z"), Some(951_825_600_500));
        assert_eq!(iso_ms("2026-11-12 03:55:14Z"), None);
        assert_eq!(iso_ms("2026-13-01T00:00:00Z"), None);
    }
}
