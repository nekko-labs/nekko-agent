//! What feeds the context from disk: `collectGuidelines`, `isPointerTo` and
//! `collectAttached` (packages/host/src/chat.ts), `listMemory`
//! (packages/host/src/memory.ts) and `parseMemory` (packages/core/src/memory/store.ts).

use crate::nodepath;
use nekko_js as js;
use serde_json::{Map, Value, json};
use std::path::Path;

/// The names read from each workspace root, in this order.
const GUIDELINE_NAMES: [&str; 5] = ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules", "GEMINI.md"];
/// Each file is read up to this many UTF-16 units.
const READ_LIMIT: usize = 20_000;

pub struct Guideline {
    pub path: String,
    pub content: String,
}

/// `readFileSync(p, 'utf8').slice(0, 20000)`: invalid UTF-8 becomes U+FFFD, a
/// byte-order mark stays, and the cut is in UTF-16 units. `None` for anything
/// that is not a readable file.
pub(crate) fn read_limited(p: &str) -> Option<String> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(js::slice16(&text, READ_LIMIT).to_string())
}

/// `isPointerTo`: a short file that names another guideline present beside it.
fn is_pointer(name: &str, content: &str, siblings: &[(String, String, String)]) -> bool {
    let body = js::trim(content);
    if js::len16(body) > 600 {
        return false;
    }
    siblings.iter().any(|(_, n, _)| n != name && body.contains(n.as_str()))
}

/// `collectGuidelines`: guideline files in each workspace root, skipping ones
/// that only point at a sibling and ones whose content is already taken.
pub fn collect_guidelines(workspace_paths: &[String]) -> Vec<Guideline> {
    let mut out: Vec<Guideline> = Vec::new();
    for root in workspace_paths {
        let mut found: Vec<(String, String, String)> = Vec::new();
        for name in GUIDELINE_NAMES {
            let p = nodepath::join(root, name);
            if !Path::new(&p).exists() {
                continue;
            }
            if let Some(content) = read_limited(&p) {
                found.push((p, name.to_string(), content));
            }
        }
        for (path, name, content) in &found {
            if found.len() > 1 && is_pointer(name, content, &found) {
                continue;
            }
            if out.iter().any(|o| js::trim(&o.content) == js::trim(content)) {
                continue;
            }
            out.push(Guideline { path: path.clone(), content: content.clone() });
        }
    }
    out
}

/// `collectAttached`: each path that exists and reads as a file, as given.
pub fn collect_attached(paths: &[String]) -> Vec<(String, String)> {
    paths.iter().filter(|p| Path::new(p).exists()).filter_map(|p| read_limited(p).map(|c| (p.clone(), c))).collect()
}

/// `unescapeYaml`.
fn unescape(s: &str) -> String {
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    s.replace("\\\"", "\"")
}

/// `parseTags`.
fn tags(s: Option<&str>) -> Vec<String> {
    let Some(s) = s.filter(|s| !s.is_empty()) else { return Vec::new() };
    let s = s.strip_prefix('[').unwrap_or(s);
    let s = s.strip_suffix(']').unwrap_or(s);
    s.split(',').map(|t| js::trim(t).to_string()).filter(|t| !t.is_empty()).collect()
}

/// `parseMemory(markdown, fallbackId)`. The frontmatter is the text between a
/// leading `---\n` and the first later `\n---`, as the TS regex matches it.
pub fn parse_memory(markdown: &str, fallback_id: &str) -> Value {
    let mut meta: Vec<(String, String)> = Vec::new();
    let mut body = markdown.to_string();
    if let Some(after) = markdown.strip_prefix("---\n")
        && let Some(k) = after.find("\n---")
    {
        let front = &after[..k];
        let rest = &after[k + 4..];
        let rest = rest.strip_prefix('\n').unwrap_or(rest);
        body = js::trim(rest).to_string();
        for line in front.split('\n') {
            if let Some(idx) = line.find(':').filter(|&i| i > 0) {
                let key = js::trim(&line[..idx]).to_string();
                let value = js::trim(&line[idx + 1..]).to_string();
                // A later key wins, as an object assignment does.
                meta.retain(|(k, _)| *k != key);
                meta.push((key, value));
            }
        }
    }
    let get = |k: &str| meta.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    let nonempty = |k: &str| get(k).filter(|v| !v.is_empty());
    let stamp = |k: &str| {
        let n = get(k).map(js::string_to_number).unwrap_or(f64::NAN);
        if js::truthy_number(n) { n } else { nekko_js::now_ms_f64() }
    };
    let mut m = Map::new();
    m.insert("id".into(), json!(nonempty("id").unwrap_or(fallback_id)));
    m.insert("scope".into(), json!(nonempty("scope").unwrap_or("global")));
    if let Some(w) = nonempty("workspaceId") {
        m.insert("workspaceId".into(), json!(w));
    }
    m.insert("title".into(), json!(unescape(nonempty("title").unwrap_or("Untitled"))));
    m.insert("body".into(), json!(body));
    m.insert("tags".into(), json!(tags(get("tags"))));
    let num = |n: f64| if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) };
    m.insert("createdAt".into(), num(stamp("createdAt")));
    m.insert("updatedAt".into(), num(stamp("updatedAt")));
    Value::Object(m)
}

/// `listMemory(scope, workspaceId)` over `<data>/memory/*.md`, newest first.
pub fn list_memory(data_dir: &Path, scope: &str, workspace_id: Option<&str>) -> Vec<Value> {
    let dir = data_dir.join("memory");
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Value> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".md")?.to_string();
            let text = String::from_utf8_lossy(&std::fs::read(e.path()).ok()?).into_owned();
            Some(parse_memory(&text, &id))
        })
        .filter(|m| {
            m["scope"] == scope && (scope == "global" || m.get("workspaceId").and_then(Value::as_str) == workspace_id)
        })
        .collect();
    let at = |v: &Value| v["updatedAt"].as_f64().unwrap_or(f64::NAN);
    out.sort_by(|a, b| at(b).partial_cmp(&at(a)).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_the_way_the_ts_regex_does() {
        let m = parse_memory(
            "---\nid: m1\nscope: workspace\nworkspaceId: w1\ntitle: \"A: b \\\"q\\\"\"\ntags: [x, , y]\ncreatedAt: 0x10\nupdatedAt: 20\n---\n\n  body text \n",
            "file",
        );
        assert_eq!(m["id"], "m1");
        assert_eq!(m["title"], "A: b \"q\"");
        assert_eq!(m["tags"], json!(["x", "y"]));
        assert_eq!(m["createdAt"], 16);
        assert_eq!(m["body"], "body text");
        // No frontmatter (a CRLF file does not match): the whole text is the body, untrimmed.
        let crlf = parse_memory("---\r\nid: x\r\n---\r\nbody", "fallback");
        assert_eq!(
            (crlf["id"].clone(), crlf["body"].clone()),
            (json!("fallback"), json!("---\r\nid: x\r\n---\r\nbody"))
        );
    }
}

/// Which memory notes a chat's turns take (`Session.memory`): every note
/// (global and its folders'), only its folders', or none. An incognito chat
/// takes none, whatever it is set to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MemoryScope {
    All,
    Project,
    Off,
}

impl MemoryScope {
    pub fn of_session(session: &Value) -> Self {
        if js::truthy(session.get("incognito")) {
            return Self::Off;
        }
        match session.get("memory").and_then(Value::as_str) {
            Some("project") => Self::Project,
            Some("off") => Self::Off,
            _ => Self::All,
        }
    }

    pub fn global(self) -> bool {
        self == Self::All
    }

    pub fn project(self) -> bool {
        self != Self::Off
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[test]
    fn memory_scope_follows_the_chat_and_incognito() {
        assert_eq!(MemoryScope::of_session(&json!({})), MemoryScope::All);
        assert_eq!(MemoryScope::of_session(&json!({ "memory": "project" })), MemoryScope::Project);
        assert_eq!(MemoryScope::of_session(&json!({ "memory": "off" })), MemoryScope::Off);
        assert_eq!(MemoryScope::of_session(&json!({ "memory": "all", "incognito": true })), MemoryScope::Off);
        assert!(!MemoryScope::Project.global() && MemoryScope::Project.project());
    }
}
