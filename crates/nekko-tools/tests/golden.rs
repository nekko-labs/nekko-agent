//! The Rust tools against the TS ones.
//!
//! Every file in `golden/` is written by the real TS code
//! (packages/host/src/agent-tools.golden.test.ts, which also fails if a file
//! goes stale). This replays the same calls through [`nekko_tools::execute`]
//! on the same fixture trees and requires the same results: tool outputs,
//! approval prompts, the resulting files byte for byte, the pending-changes
//! records, the command log, the classifier's decisions and the specs. Both
//! sides normalize the same way (temp root as `<ROOT>`, `/` under it, the
//! shell as `<SHELL>`, CRLF as LF), so the files hold on every platform.
//!
//! The TS writer is deleted, so these files are frozen and a behavior change
//! edits them by hand. `guardrails.json`'s classifications and bash calls were
//! re-recorded from this crate when guardrails mode moved to the read-only
//! allowlist (docs/decisions/0010).

use nekko_tools::{
    BoxFuture, ChangeTracker, ChatMode, CommandLog, CommandRunner, Dialect, GuardrailRule, RunOutcome, RunRequest,
    SandboxMode, Severity, ToolCall, ToolContext, Workspace, approver_fn, builtin_tools, classify_command_in,
    default_guardrails, execute, path,
};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// The same helpers as the TS test.

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "nekko-tools-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// A directory link, as `fs.symlinkSync(target, path, 'junction')` makes it:
/// a junction on Windows, a symlink elsewhere.
fn link_dir(target: &Path, path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg: Command's own quoting would wrap the whole line in quotes.
        let output = std::process::Command::new("cmd")
            .raw_arg(format!("/d /s /c \"mklink /J \"{}\" \"{}\"\"", path.display(), target.display()))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J {} -> {}: {}",
            path.display(),
            target.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, path).unwrap();
}

fn materialize(root: &Path, tree: &Value) {
    let _ = std::fs::remove_dir_all(root);
    std::fs::create_dir_all(root).unwrap();
    let under = |rel: &str| rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part));
    for (rel, e) in tree.as_object().unwrap() {
        if e.get("link").is_some() {
            continue;
        }
        let p = under(rel);
        if e.get("dir").is_some() {
            std::fs::create_dir_all(&p).unwrap();
            continue;
        }
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let bytes = match e {
            Value::String(s) => s.as_bytes().to_vec(),
            _ if e.get("hex").is_some() => unhex(e["hex"].as_str().unwrap()),
            _ => e["repeat"].as_str().unwrap().repeat(e["times"].as_u64().unwrap() as usize).into_bytes(),
        };
        std::fs::write(&p, bytes).unwrap();
    }
    // Links last, so their targets exist.
    for (rel, e) in tree.as_object().unwrap() {
        if let Some(target) = e.get("link").and_then(Value::as_str) {
            let p = under(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            link_dir(&under(target), &p);
        }
    }
}

fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn describe(b: &[u8]) -> Value {
    if b.len() > 4096 {
        return json!({ "size": b.len(), "fnv1a": fnv(b) });
    }
    match std::str::from_utf8(b) {
        Ok(s) => json!({ "text": s }),
        Err(_) => json!({ "hex": b.iter().map(|x| format!("{x:02x}")).collect::<String>() }),
    }
}

/// `lstatSync(p).isSymbolicLink()`: libuv calls any Windows reparse point a link.
fn is_link(p: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(p) else { return false };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}

/// Every file and directory under root; names in JS `sort()` (UTF-16) order.
/// Links are recorded, not followed.
fn snapshot(root: &Path) -> Map<String, Value> {
    fn walk(dir: &Path, rel: &str, out: &mut Map<String, Value>) {
        let mut names: Vec<String> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in names {
            let full = dir.join(&name);
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if is_link(&full) {
                out.insert(r, json!({ "link": true }));
            } else if full.is_dir() {
                out.insert(format!("{r}/"), Value::Null);
                walk(&full, &r, out);
            } else {
                out.insert(r, describe(&std::fs::read(&full).unwrap()));
            }
        }
    }
    let mut out = Map::new();
    walk(root, "", &mut out);
    out
}

fn tree_diff(before: &Map<String, Value>, after: &Map<String, Value>) -> Value {
    let changed: Map<String, Value> =
        after.iter().filter(|(k, v)| before.get(*k) != Some(v)).map(|(k, v)| (k.clone(), v.clone())).collect();
    let removed: Vec<&String> = before.keys().filter(|k| !after.contains_key(*k)).collect();
    json!({ "changed": changed, "removed": removed })
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `<ROOT>` for the root, `/` inside paths under it, `<SHELL>`, LF.
fn normalize(s: &str, root: &str) -> String {
    let s = s.replace(root, "<ROOT>");
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(at) = rest.find("<ROOT>") {
        out.push_str(&rest[..at]);
        let token_end =
            rest[at..].find(|c: char| is_js_space(c) || c == '\'' || c == '"').map_or(rest.len(), |e| at + e);
        out.push_str(&rest[at..token_end].replace('\\', "/"));
        rest = &rest[token_end..];
    }
    out.push_str(rest);
    out.replace(&format!("spawn {} ", nekko_tools::shell()), "spawn <SHELL> ").replace("\r\n", "\n")
}

fn record_output(s: &str) -> Value {
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() <= 4096 {
        return json!(s);
    }
    json!({
        "length": u.len(),
        "head": String::from_utf16_lossy(&u[..200]),
        "tail": String::from_utf16_lossy(&u[u.len() - 200..]),
        "fnv1a": fnv(s.as_bytes()),
    })
}

fn place(v: &Value, root: &str) -> Value {
    match v {
        Value::String(s) => json!(s.replace("<ROOT>", root)),
        Value::Array(a) => Value::Array(a.iter().map(|x| place(x, root)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), place(x, root))).collect()),
        other => other.clone(),
    }
}

/// `exec` in the guardrails set: reports where it would have run.
struct WhereItRuns;

impl CommandRunner for WhereItRuns {
    fn run<'a>(&'a self, req: RunRequest<'a>) -> BoxFuture<'a, RunOutcome> {
        let stdout = format!("RAN {}", req.cwd);
        Box::pin(async move { RunOutcome { stdout, ..Default::default() } })
    }
}

#[derive(Default)]
struct Log(Mutex<Vec<(Option<String>, String)>>);

impl CommandLog for Log {
    fn append(&self, _session: &str, workspace_id: Option<&str>, data: &str) {
        self.0.lock().unwrap().push((workspace_id.map(str::to_string), data.to_string()));
    }
}

struct Harness {
    setups: Value,
    custom: Vec<GuardrailRule>,
}

struct Env<'a> {
    root: &'a str,
    changes: Option<Arc<ChangeTracker>>,
    log: Option<Arc<Log>>,
    stub: bool,
}

impl Harness {
    fn context(&self, env: &Env<'_>, policy: &Value, approvals: Arc<Mutex<Vec<Value>>>, approve: bool) -> ToolContext {
        let root = env.root.to_string();
        let approver = approver_fn(move |_call: ToolCall, reason: String, severity: Severity| {
            let approvals = approvals.clone();
            let root = root.clone();
            async move {
                approvals.lock().unwrap().push(json!({ "reason": normalize(&reason, &root), "severity": severity }));
                approve
            }
        });
        let mut ctx = ToolContext::new(approver);
        let setup = place(&self.setups[policy["setup"].as_str().unwrap()], env.root);
        ctx.workspaces = serde_json::from_value::<Vec<Workspace>>(setup["workspaces"].clone()).unwrap();
        ctx.default_cwd = setup["defaultCwd"].as_str().map(str::to_string);
        ctx.mode = match &policy["mode"] {
            Value::Null => ChatMode::default(),
            m => serde_json::from_value(m.clone()).unwrap(),
        };
        ctx.sandbox_mode = serde_json::from_value::<SandboxMode>(policy["sandboxMode"].clone()).unwrap();
        ctx.guardrails = match policy["rules"].as_str().unwrap() {
            "default" => None,
            "custom" => Some(self.custom.clone()),
            _ => Some(Vec::new()),
        };
        ctx.session_id = policy["sessionId"].as_str().map(str::to_string);
        ctx.changes = env.changes.clone();
        if let Some(log) = &env.log {
            ctx.command_log = Some(log.clone() as Arc<dyn CommandLog>);
        }
        if env.stub {
            ctx.runner = Arc::new(WhereItRuns);
        }
        ctx
    }

    async fn run(&self, env: &Env<'_>, policy: &Value, call: &Value, id: String, approve: bool) -> Value {
        let approvals = Arc::new(Mutex::new(Vec::new()));
        let ctx = self.context(env, policy, approvals.clone(), approve);
        let call = ToolCall {
            id,
            name: call["name"].as_str().unwrap().to_string(),
            input: place(call.get("input").unwrap_or(&json!({})), env.root),
        };
        let res = execute(&call, &ctx).await;
        let approvals = approvals.lock().unwrap().clone();
        json!({
            "result": { "output": record_output(&normalize(&res.output, env.root)), "isError": res.is_error },
            "approvals": approvals,
        })
    }
}

fn harness(g: &Value) -> Harness {
    let custom = golden("guardrails.json")["custom"].clone();
    Harness { setups: g["setups"].clone(), custom: serde_json::from_value(custom).unwrap() }
}

// ---------------------------------------------------------------------------

#[test]
fn default_rules_and_every_classification_match() {
    let g = golden("guardrails.json");
    let defaults: Vec<GuardrailRule> = serde_json::from_value(g["defaults"].clone()).unwrap();
    assert_eq!(defaults, default_guardrails(), "DEFAULT_GUARDRAILS differ");
    let custom: Vec<GuardrailRule> = serde_json::from_value(g["custom"].clone()).unwrap();
    let cases = g["classify"].as_array().unwrap();
    assert!(cases.len() > 200, "the classifier set is too small to mean anything");
    for case in cases {
        let rules: &[GuardrailRule] = match case["rules"].as_str().unwrap() {
            "default" => &defaults,
            "custom" => &custom,
            _ => &[],
        };
        let command = case["command"].as_str().unwrap();
        // Read as sh, so the file holds on Windows too.
        let got = serde_json::to_value(classify_command_in(command, rules, Dialect::Posix)).unwrap();
        assert_eq!(got, case["decision"], "{} rules on {command:?}", case["rules"]);
    }
}

#[tokio::test]
async fn every_call_is_allowed_asked_or_refused_as_in_ts() {
    let g = golden("guardrails.json");
    let h = harness(&g);
    let calls = g["calls"].as_array().unwrap();
    assert!(calls.len() > 1000);
    let root = TempRoot::new();
    let env = Env { root: &root.path(), changes: None, log: None, stub: true };
    let mut failures = Vec::new();
    for (n, case) in calls.iter().enumerate() {
        materialize(&root.0, &g["tree"]);
        let got =
            h.run(&env, &case["policy"], &case["call"], format!("c{n}"), case["approve"].as_bool().unwrap()).await;
        let want = json!({ "result": case["result"], "approvals": case["approvals"] });
        if got != want {
            failures.push(format!("#{n} {} {}\n  got  {got}\n  want {want}", case["policy"], case["call"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} calls differ:\n{}", failures.len(), calls.len(), failures.join("\n"));
}

#[tokio::test]
async fn file_tools_leave_the_same_results_trees_and_changes() {
    let g = golden("files.json");
    let h = harness(&golden("guardrails.json"));
    for seq in g["sequences"].as_array().unwrap() {
        let name = seq["name"].as_str().unwrap();
        let root = TempRoot::new();
        materialize(&root.0, seq.get("fixture").unwrap_or(&g["tree"]));
        let before = snapshot(&root.0);
        let tracker = Arc::new(ChangeTracker::new());
        let env = Env { root: &root.path(), changes: Some(tracker.clone()), log: None, stub: false };
        let sid = seq["policy"]["sessionId"].as_str().unwrap_or("");
        let mut results = Vec::new();
        for (n, step) in seq["steps"].as_array().unwrap().iter().enumerate() {
            if step.get("changes").is_some() {
                let list: Vec<Value> = tracker
                    .list_changes(sid)
                    .iter()
                    .map(|c| {
                        json!({
                            "path": normalize(&c.path, env.root),
                            "original": record_output(&c.original),
                            "current": record_output(&c.current),
                        })
                    })
                    .collect();
                results.push(json!({ "changes": list }));
            } else if let Some(rel) = step.get("accept").and_then(Value::as_str) {
                tracker.accept_change(sid, &path::native::resolve(&[env.root, "ws", "app", rel]));
                results.push(json!({ "accepted": rel }));
            } else if step.get("acceptAll").is_some() {
                tracker.accept_all(sid);
                results.push(json!({ "acceptedAll": true }));
            } else {
                let approve = step.get("approve").and_then(Value::as_bool).unwrap_or(true);
                results.push(h.run(&env, &seq["policy"], &step["call"], format!("{name}-{n}"), approve).await);
            }
        }
        let want = seq["results"].as_array().unwrap();
        for (n, (got, want)) in results.iter().zip(want).enumerate() {
            assert_eq!(got, want, "{name} step {n}: {}", seq["steps"][n]);
        }
        assert_eq!(results.len(), want.len());
        assert_eq!(tree_diff(&before, &snapshot(&root.0)), seq["tree"], "{name}: the files on disk differ");
    }
}

#[tokio::test]
async fn bash_formats_output_failures_and_the_command_log_as_ts() {
    let g = golden("bash.json");
    let h = harness(&golden("guardrails.json"));
    let root = TempRoot::new();
    materialize(&root.0, &g["tree"]);
    let policy = json!({ "setup": "two", "mode": "yolo", "sandboxMode": "workspace-jail", "rules": "default", "sessionId": "s_bash" });
    for (n, case) in g["calls"].as_array().unwrap().iter().enumerate() {
        let log = Arc::new(Log::default());
        let env = Env { root: &root.path(), changes: None, log: Some(log.clone()), stub: false };
        let call = json!({ "name": "bash", "input": case["input"] });
        let got = h.run(&env, &policy, &call, format!("b{n}"), true).await;
        assert_eq!(got["result"], case["result"], "{}", case["input"]);
        assert_eq!(got["approvals"], case["approvals"], "{}", case["input"]);
        let mirror: Vec<Value> = log
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(w, d)| json!({ "workspaceId": w, "data": normalize(d, env.root) }))
            .collect();
        match &case["mirror"] {
            // Two streams: chunk order is up to the OS, so compare the text.
            Value::Null => {
                let mut lines: Vec<String> = mirror
                    .iter()
                    .flat_map(|m| m["data"].as_str().unwrap().lines().map(str::to_string).collect::<Vec<_>>())
                    .collect();
                lines.sort();
                let mut want: Vec<&str> = vec!["$ echo out&& >&2 echo err", "out", "err"];
                want.sort();
                assert_eq!(lines, want);
            }
            want => {
                // Chunking can differ; the concatenated log may not.
                let join = |v: &[Value]| v.iter().map(|m| m["data"].as_str().unwrap()).collect::<String>();
                assert_eq!(join(&mirror), join(want.as_array().unwrap()), "{}", case["input"]);
                assert!(mirror.iter().zip(want.as_array().unwrap()).all(|(a, b)| a["workspaceId"] == b["workspaceId"]));
            }
        }
    }
}

#[test]
fn specs_match_builtin_tools() {
    let want = golden("specs.json");
    let got = serde_json::to_value(builtin_tools()).unwrap();
    assert_eq!(got, want);
    // Key order too: the specs are sent to the model as written.
    assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&want).unwrap());
}

#[test]
fn paths_resolve_like_node() {
    let g = golden("paths.json");
    let s = |v: &Value| v.as_str().unwrap().to_string();
    let w = &g["win32"];
    for c in w["resolve"].as_array().unwrap() {
        assert_eq!(path::win32::resolve(&[&s(&c["base"]), &s(&c["path"])]), s(&c["out"]), "win32.resolve {c}");
    }
    for c in w["resolveOne"].as_array().unwrap() {
        assert_eq!(path::win32::resolve(&[&s(&c["path"])]), s(&c["out"]), "win32.resolve {c}");
    }
    for c in w["relative"].as_array().unwrap() {
        assert_eq!(path::win32::relative(&s(&c["from"]), &s(&c["to"])), s(&c["out"]), "win32.relative {c}");
    }
    for c in w["isAbsolute"].as_array().unwrap() {
        assert_eq!(json!(path::win32::is_absolute(&s(&c["path"]))), c["out"], "win32.isAbsolute {c}");
    }
    for c in w["join"].as_array().unwrap() {
        assert_eq!(path::win32::join(&[&s(&c["base"]), &s(&c["path"])]), s(&c["out"]), "win32.join {c}");
    }
    for c in w["normalize"].as_array().unwrap() {
        assert_eq!(path::win32::normalize(&s(&c["path"])), s(&c["out"]), "win32.normalize {c}");
    }
    let p = &g["posix"];
    for c in p["resolve"].as_array().unwrap() {
        assert_eq!(path::posix::resolve(&[&s(&c["base"]), &s(&c["path"])]), s(&c["out"]), "posix.resolve {c}");
    }
    for c in p["relative"].as_array().unwrap() {
        assert_eq!(path::posix::relative(&s(&c["from"]), &s(&c["to"])), s(&c["out"]), "posix.relative {c}");
    }
    for c in p["isAbsolute"].as_array().unwrap() {
        assert_eq!(json!(path::posix::is_absolute(&s(&c["path"]))), c["out"], "posix.isAbsolute {c}");
    }
    for c in p["join"].as_array().unwrap() {
        assert_eq!(path::posix::join(&[&s(&c["base"]), &s(&c["path"])]), s(&c["out"]), "posix.join {c}");
    }
    for c in p["normalize"].as_array().unwrap() {
        assert_eq!(path::posix::normalize(&s(&c["path"])), s(&c["out"]), "posix.normalize {c}");
    }
}
