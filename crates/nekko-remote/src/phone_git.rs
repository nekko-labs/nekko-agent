//! Git from a paired phone (IO-33 FA-2): the daemon's copy of
//! `packages/shared/src/phone-git.ts`. Which arguments a phone may send to the
//! `git:*` calls, `workspace:gitStatus` and the PR calls (rebuilt from the
//! checked fields, the workspace always a chat's `session:<chatId>`), and what
//! it receives back (capped diffs, secret-looking files without their patch,
//! commits without the author's email, no paths on the computer).
//!
//! The limits and field lists come from `phone-access.json` (`git`); the
//! shared cases in `tests/golden/phone-git.json`, written by the TS, hold the
//! two copies equal.

use crate::phone::Denied;
use crate::phone_changes::secret_file;
use crate::phone_views::pick_keys;
use serde_json::{Map, Value, json};

/// `PHONE_GIT_CHANNELS`: the channels these rules screen and project.
pub const CHANNELS: [&str; 17] = [
    "git:branches",
    "git:compare",
    "git:diff",
    "git:log",
    "git:show",
    "pr:checks",
    "pr:diff",
    "workspace:gitStatus",
    "git:commit",
    "git:commitMessage",
    "git:mergeAbort",
    "git:push",
    "git:stage",
    "git:switch",
    "git:unstage",
    "pr:action",
    "pr:create",
];

pub fn is_git(channel: &str) -> bool {
    CHANNELS.contains(&channel)
}

/// `PHONE_GIT_VIEW` and the field lists, as the TS wrote them.
#[derive(Debug, Clone, Default)]
pub struct GitPolicy {
    pub files: usize,
    pub lines_per_file: usize,
    pub total_bytes: usize,
    pub commits: usize,
    pub branches: usize,
    pub checks: usize,
    pub text_chars: usize,
    pub diff_keys: Vec<String>,
    pub log_keys: Vec<String>,
    pub commit_keys: Vec<String>,
    pub push_keys: Vec<String>,
    pub switch_keys: Vec<String>,
    pub pr_create_keys: Vec<String>,
    pub pr_actions: Vec<String>,
    pub commit_view: Vec<String>,
    pub branch_view: Vec<String>,
    pub check_view: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

impl GitPolicy {
    /// From `git` in `phone-access.json`; a missing value shows nothing rather than too much.
    pub fn from_policy(v: &Value) -> Self {
        let n = |k: &str| v["view"][k].as_u64().unwrap_or(0) as usize;
        let keys = |k: &str| strings(&v["optionKeys"][k]);
        GitPolicy {
            files: n("files"),
            lines_per_file: n("linesPerFile"),
            total_bytes: n("totalBytes"),
            commits: n("commits"),
            branches: n("branches"),
            checks: n("checks"),
            text_chars: n("textChars"),
            diff_keys: keys("diff"),
            log_keys: keys("log"),
            commit_keys: keys("commit"),
            push_keys: keys("push"),
            switch_keys: keys("switch"),
            pr_create_keys: keys("prCreate"),
            pr_actions: strings(&v["prActions"]),
            commit_view: strings(&v["commitView"]),
            branch_view: strings(&v["branchView"]),
            check_view: strings(&v["checkView"]),
        }
    }
}

fn bad(detail: &str) -> Denied {
    Denied { code: "value-invalid", detail: detail.to_string() }
}

/// A chat's folder, `session:<chatId>`; any other workspace id is refused.
fn chat_folder(v: &Value) -> Result<Value, Denied> {
    match v.as_str() {
        Some(s) if s.starts_with("session:") && s.len() > "session:".len() && s.encode_utf16().count() <= 200 => {
            Ok(v.clone())
        }
        _ => Err(bad("chat folder")),
    }
}

fn text(v: &Value, what: &str) -> Result<Value, Denied> {
    match v.as_str() {
        Some(s) if !s.is_empty() => Ok(v.clone()),
        _ => Err(bad(what)),
    }
}

fn slug_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// `https://github.com/<owner>/<repo>/pull/<number>` and nothing more.
fn pr_url(v: &Value) -> Result<Value, Denied> {
    let ok =
        v.as_str().filter(|s| s.len() <= 300).and_then(|s| s.strip_prefix("https://github.com/")).is_some_and(|rest| {
            let parts: Vec<&str> = rest.split('/').collect();
            parts.len() == 4
                && slug_ok(parts[0])
                && slug_ok(parts[1])
                && parts[2] == "pull"
                && (1..=9).contains(&parts[3].len())
                && parts[3].bytes().all(|b| b.is_ascii_digit())
        });
    if ok { Ok(v.clone()) } else { Err(bad("pull request url")) }
}

#[derive(Clone, Copy)]
enum Kind {
    Str,
    Bool,
    Count,
}

/// An options object (or nothing) with only `keys`, each of the right type.
fn options(v: &Value, keys: &[String], what: &str, kind: impl Fn(&str) -> Kind) -> Result<Map<String, Value>, Denied> {
    let mut out = Map::new();
    let o = match v {
        Value::Null => return Ok(out),
        Value::Object(o) => o,
        _ => return Err(bad(what)),
    };
    if let Some(k) = o.keys().find(|k| !keys.iter().any(|x| x == *k)) {
        return Err(Denied { code: "option-denied", detail: k.clone() });
    }
    for key in keys {
        let Some(value) = o.get(key) else { continue };
        let ok = match kind(key) {
            Kind::Str => value.is_string(),
            Kind::Bool => value.is_boolean(),
            Kind::Count => value.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=1_000_000.0).contains(&n)),
        };
        if !ok {
            return Err(bad(key));
        }
        out.insert(key.clone(), value.clone());
    }
    Ok(out)
}

fn paths(v: &Value) -> Result<Value, Denied> {
    let list = v.as_array().filter(|a| (1..=1000).contains(&a.len())).ok_or_else(|| bad("paths"))?;
    if list.iter().any(|p| p.as_str().is_none_or(str::is_empty)) {
        return Err(bad("paths"));
    }
    Ok(v.clone())
}

/// `screenPhoneGit`: the arguments to pass to the computer's call, rebuilt
/// from the checked fields, or why the phone's call is refused.
pub fn screen(channel: &str, args: &[Value], p: &GitPolicy) -> Result<Vec<Value>, Denied> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let ws = || chat_folder(arg(0));
    let blank = |v: &Value| v.as_str().is_none_or(|s| s.trim().is_empty());
    Ok(match channel {
        "workspace:gitStatus" => {
            if args.len() > 1 && !arg(1).is_boolean() {
                return Err(bad("refresh"));
            }
            vec![ws()?, json!(arg(1) == &Value::Bool(true))]
        }
        // The workspace is checked first where the TS checks it first, so both refuse with the same reason.
        "git:diff" => {
            let w = ws()?;
            let kind = |k: &str| if k == "staged" { Kind::Bool } else { Kind::Str };
            vec![w, Value::Object(options(arg(1), &p.diff_keys, "diff options", kind)?)]
        }
        "git:log" => {
            let w = ws()?;
            let kind = |k: &str| if k == "limit" || k == "skip" { Kind::Count } else { Kind::Str };
            vec![w, Value::Object(options(arg(1), &p.log_keys, "history options", kind)?)]
        }
        "git:show" => vec![ws()?, text(arg(1), "commit")?],
        "git:branches" | "git:commitMessage" | "git:mergeAbort" => vec![ws()?],
        "git:compare" => vec![ws()?, text(arg(1), "base")?, text(arg(2), "head")?],
        "git:stage" | "git:unstage" => vec![ws()?, paths(arg(1))?],
        "git:commit" => {
            let o = options(arg(1), &p.commit_keys, "commit options", |_| Kind::Str)?;
            let message = o.get("message").cloned().unwrap_or(Value::Null);
            if blank(&message) {
                return Err(bad("message"));
            }
            vec![ws()?, json!({ "message": message })]
        }
        "git:push" => {
            let w = ws()?;
            vec![w, Value::Object(options(arg(1), &p.push_keys, "push options", |_| Kind::Bool)?)]
        }
        "git:switch" => {
            let (w, branch) = (ws()?, text(arg(1), "branch")?);
            vec![w, branch, Value::Object(options(arg(2), &p.switch_keys, "switch options", |_| Kind::Bool)?)]
        }
        "pr:create" => {
            let kind = |k: &str| if k == "draft" { Kind::Bool } else { Kind::Str };
            let o = options(arg(1), &p.pr_create_keys, "pull request", kind)?;
            if blank(o.get("title").unwrap_or(&Value::Null)) {
                return Err(bad("title"));
            }
            vec![ws()?, Value::Object(o)]
        }
        "pr:checks" | "pr:diff" => vec![pr_url(arg(0))?],
        "pr:action" => {
            let action =
                arg(1).as_str().filter(|a| p.pr_actions.iter().any(|x| x == a)).ok_or_else(|| bad("action"))?;
            vec![pr_url(arg(0))?, json!(action)]
        }
        other => return Err(bad(other)),
    })
}

fn cut_text(s: &str, n: usize) -> String {
    crate::hello::cut16(s, n).to_string()
}

fn commit_view(c: &Value, body: bool, p: &GitPolicy) -> Option<Value> {
    if !c.is_object() {
        return None;
    }
    let mut out = pick_keys(c, &p.commit_view);
    if body && let Some(b) = c.get("body").and_then(Value::as_str) {
        out.insert("body".into(), json!(cut_text(b, p.text_chars)));
    }
    Some(Value::Object(out))
}

fn commits_view(list: &Value, p: &GitPolicy) -> Value {
    let all = list.as_array().into_iter().flatten().filter_map(|c| commit_view(c, false, p)).take(p.commits);
    Value::Array(all.collect())
}

const FILE_KEYS: [&str; 8] =
    ["additions", "binary", "deletions", "oldPath", "path", "status", "truncated", "untracked"];

struct Files {
    files: Vec<Value>,
    cut: bool,
    omitted: usize,
    hidden: usize,
}

/// `filesView`: at most `files` listed, patches cut to `linesPerFile` lines and
/// none past `totalBytes`; a secret-looking file listed with `hidden` and no patch.
fn files_view(list: &Value, patches: bool, p: &GitPolicy) -> Files {
    let keys: Vec<String> = FILE_KEYS.iter().map(|k| k.to_string()).collect();
    let all: Vec<&Value> =
        list.as_array().into_iter().flatten().filter(|f| f.get("path").is_some_and(Value::is_string)).collect();
    let mut out = Files { files: Vec::new(), cut: false, omitted: 0, hidden: 0 };
    let mut budget = p.total_bytes;
    for f in all.iter().take(p.files) {
        let mut file = pick_keys(f, &keys);
        let path = f["path"].as_str().unwrap_or_default();
        let secret = secret_file(path) || f.get("oldPath").and_then(Value::as_str).is_some_and(secret_file);
        if secret {
            file.insert("hidden".into(), json!(true));
            out.hidden += 1;
        }
        if patches {
            let mut patch = if secret { "" } else { f.get("patch").and_then(Value::as_str).unwrap_or("") }.to_string();
            let lines: Vec<&str> = if patch.is_empty() { Vec::new() } else { patch.split('\n').collect() };
            if lines.len() > p.lines_per_file {
                patch = lines[..p.lines_per_file].join("\n");
                file.insert("truncated".into(), json!(true));
            }
            if patch.len() > budget {
                patch.clear();
                file.insert("truncated".into(), json!(true));
            } else {
                budget -= patch.len();
            }
            file.insert("patch".into(), json!(patch));
        }
        if file.get("truncated") == Some(&Value::Bool(true)) {
            out.cut = true;
        }
        out.files.push(Value::Object(file));
    }
    out.omitted = all.len().saturating_sub(out.files.len());
    out
}

/// `diffView`: a diff-like answer with `extra` first.
fn diff_view(result: &Value, patches: bool, mut extra: Map<String, Value>, p: &GitPolicy) -> Value {
    let f = files_view(&result["files"], patches, p);
    let truncated = result.get("truncated") == Some(&Value::Bool(true)) || f.cut || f.omitted > 0;
    extra.insert("files".into(), Value::Array(f.files));
    extra.insert("truncated".into(), json!(truncated));
    if f.omitted > 0 {
        extra.insert("omittedFiles".into(), json!(f.omitted));
    }
    if f.hidden > 0 {
        extra.insert("hiddenFiles".into(), json!(f.hidden));
    }
    Value::Object(extra)
}

fn keys(list: &[&str]) -> Vec<String> {
    list.iter().map(|k| k.to_string()).collect()
}

fn result_view(result: &Value, extra: &[&str], p: &GitPolicy) -> Map<String, Value> {
    let mut want = vec!["ok"];
    want.extend_from_slice(extra);
    let mut out = pick_keys(result, &keys(&want));
    if let Some(m) = result.get("message").and_then(Value::as_str) {
        out.insert("message".into(), json!(cut_text(m, p.text_chars)));
    }
    out
}

fn objects(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten().filter(|x| x.is_object())
}

/// `phoneGitView`: what a phone receives for a git channel's result.
pub fn view(channel: &str, result: &Value, p: &GitPolicy, pr_view: &[String]) -> Value {
    if channel == "git:log" {
        return commits_view(result, p);
    }
    if !result.is_object() {
        return Value::Null;
    }
    let pr = |v: Option<&Value>| v.filter(|x| x.is_object()).map(|x| Value::Object(pick_keys(x, pr_view)));
    match channel {
        "workspace:gitStatus" => {
            let mut out = pick_keys(
                result,
                &keys(&["ahead", "behind", "branch", "dirtyCount", "head", "repo", "updatedAt", "workspaceId"]),
            );
            if let Some(name) = result.get("worktree").and_then(|w| w.get("name")).filter(|n| n.is_string()) {
                out.insert("worktree".into(), json!({ "name": name }));
            }
            if let Some(v) = pr(result.get("pr")) {
                out.insert("pr".into(), v);
            }
            Value::Object(out)
        }
        "git:diff" => diff_view(result, true, Map::new(), p),
        "pr:diff" => {
            let mut extra = Map::new();
            if let Some(u) = result.get("url").filter(|u| u.is_string()) {
                extra.insert("url".into(), u.clone());
            }
            diff_view(result, true, extra, p)
        }
        "git:show" => {
            let mut extra = Map::new();
            extra.insert("commit".into(), commit_view(&result["commit"], true, p).unwrap_or(Value::Null));
            diff_view(result, true, extra, p)
        }
        "git:compare" => {
            let mut extra = pick_keys(result, &keys(&["ahead", "base", "behind", "head", "mergeBase"]));
            extra.insert("commits".into(), commits_view(&result["commits"], p));
            diff_view(result, false, extra, p)
        }
        "git:branches" => {
            let list = |k: &str| -> Vec<Value> {
                objects(&result[k]).map(|b| Value::Object(pick_keys(b, &p.branch_view))).collect()
            };
            let (local, remote) = (list("local"), list("remote"));
            let mut out = pick_keys(result, &keys(&["current", "defaultBranch", "detached", "head"]));
            out.insert("local".into(), Value::Array(local.iter().take(p.branches).cloned().collect()));
            out.insert("remote".into(), Value::Array(remote.iter().take(p.branches).cloned().collect()));
            if local.len() > p.branches {
                out.insert("omittedLocal".into(), json!(local.len() - p.branches));
            }
            if remote.len() > p.branches {
                out.insert("omittedRemote".into(), json!(remote.len() - p.branches));
            }
            Value::Object(out)
        }
        "pr:checks" => {
            let items: Vec<Value> =
                objects(&result["items"]).map(|c| Value::Object(pick_keys(c, &p.check_view))).collect();
            let mut out = pick_keys(result, &keys(&["checks", "source", "url"]));
            out.insert("items".into(), Value::Array(items.iter().take(p.checks).cloned().collect()));
            if items.len() > p.checks {
                out.insert("omittedItems".into(), json!(items.len() - p.checks));
            }
            Value::Object(out)
        }
        "git:commitMessage" => Value::Object(pick_keys(result, &keys(&["inputTruncated", "message"]))),
        "git:commit" => {
            let mut out = result_view(result, &["branch"], p);
            if let Some(c) = commit_view(&result["commit"], false, p) {
                out.insert("commit".into(), c);
            }
            Value::Object(out)
        }
        "git:push" => Value::Object(result_view(result, &["branch", "remote", "upstream"], p)),
        "git:switch" => Value::Object(result_view(result, &["branch"], p)),
        "pr:create" | "pr:action" => {
            let extra: &[&str] = if channel == "pr:create" { &["url"] } else { &[] };
            let mut out = result_view(result, extra, p);
            if let Some(v) = pr(result.get("pr")) {
                out.insert("pr".into(), v);
            }
            Value::Object(out)
        }
        _ => Value::Object(result_view(result, &[], p)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> &'static GitPolicy {
        &crate::phone::policy().git
    }

    #[test]
    fn the_policy_has_the_git_limits() {
        let p = policy();
        assert_eq!((p.files, p.lines_per_file, p.total_bytes), (100, 300, 256 * 1024));
        assert_eq!(p.pr_actions, ["approve", "close", "merge", "reopen"]);
        assert!(!p.commit_view.iter().any(|k| k == "email"), "a phone never gets an author's email");
    }

    #[test]
    fn keeps_a_whole_answer_under_the_byte_cap() {
        let line = "x".repeat(1000);
        let mut patch = vec!["@@ -0,0 +1,200 @@".to_string()];
        patch.extend((0..200).map(|_| format!("+{line}")));
        let patch = patch.join("\n");
        let files: Vec<Value> =
            (0..5).map(|i| json!({ "path": format!("f{i}"), "status": "added", "patch": patch })).collect();
        let v = view("git:diff", &json!({ "files": files, "truncated": false }), policy(), &[]);
        let total: usize = v["files"].as_array().unwrap().iter().map(|f| f["patch"].as_str().unwrap().len()).sum();
        assert!(total <= policy().total_bytes);
        assert_eq!(v["files"][0]["patch"], json!(patch));
        assert_eq!(v["files"][1]["patch"], json!(""));
        assert_eq!(v["files"][1]["truncated"], json!(true));
        assert_eq!(v["truncated"], json!(true));
    }

    #[test]
    fn a_raw_workspace_id_is_refused() {
        for ws in [json!("w1"), json!("session:"), json!(null), json!(3)] {
            let err = screen("git:branches", std::slice::from_ref(&ws), policy()).unwrap_err();
            assert_eq!((err.code, err.detail.as_str()), ("value-invalid", "chat folder"), "{ws}");
        }
        assert_eq!(screen("git:branches", &[json!("session:s1")], policy()).unwrap(), vec![json!("session:s1")]);
    }
}
