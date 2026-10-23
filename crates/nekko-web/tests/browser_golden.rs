//! The Rust `browser` (dedicated mode) and `capture` tools against the TS
//! ones: `golden/browser.json` is a frozen record of the deleted TS
//! `executeTool` against a scripted desktop bridge (edit it by hand per
//! docs/runbooks/golden-fixtures.md). Same cases here, the same
//! normalization (`<ROOT>` for the project, `<OUT>` for its parent, `/`).

use nekko_tools::{BoxFuture, Cancel, ChatMode, SandboxMode, ToolCall, ToolContext, Workspace, approver_fn};
use nekko_web::browser::{Bridge, Browsers, browser_tool, capture_tool};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("browser.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

struct Scripted {
    reply: Value,
    requests: Mutex<Vec<Value>>,
}

impl Bridge for Scripted {
    fn post<'a>(&'a self, body: &'a Value, _cancel: &'a Cancel) -> BoxFuture<'a, Result<(bool, Value), String>> {
        self.requests.lock().unwrap().push(body.clone());
        let reply = self.reply.clone();
        Box::pin(async move {
            if let Some(t) = reply.get("throws") {
                return Err(t.as_str().unwrap().to_string());
            }
            Ok((reply["ok"] == json!(true), reply["body"].clone()))
        })
    }
}

fn escaped(p: &str) -> String {
    let s = serde_json::to_string(p).unwrap();
    s[1..s.len() - 1].to_string()
}

fn normalizer(project: String, root: String) -> impl Fn(&str) -> String {
    move |s: &str| {
        s.replace(&escaped(&project), "<ROOT>")
            .replace(&project, "<ROOT>")
            .replace(&escaped(&root), "<OUT>")
            .replace(&root, "<OUT>")
            .replace("\\\\", "/")
            .replace('\\', "/")
    }
}

fn deep(v: &Value, f: &dyn Fn(&str) -> String) -> Value {
    match v {
        Value::String(s) => json!(f(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| deep(x, f)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), deep(x, f))).collect()),
        other => other.clone(),
    }
}

fn realpath(p: &Path) -> String {
    let s = std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

#[tokio::test]
async fn browser_and_capture_match() {
    let base = std::env::temp_dir().join(format!("nekko-web-browser-golden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("project")).unwrap();
    let root = realpath(&base);
    let project = format!("{root}{}project", std::path::MAIN_SEPARATOR);
    let norm = normalizer(project.clone(), root.clone());
    let browsers = Browsers::new();
    let all = golden();
    for (i, c) in all.as_array().unwrap().iter().enumerate() {
        let case = &c["case"];
        if let Some(existing) = case["existing"].as_str() {
            std::fs::write(Path::new(&project).join(existing), "old").unwrap();
        }
        let reasons = Arc::new(Mutex::new(Vec::<String>::new()));
        let approve = case["approve"] != json!(false);
        let r2 = reasons.clone();
        let mut ctx = ToolContext::new(approver_fn(move |_call, reason: String, _sev| {
            let r2 = r2.clone();
            async move {
                r2.lock().unwrap().push(reason);
                approve
            }
        }));
        ctx.session_id = Some(case["session"].as_str().unwrap().to_string());
        ctx.mode = ChatMode::Yolo;
        ctx.sandbox_mode = serde_json::from_value(case.get("sandboxMode").cloned().unwrap_or(json!("off"))).unwrap();
        let _: SandboxMode = ctx.sandbox_mode;
        ctx.workspaces = vec![Workspace { id: "w1".into(), path: project.clone() }];
        ctx.default_cwd = Some(project.clone());
        let bridge = Scripted {
            reply: case.get("reply").cloned().unwrap_or(json!({ "ok": true, "body": {} })),
            requests: Mutex::default(),
        };
        let bridge_ref: Option<&dyn Bridge> = if case["bridge"] == json!(false) { None } else { Some(&bridge) };
        let allow = case["allow"] != json!(false);
        let call = ToolCall {
            id: format!("call-{i}"),
            name: case["tool"].as_str().unwrap().into(),
            input: case["input"].clone(),
        };
        let result = if call.name == "browser" {
            browser_tool(&call, &ctx, allow, bridge_ref, &browsers).await
        } else {
            capture_tool(&call, &ctx, allow, bridge_ref).await
        };
        let got_reasons: Vec<String> = reasons.lock().unwrap().iter().map(|r| norm(r)).collect();
        assert_eq!(json!(got_reasons), c["reasons"], "case {i} reasons: {case}");
        assert_eq!(Value::Array(bridge.requests.lock().unwrap().clone()), c["requests"], "case {i} requests: {case}");
        assert_eq!(
            serde_json::to_string(&deep(&result, &norm)).unwrap(),
            serde_json::to_string(&c["result"]).unwrap(),
            "case {i} result: {case}"
        );
        let path = case["input"]["path"].as_str().map(|p| Path::new(&project).join(p));
        let written = match path {
            Some(p) if case["tool"] == "capture" && case.get("existing").is_none() && p.exists() => {
                json!(nekko_web_b64(&std::fs::read(p).unwrap()))
            }
            _ => Value::Null,
        };
        assert_eq!(written, c["written"], "case {i} file: {case}");
    }
    let _ = std::fs::remove_dir_all(&base);
}

fn nekko_web_b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}
