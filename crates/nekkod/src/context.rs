//! The Context panel, served by the daemon (PF14): `context:preview`,
//! `context:toggle` and `context:setPrefs`.
//!
//! A port of `previewContext` and `setContextPrefs` (chat.ts): the base
//! system prompt and every context item a turn would send (attached files,
//! guidelines, memory, connector snippets, the transcript since the latest
//! compaction), counted against the model's window, with the chat's include
//! and pin choices, assembled by `nekko-context` from disk. Connector
//! snippets are asked of the host only when a connector is connected, until
//! connectors move. A sandbox chat's preview is the host's (its folders are
//! the container's copies).

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const CHANNELS: &[&str] = &["context:preview", "context:toggle", "context:setPrefs"];

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// `guessContextWindow` (model-capabilities.ts): a model's window from its id alone.
pub fn guess_context_window(model_id: Option<&str>) -> u64 {
    static RES: OnceLock<[regress::Regex; 3]> = OnceLock::new();
    let res = RES.get_or_init(|| {
        let re = |p: &str| regress::Regex::new(p).expect("a valid pattern");
        [
            re(r"(?:^|\/)gpt-5\.6-(?:sol|terra|luna)(?:$|[-/])"),
            re(r"(?:^|\/)gpt-5(?:-(?:mini|nano|codex))?(?:$|-\d{4}-\d{2}-\d{2}$)"),
            re(r"(?:^|\/)o[34](?:$|[-/])"),
        ]
    });
    let id = model_id.unwrap_or_default().to_lowercase();
    if id.is_empty() {
        return 128_000;
    }
    if let Some(w) = nekko_agent::claude::claude_context_window(&id) {
        return w;
    }
    // Claude Code's model aliases (a Claude Agent chat's model): each names the
    // newest model of its family, and every current one holds 1M.
    if matches!(id.as_str(), "opus" | "sonnet" | "haiku") {
        return 1_000_000;
    }
    if id.contains("claude") {
        return 200_000;
    }
    if id.contains("gemini") {
        return 1_000_000;
    }
    if res[0].find(&id).is_some() {
        return 272_000;
    }
    if res[1].find(&id).is_some() {
        return 400_000;
    }
    if id.contains("gpt-4.1") {
        return 1_047_576;
    }
    if res[2].find(&id).is_some() {
        return 200_000;
    }
    128_000
}

/// `sinceCompaction`: the latest compaction summary and what follows it.
fn since_compaction(messages: &[Value]) -> &[Value] {
    match messages.iter().rposition(|m| nekko_js::truthy(m.get("compaction"))) {
        Some(i) => &messages[i..],
        None => messages,
    }
}

/// The window Claude Code reported for a Claude Agent chat's current model
/// (`claudeCodeContext`, saved after each of its turns); `None` before the
/// first turn or once the chat's model changed, when the alias guess stands.
pub fn claude_code_window(session: Option<&Value>, model: Option<&str>) -> Option<u64> {
    let reported = session?.get("claudeCodeContext")?;
    (reported.get("modelId").and_then(Value::as_str) == model).then_some(())?;
    reported.get("window").and_then(Value::as_u64).filter(|w| *w > 0)
}

/// `previewContext(sessionId, attachedPaths)`, given what it reads.
pub fn preview(
    data_dir: &std::path::Path,
    session: Option<&Value>,
    settings: &Value,
    attached_paths: &[String],
    connector_snippets: &[Value],
    platform: &str,
) -> Value {
    let workspaces = crate::worktrees::chat_workspaces(session, settings);
    let folders: Vec<nekko_context::Workspace> = workspaces
        .iter()
        .map(|w| nekko_context::Workspace { name: s(w, "name").to_string(), path: s(w, "path").to_string() })
        .collect();
    let catalog = nekko_turn::catalog::catalog();
    let turn_wrapper = match settings.get("turnWrapper") {
        Some(Value::String(t)) => t.clone(),
        Some(v) if !v.is_null() => nekko_js::display(v),
        _ => catalog.default_turn_wrapper.clone(),
    };
    let system_text = nekko_context::build_system_prompt(&nekko_context::PromptContext {
        workspaces: &folders,
        system_instructions: settings.get("systemInstructions").and_then(Value::as_str),
        turn_wrapper: Some(&turn_wrapper),
        about_user: settings.get("aboutUser").and_then(Value::as_str),
        context_block: "",
        platform,
        ..Default::default()
    });
    let mut attached = strings(session.and_then(|s| s.get("attachedPaths")));
    attached.extend(attached_paths.iter().cloned());
    let paths: Vec<String> = workspaces.iter().map(|w| s(w, "path").to_string()).collect();
    let mut memory = nekko_context::list_memory(data_dir, "global", None);
    for id in session.map(crate::worktrees::session_workspace_ids).unwrap_or_default() {
        memory.extend(nekko_context::list_memory(data_dir, "workspace", Some(&id)));
    }
    let messages = session.and_then(|s| s.get("messages")).and_then(Value::as_array).cloned().unwrap_or_default();
    let history = since_compaction(&messages);
    let prefs = session.and_then(|s| s.get("contextPrefs"));
    let model = session.and_then(|s| s.get("modelId")).and_then(Value::as_str);
    let triple = |v: &Value| {
        let f = |k: &str| v.get(k).map(nekko_js::display).unwrap_or_default();
        (f("label"), f("origin"), f("body"))
    };
    let bundle = nekko_context::assemble(nekko_context::AssembleInput {
        attached: nekko_context::collect_attached(&attached),
        guidelines: nekko_context::collect_guidelines(&paths).into_iter().map(|g| (g.path, g.content)).collect(),
        memory,
        connector_snippets: connector_snippets.iter().map(triple).collect(),
        index_snippets: Vec::new(),
        history: Some(history),
        system_text: Some(&system_text),
        context_window: Some(json!(claude_code_window(session, model).unwrap_or_else(|| guess_context_window(model)))),
        excluded: strings(prefs.and_then(|p| p.get("excluded"))).into_iter().collect::<HashSet<_>>(),
        pinned: strings(prefs.and_then(|p| p.get("pinned"))).into_iter().collect::<HashSet<_>>(),
    });
    // The inspector draws previews; the full text stays here.
    let mut out = bundle.to_json();
    if let Some(m) = out.as_object_mut() {
        m.shift_remove("contents");
    }
    out
}

pub async fn route(ctx: &Ctx, channel: &str, args: Vec<Value>) -> Result<Value, String> {
    let store = ctx.sessions.clone().ok_or("context needs the data directory")?;
    let sid = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    if channel == "context:setPrefs" {
        let prefs = args.get(1).cloned().unwrap_or(Value::Null);
        tokio::task::spawn_blocking(move || store.set_context_prefs(&sid, &prefs))
            .await
            .map_err(|e| e.to_string())??;
        return Ok(Value::Null);
    }
    let attached = if channel == "context:preview" { strings(args.get(1)) } else { Vec::new() };
    let session = {
        let (st, id) = (store.clone(), sid.clone());
        tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?
    };
    if session.as_ref().is_some_and(|s| crate::worktrees::execution_mode(s) == "sandbox") {
        return Err(format!("{channel} is unsupported for sandbox sessions"));
    }
    let settings = crate::settings::current(ctx).await;
    let connected = settings
        .get("connectors")
        .and_then(Value::as_array)
        .is_some_and(|cs| cs.iter().any(|c| nekko_js::truthy(c.get("connected")) && nekko_js::truthy(c.get("token"))));
    let offline = session.as_ref().is_some_and(|s| nekko_js::truthy(s.get("offline")));
    let connector = if session.is_none() || offline || !connected {
        Vec::new()
    } else {
        crate::connectors::snippets(ctx, None, session.as_ref().unwrap_or(&Value::Null)).await
    };
    let data_dir: PathBuf = store.dir().parent().map(PathBuf::from).unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        Ok(preview(&data_dir, session.as_ref(), &settings, &attached, &connector, crate::admission::platform()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn normalize(v: &Value, root: &str) -> Value {
        match v {
            Value::String(t) => json!(t.replace(root, "<root>").replace('\\', "/")),
            Value::Array(a) => Value::Array(a.iter().map(|x| normalize(x, root)).collect()),
            Value::Object(m) => Value::Object(
                m.iter().map(|(k, x)| (k.replace(root, "<root>").replace('\\', "/"), normalize(x, root))).collect(),
            ),
            other => other.clone(),
        }
    }

    /// The same tree and cases as packages/host/src/context-preview.golden.test.ts,
    /// which writes `expected.json` from the real `previewContext`.
    #[test]
    fn every_preview_matches_the_ts_host() {
        let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/context-preview");
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(golden.join("fixtures.json")).unwrap()).unwrap();
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(golden.join("expected.json")).unwrap()).unwrap();
        // Match the host fixture: the prompt counts each absolute path.
        let outer = std::env::temp_dir().join(format!("nekkod-ctx-preview-{}", std::process::id()));
        let padding =
            127usize.checked_sub(outer.to_string_lossy().encode_utf16().count()).expect("temporary path fits fixture");
        let root_dir = outer.join("x".repeat(padding));
        assert_eq!(root_dir.to_string_lossy().encode_utf16().count(), 128);
        let _ = std::fs::remove_dir_all(&outer);
        let root = root_dir.to_string_lossy().into_owned();
        let fill = |v: &Value| -> Value {
            // Inside JSON text a backslash is written twice.
            serde_json::from_str(&v.to_string().replace("<root>", &root.replace('\\', "\\\\"))).unwrap()
        };
        for (rel, text) in fx["files"].as_object().unwrap() {
            let p = root_dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text.as_str().unwrap()).unwrap();
        }
        let data = root_dir.join("data");
        let settings = nekko_settings::merge(&nekko_settings::defaults(), &fill(&fx["settings"])).unwrap();
        let settings = Value::Object(settings);
        let sessions: Vec<Value> = fx["sessions"].as_array().unwrap().iter().map(fill).collect();
        for (i, c) in fx["cases"].as_array().unwrap().iter().enumerate() {
            let session = c["session"].as_str().and_then(|id| sessions.iter().find(|s| s["id"] == id));
            let attached: Vec<String> =
                fill(&c["attached"]).as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            let got = normalize(&preview(&data, session, &settings, &attached, &[], "linux"), &root);
            assert_eq!(nekko_js::stringify(&got), nekko_js::stringify(&expected[i]), "case {i}");
        }
        let _ = std::fs::remove_dir_all(&root_dir);
    }

    #[test]
    fn context_windows_are_guessed_as_the_ts_host_does() {
        assert_eq!(guess_context_window(None), 128_000);
        assert_eq!(guess_context_window(Some("gpt-5")), 400_000);
        assert_eq!(guess_context_window(Some("openai/gpt-5-mini")), 400_000);
        assert_eq!(guess_context_window(Some("gpt-5.6-sol")), 272_000);
        assert_eq!(guess_context_window(Some("gpt-4.1-mini")), 1_047_576);
        assert_eq!(guess_context_window(Some("o3")), 200_000);
        assert_eq!(guess_context_window(Some("gemini-3-pro")), 1_000_000);
        assert_eq!(guess_context_window(Some("some-claude-gateway")), 200_000);
        assert_eq!(guess_context_window(Some("opus")), 1_000_000);
        assert_eq!(guess_context_window(Some("Sonnet")), 1_000_000);
        assert_eq!(guess_context_window(Some("haiku")), 1_000_000);
        assert_eq!(guess_context_window(Some("my-opus")), 128_000);
    }

    #[test]
    fn a_claude_agent_chat_uses_the_window_claude_code_reported_for_its_model() {
        let session =
            json!({ "modelId": "opus", "claudeCodeContext": { "used": 30_000, "window": 200_000, "modelId": "opus" } });
        assert_eq!(claude_code_window(Some(&session), Some("opus")), Some(200_000));
        // Switched model, or no turn yet: the guess stands.
        assert_eq!(claude_code_window(Some(&session), Some("sonnet")), None);
        assert_eq!(claude_code_window(Some(&json!({ "modelId": "opus" })), Some("opus")), None);
    }
}
