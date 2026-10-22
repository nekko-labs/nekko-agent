//! The Rust context against the TS host's.
//!
//! `golden/expected.json` is a frozen record of what the deleted TS
//! `collectGuidelines`, `collectAttached`, `listMemory`, `assembleContext`,
//! `renderContextBlock` and `buildSystemPrompt` gave on a tree materialized
//! from `golden/fixtures.json`; edit it by hand per
//! docs/runbooks/golden-fixtures.md. This test builds the same
//! tree, runs the ports, and must produce the same JSON after the same
//! normalization (the temp root, and backslashes as slashes).

use nekko_context::{
    AssembleInput, PromptContext, Workspace, assemble, build_system_prompt, collect_attached, collect_guidelines,
    list_memory, nodepath, render_block,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;

fn golden() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|&c| c != b'=') {
        buf = (buf << 6) | A.iter().position(|&a| a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[test]
fn builds_the_turn_context_exactly_as_the_ts_host_does() {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(golden().join("fixtures.json")).unwrap()).unwrap();
    let root = std::env::temp_dir().join(format!("nekko-context-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    for (rel, f) in fx["files"].as_object().unwrap() {
        let p = root.join(rel);
        if f["dir"] == true {
            std::fs::create_dir_all(&p).unwrap();
            continue;
        }
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let bytes = match f["base64"].as_str() {
            Some(s) => b64(s),
            None => f["text"].as_str().unwrap_or("").repeat(f["repeat"].as_u64().unwrap_or(1) as usize).into_bytes(),
        };
        std::fs::write(&p, bytes).unwrap();
    }
    let root_s = root.to_string_lossy().into_owned();
    let ws: Vec<(String, String, String)> = fx["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            (
                w["id"].as_str().unwrap().into(),
                w["name"].as_str().unwrap().into(),
                format!("{root_s}/{}", w["rel"].as_str().unwrap()),
            )
        })
        .collect();
    // The prompt lists fixed paths: its token count must not depend on the temp dir.
    let workspaces: Vec<Workspace> = fx["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| Workspace {
            name: w["name"].as_str().unwrap().into(),
            path: format!("/fixture/{}", w["rel"].as_str().unwrap()),
        })
        .collect();
    let expand = |id: &str| -> String {
        if let Some(rest) = id.strip_prefix("guideline:<")
            && let Some((key, name)) = rest.split_once(">/")
        {
            let w = ws.iter().find(|(id, _, _)| id.replace('w', "ws") == key).unwrap();
            return format!("guideline:{}", nodepath::join(&w.2, name));
        }
        id.to_string()
    };

    let guidelines = collect_guidelines(&ws.iter().map(|w| w.2.clone()).collect::<Vec<_>>());
    let attached = collect_attached(
        &fx["attached"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| nodepath::join(&root_s, a.as_str().unwrap()))
            .collect::<Vec<_>>(),
    );
    let data = root.join("data");
    let mut memory = list_memory(&data, "global", None);
    memory.extend(list_memory(&data, "workspace", Some("w1")));
    let system =
        build_system_prompt(&PromptContext { workspaces: &workspaces, platform: "win32", ..Default::default() });
    let triples = |key: &str, a: &str, b: &str, c: &str| -> Vec<(String, String, String)> {
        fx[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s[a].as_str().unwrap().into(), s[b].as_str().unwrap().into(), s[c].as_str().unwrap().into()))
            .collect()
    };
    let history = fx["history"].as_array().unwrap().clone();
    let bundle = assemble(AssembleInput {
        attached: attached.clone(),
        guidelines: guidelines.iter().map(|g| (g.path.clone(), g.content.clone())).collect(),
        rule_indexes: Vec::new(),
        memory: memory.clone(),
        connector_snippets: triples("connectorSnippets", "label", "origin", "body"),
        index_snippets: triples("indexSnippets", "relPath", "path", "body"),
        history: Some(&history),
        system_text: Some(&system),
        context_window: Some(fx["contextWindow"].clone()),
        excluded: fx["excluded"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| expand(e.as_str().unwrap()))
            .collect::<HashSet<_>>(),
        pinned: fx["pinned"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string()).collect(),
    });
    let block = render_block(&bundle);
    let prompts: Vec<String> = fx["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let fixture = p["workspaces"] == "fixture";
            build_system_prompt(&PromptContext {
                workspaces: if fixture { &workspaces } else { &[] },
                context_block: if p["contextBlock"] == "rendered" {
                    &block
                } else {
                    p["contextBlock"].as_str().unwrap()
                },
                platform: p["platform"].as_str().unwrap(),
                orchestration_hint: p["orchestrationHint"].as_str().unwrap_or(""),
                can_ask: p["canAsk"] == true,
                can_plan: p["canPlan"] == true,
                system_instructions: p["systemInstructions"].as_str(),
                turn_wrapper: p["turnWrapper"].as_str(),
                about_user: p["aboutUser"].as_str(),
                checkout_notice: p["checkoutNotice"].as_str(),
            })
        })
        .collect();
    let out = json!({
        "guidelines": guidelines.iter().map(|g| json!({ "path": g.path, "content": g.content })).collect::<Vec<_>>(),
        "attached": attached.iter().map(|(p, c)| json!({ "path": p, "content": c })).collect::<Vec<_>>(),
        "memory": memory,
        "bundle": bundle.to_json(),
        "block": block,
        "prompts": prompts,
    });
    let root_json = serde_json::to_string(&root_s).unwrap();
    let text = serde_json::to_string_pretty(&out)
        .unwrap()
        .replace(&root_json[1..root_json.len() - 1], "<root>")
        .replace("\\\\", "/");
    let actual: Value = serde_json::from_str(&text).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(golden().join("expected.json")).unwrap()).unwrap();
    for key in ["guidelines", "attached", "memory", "prompts", "bundle", "block"] {
        assert_eq!(actual[key], expected[key], "{key} differs");
    }
    std::fs::remove_dir_all(&root).ok();
}
