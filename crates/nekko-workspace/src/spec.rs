//! Spec-driven development, ported from `packages/host/src/spec.ts` and the
//! pure helpers of `@nekko-agent/shared` spec.ts: `spec:path`,
//! `spec:readDocs`, `spec:setMethodology`, `spec:toggleTask`, and the
//! prompt and landing halves of `spec:build` / `spec:buildDoc` (the model
//! call is the daemon's). The methodologies come from the TS source
//! (`spec-data.json`, written by packages/host/src/spec.golden.test.ts).
//!
//! These read and write the chat's project files (`spec.md`, `tasks.md`...),
//! never the app's data, and refuse sandbox chats as the host does.

use nekko_js as js;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

const DATA: &str = include_str!("spec-data.json");

fn methodologies() -> &'static [Value] {
    static D: OnceLock<Vec<Value>> = OnceLock::new();
    D.get_or_init(|| {
        serde_json::from_str::<Value>(DATA)
            .ok()
            .and_then(|v| v["methodologies"].as_array().cloned())
            .unwrap_or_default()
    })
}

/// `getMethodology(id)`: the default when the id names none.
pub fn methodology(id: Option<&Value>) -> Value {
    let all = methodologies();
    id.and_then(|id| all.iter().find(|m| m.get("id") == Some(id)))
        .or_else(|| all.first())
        .cloned()
        .unwrap_or(Value::Null)
}

/// `assertHostExecution(sessionId, action)`: a chat that is not there, or
/// runs in a sandbox, has no host file access.
pub fn assert_host(session_id: &str, session: &Value, action: &str) -> Result<(), String> {
    if !session_id.is_empty() && session.is_null() {
        return Err(format!("{action}: session not found. No host fallback."));
    }
    if session.get("executionMode").and_then(Value::as_str) == Some("sandbox") {
        return Err(format!(
            "{action} is unsupported in sandbox sessions. Use scoped container file and bash tools. No host fallback."
        ));
    }
    Ok(())
}

/// The chat's own methodology, else the settings' default.
fn methodology_for(session: &Value, settings: &Value) -> Value {
    methodology(js::coalesce(session.get("specMethodology"), settings.get("specMethodology")))
}

fn docs(m: &Value) -> Vec<Value> {
    m.get("docs").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `getSessionWorkspaceIds(session)`.
fn session_workspace_ids(session: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let primary = session.get("workspaceId").filter(|v| js::truthy(Some(v)));
    let supporting = session.get("supportingWorkspaceIds").and_then(Value::as_array).cloned().unwrap_or_default();
    for v in primary.into_iter().chain(supporting.iter().filter(|v| js::truthy(Some(v)))) {
        let id = js::display(v);
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// The folder a spec action works in: the asked-for workspace when the chat
/// uses it, else the chat's primary one.
fn target_folder(session: &Value, settings: &Value, workspace_id: Option<&str>) -> Option<String> {
    let target = match workspace_id.filter(|w| !w.is_empty()) {
        Some(w) if session_workspace_ids(session).iter().any(|id| id == w) => Some(w.to_string()),
        _ => session.get("workspaceId").filter(|v| js::truthy(Some(v))).map(js::display),
    }?;
    settings
        .get("workspaces")
        .and_then(Value::as_array)?
        .iter()
        .find(|w| w.get("id").and_then(Value::as_str) == Some(target.as_str()))
        .and_then(|w| w.get("path"))
        .map(js::display)
}

fn workspace_path(session: &Value, settings: &Value, filename: &str, workspace_id: Option<&str>) -> Option<String> {
    target_folder(session, settings, workspace_id).map(|f| path::join(&[&f, filename]))
}

/// `specPathForSession(sessionId)`.
pub fn spec_path(session_id: &str, session: &Value, settings: &Value) -> Result<Value, String> {
    assert_host(session_id, session, "Host spec access")?;
    let m = methodology_for(session, settings);
    let first = docs(&m).first().and_then(|d| d.get("filename")).map(js::display).unwrap_or_default();
    assert_host(session_id, session, "Host spec access")?;
    Ok(workspace_path(session, settings, &first, None).map_or(Value::Null, Value::String))
}

/// `readSpecDocs(sessionId, workspaceId)`.
pub fn read_docs(
    session_id: &str,
    session: &Value,
    settings: &Value,
    workspace_id: Option<&str>,
) -> Result<Value, String> {
    assert_host(session_id, session, "Host spec access")?;
    let m = methodology_for(session, settings);
    let mut out = Vec::new();
    for d in docs(&m) {
        let filename = d.get("filename").map(js::display).unwrap_or_default();
        let wp = workspace_path(session, settings, &filename, workspace_id);
        let p = wp.clone().unwrap_or_else(|| filename.clone());
        let exists = wp.is_some() && nodefs::exists(&p);
        let content = if exists { nodefs::read_utf8(&p).unwrap_or_default() } else { String::new() };
        let mut entry = d.as_object().cloned().unwrap_or_default();
        entry.insert("path".into(), json!(p));
        entry.insert("exists".into(), json!(exists));
        entry.insert("content".into(), json!(content));
        out.push(Value::Object(entry));
    }
    Ok(json!({ "methodologyId": m.get("id").cloned().unwrap_or(Value::Null), "docs": out }))
}

/// The id `setSpecMethodology` saves for a requested one.
pub fn methodology_id(requested: Option<&Value>) -> Value {
    methodology(requested).get("id").cloned().unwrap_or(Value::Null)
}

fn task_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\s*[-*]\s*)\[([ xX])\]\s?(.*)$").expect("task pattern compiles"))
}

/// `toggleTaskLine(markdown, lineIndex)`.
pub fn toggle_task_line(markdown: &str, line_index: &Value) -> String {
    let mut lines: Vec<String> = markdown.split('\n').map(str::to_string).collect();
    // `lines[lineIndex]`: an array index, as a number or its canonical string.
    let index = match line_index {
        Value::Number(n) => n.as_f64().filter(|f| f.fract() == 0.0 && *f >= 0.0).map(|f| f as usize),
        Value::String(s)
            if s == "0" || (!s.starts_with('0') && !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) =>
        {
            s.parse().ok()
        }
        _ => None,
    };
    let Some(i) = index.filter(|i| *i < lines.len()) else { return markdown.to_string() };
    let line = lines[i].clone();
    let Some(m) = task_re().find(&line) else { return markdown.to_string() };
    let g = |n: usize| m.group(n).map(|r| line[r].to_string()).unwrap_or_default();
    let checked = g(2).to_lowercase() == "x";
    lines[i] = format!("{}[{}] {}", g(1), if checked { " " } else { "x" }, g(3));
    lines.join("\n")
}

/// `toggleSpecTask(sessionId, lineIndex, workspaceId)`.
pub fn toggle_task(
    session_id: &str,
    session: &Value,
    settings: &Value,
    line_index: &Value,
    workspace_id: Option<&str>,
) -> Result<Value, String> {
    assert_host(session_id, session, "Host spec access")?;
    let m = methodology_for(session, settings);
    let Some(tasks) = docs(&m).into_iter().find(|d| d.get("role") == Some(&json!("tasks"))) else {
        return Ok(json!({ "ok": false, "message": "This methodology has no tasks document." }));
    };
    let filename = tasks.get("filename").map(js::display).unwrap_or_default();
    assert_host(session_id, session, "Host spec access")?;
    let Some(p) = workspace_path(session, settings, &filename, workspace_id).filter(|p| nodefs::exists(p)) else {
        return Ok(json!({ "ok": false, "message": "Build the tasks document first." }));
    };
    let result = nodefs::read_utf8(&p).and_then(|text| nodefs::write_utf8(&p, &toggle_task_line(&text, line_index)));
    Ok(match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "message": e }),
    })
}

fn role_guidance(role: &str) -> &'static str {
    match role {
        "plan" => {
            "Write a technical plan, HOW we'll build what the spec describes.\nUse sections like: Architecture, Stack & Key Decisions, Data Model, Conventions, and Risks.\nGround it in the spec (provided below). Do not restate the spec; reference it."
        }
        "tasks" => {
            "Write an implementation task list as a markdown checklist.\nBreak the work into small, independently reviewable, testable items, each on its own line as \"- [ ] <task>\".\nGroup related items under `##` headings. Order them so dependencies come first. Be concrete and concise.\nDerive the tasks from the spec (and plan, if present) provided below."
        }
        "spec" => {
            "Write a clear, well-structured spec, the source of truth for WHAT we're building and WHY.\nUse sections like: Overview, Goals, Users, Requirements (or user stories with acceptance criteria), and Open Questions.\nKeep it about the product, not the implementation."
        }
        _ => "undefined",
    }
}

/// What a spec build sends the model, and where its answer goes.
#[derive(Debug, Clone)]
pub struct BuildPlan {
    pub provider_id: Value,
    pub model: String,
    pub system: String,
    pub prompt: String,
    pub path: String,
    pub doc_id: Value,
}

/// The checks and the request `buildSpecDoc` makes before calling the model:
/// `Err` is the `{ ok: false, message }` answer, or a thrown error.
pub fn build_plan(
    session_id: &str,
    session: &Value,
    settings: &Value,
    doc_id: Option<&Value>,
    workspace_id: Option<&str>,
) -> Result<Result<BuildPlan, Value>, String> {
    assert_host(session_id, session, "Host spec access")?;
    let refuse = |m: &str| Ok(Err(json!({ "ok": false, "message": m })));
    if session.is_null() {
        return refuse("Session not found.");
    }
    let has_target = match workspace_id.filter(|w| !w.is_empty()) {
        Some(w) => session_workspace_ids(session).iter().any(|id| id == w) || js::truthy(session.get("workspaceId")),
        None => js::truthy(session.get("workspaceId")),
    };
    if !has_target {
        return refuse("Add a project folder to this chat first.");
    }
    let Some(folder) = target_folder(session, settings, workspace_id) else { return refuse("Workspace not found.") };
    let provider_id = session.get("providerId").cloned().unwrap_or(Value::Null);
    let has_provider = settings
        .get("providers")
        .and_then(Value::as_array)
        .is_some_and(|ps| ps.iter().any(|p| p.get("id") == Some(&provider_id)));
    if !has_provider || !js::truthy(session.get("modelId")) {
        return refuse("Pick a provider and model, then chat first.");
    }
    assert_host(session_id, session, "Host spec access")?;
    let m = methodology_for(session, settings);
    let all = docs(&m);
    let doc = match doc_id.filter(|d| js::truthy(Some(d))) {
        Some(id) => all.iter().find(|d| d.get("id") == Some(id)).cloned(),
        None => all.first().cloned(),
    };
    let Some(doc) = doc else { return refuse("Unknown spec document.") };
    let transcript: Vec<String> = session
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|msg| matches!(msg.get("role").and_then(Value::as_str), Some("user" | "assistant")))
        .map(|msg| {
            let who = if msg.get("role") == Some(&json!("user")) { "User" } else { "Assistant" };
            format!("## {who}\n{}", msg.get("content").map_or_else(|| "undefined".into(), js::display))
        })
        .collect();
    let transcript = js::slice16(&transcript.join("\n\n"), 60000).to_string();
    if js::trim(&transcript).is_empty() {
        return refuse("Nothing to build a spec from yet.");
    }
    let at = all.iter().position(|d| d == &doc).unwrap_or(0);
    let prior: Vec<String> = all[..at]
        .iter()
        .filter_map(|d| {
            let filename = d.get("filename").map(js::display).unwrap_or_default();
            let p = path::join(&[&folder, &filename]);
            if !nodefs::exists(&p) {
                return None;
            }
            let text = nodefs::read_utf8(&p).ok()?;
            let label = d.get("label").map(js::display).unwrap_or_default();
            Some(format!("### {label} ({filename})\n\n{}", js::slice16(&text, 20000)))
        })
        .collect();
    let filename = doc.get("filename").map(js::display).unwrap_or_default();
    let role = doc.get("role").and_then(Value::as_str).unwrap_or_default();
    let label = m.get("label").map(js::display).unwrap_or_default();
    let system = format!(
        "You maintain a project's {filename}, part of a spec-driven development workflow (\"{label}\"), synthesized from an ongoing working conversation between a user and an AI assistant.\n{}\nIf an existing {filename} is provided, UPDATE it to reflect the latest conversation, keep still-valid content, revise what changed, add what's new.\nBe concise and concrete. Output ONLY the markdown for {filename}, with no preamble or code fences.",
        role_guidance(role)
    );
    let p = path::join(&[&folder, &filename]);
    let existing =
        if nodefs::exists(&p) { js::slice16(&nodefs::read_utf8(&p)?, 40000).to_string() } else { String::new() };
    let mut prompt = String::new();
    if !prior.is_empty() {
        prompt.push_str(&format!("Earlier artifacts in this workflow:\n\n{}\n\n===\n\n", prior.join("\n\n---\n\n")));
    }
    if !existing.is_empty() {
        prompt.push_str(&format!("Existing {filename}:\n\n{existing}\n\n---\n\n"));
    }
    prompt.push_str(&format!("Conversation so far:\n\n{transcript}\n\n---\n\nWrite the updated {filename}."));
    Ok(Ok(BuildPlan {
        provider_id,
        model: js::display(&session["modelId"]),
        system,
        prompt,
        path: p,
        doc_id: doc.get("id").cloned().unwrap_or(Value::Null),
    }))
}

/// The model's answer cleaned (`^```(markdown|md)?` and a closing fence
/// dropped, trimmed) and written: what `buildSpecDoc` returns.
pub fn land(session_id: &str, session: &Value, plan: &BuildPlan, raw: &str) -> Result<Value, String> {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    static CLOSE: OnceLock<Regex> = OnceLock::new();
    let open = OPEN.get_or_init(|| Regex::with_flags(r"^```(?:markdown|md)?\n?", "i").expect("compiles"));
    let close = CLOSE.get_or_init(|| Regex::with_flags(r"\n?```\s*$", "i").expect("compiles"));
    let mut out = raw.to_string();
    if let Some(m) = open.find(&out) {
        out.replace_range(m.range(), "");
    }
    if let Some(m) = close.find(&out) {
        out.replace_range(m.range(), "");
    }
    let out = js::trim(&out).to_string();
    if out.is_empty() {
        return Ok(json!({ "ok": false, "message": "The model returned an empty document." }));
    }
    assert_host(session_id, session, "Host spec write")?;
    nodefs::write_utf8(&plan.path, &format!("{out}\n"))?;
    let mut m = Map::new();
    m.insert("ok".into(), json!(true));
    m.insert("path".into(), json!(plan.path));
    m.insert("docId".into(), plan.doc_id.clone());
    Ok(Value::Object(m))
}
