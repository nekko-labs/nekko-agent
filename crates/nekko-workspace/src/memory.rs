//! Memory notes, ported from `packages/host/src/memory.ts` and
//! `serializeMemory` in `packages/core/src/memory/store.ts`:
//! `memory:list`, `memory:save`, `memory:delete`.
//!
//! One markdown file per note under `<data>/memory`, the format the turn
//! context reads (`nekko_context::list_memory`, which this listing reuses).
//! Unlike the TS functions, an id that would leave the folder is refused.

use nekko_js as js;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::now_ms;

fn mem_dir(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = data_dir.join("memory");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// An id names one file in the memory folder and nothing else.
fn file_of(data_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) || (cfg!(windows) && id.contains(':'))
    {
        return Err(format!("Invalid memory id: {id}"));
    }
    Ok(mem_dir(data_dir)?.join(format!("{id}.md")))
}

/// `listMemory(scope, workspaceId)`: the scope's notes, newest first; a
/// workspace note only for its own workspace. `scope` and `workspaceId` are
/// compared strictly, as the TS filter does.
pub fn list(data_dir: &Path, scope: Option<&Value>, workspace_id: Option<&Value>) -> Vec<Value> {
    let _ = mem_dir(data_dir);
    let Some(Value::String(scope)) = scope else { return Vec::new() };
    // `m.workspaceId === workspaceId`: a note without one matches only `undefined`.
    let wid = match workspace_id {
        None => Some(None),
        Some(Value::String(s)) => Some(Some(s.as_str())),
        Some(_) => None,
    };
    if scope != "global" && wid.is_none() {
        return Vec::new();
    }
    nekko_context::list_memory(data_dir, scope, wid.flatten())
}

/// `${v}` for a field that may be missing (`undefined`).
fn show(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::display)
}

/// `[...].join(...)` prints `null` and `undefined` elements as nothing.
fn join_elem(v: &Value) -> String {
    if v.is_null() { String::new() } else { js::display(v) }
}

/// `escapeYaml`: quote a title holding `:` or `#`.
fn escape_yaml(v: Option<&Value>) -> Result<String, String> {
    let text = show(v);
    if !text.contains([':', '#']) {
        return Ok(text);
    }
    match v {
        Some(Value::String(s)) => Ok(format!("\"{}\"", s.replace('"', "\\\""))),
        _ => Err("s.replace is not a function".into()),
    }
}

/// `serializeMemory(entry)`.
pub fn serialize(entry: &Map<String, Value>) -> Result<String, String> {
    let get = |k: &str| entry.get(k);
    let tags = match get("tags") {
        Some(Value::Array(a)) => a.iter().map(join_elem).collect::<Vec<_>>().join(", "),
        None => return Err("Cannot read properties of undefined (reading 'join')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'join')".into()),
        Some(_) => return Err("entry.tags.join is not a function".into()),
    };
    let mut lines: Vec<Option<String>> = vec![
        Some("---".into()),
        Some(format!("id: {}", show(get("id")))),
        Some(format!("scope: {}", show(get("scope")))),
        js::truthy(get("workspaceId")).then(|| format!("workspaceId: {}", show(get("workspaceId")))),
        Some(format!("title: {}", escape_yaml(get("title"))?)),
        Some(format!("tags: [{tags}]")),
        Some(format!("createdAt: {}", show(get("createdAt")))),
        Some(format!("updatedAt: {}", show(get("updatedAt")))),
        Some("---".into()),
        Some(String::new()),
    ];
    // `.filter((l) => l !== null)` also drops a `null` body.
    lines.push(match get("body") {
        Some(Value::Null) => None,
        other => Some(other.map(js::display).unwrap_or_default()),
    });
    lines.push(Some(String::new()));
    Ok(lines.into_iter().flatten().collect::<Vec<_>>().join("\n"))
}

/// `saveMemory(entry)` then `listMemory(entry.scope, entry.workspaceId)`,
/// which is what the channel returns.
pub fn save(data_dir: &Path, entry: &Value) -> Result<Vec<Value>, String> {
    let Value::Object(entry) = entry else {
        return Err("Cannot set properties of undefined (setting 'updatedAt')".into());
    };
    let mut entry = entry.clone();
    entry.insert("updatedAt".into(), Value::from(now_ms()));
    let file = file_of(data_dir, &show(entry.get("id")))?;
    let text = serialize(&entry)?;
    crate::write_atomic(&file, text.as_bytes())?;
    Ok(list(data_dir, entry.get("scope"), entry.get("workspaceId")))
}

/// `deleteMemory(id)`: a note that is not there is not an error.
pub fn delete(data_dir: &Path, id: Option<&Value>) -> Result<(), String> {
    let file = file_of(data_dir, &show(id))?;
    match std::fs::remove_file(&file) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_like_the_ts_function() {
        let e = json!({ "id": "m1", "scope": "global", "workspaceId": "", "title": "a: b", "tags": ["x", null, 2], "createdAt": 1, "updatedAt": 2, "body": "hi" });
        assert_eq!(
            serialize(e.as_object().unwrap()).unwrap(),
            "---\nid: m1\nscope: global\ntitle: \"a: b\"\ntags: [x, , 2]\ncreatedAt: 1\nupdatedAt: 2\n---\n\nhi\n"
        );
    }

    #[test]
    fn refuses_ids_that_leave_the_folder() {
        let dir = std::env::temp_dir().join(format!("nekko-mem-{}", now_ms()));
        assert!(delete(&dir, Some(&json!("../x"))).is_err());
        assert!(delete(&dir, Some(&json!("ok"))).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
