//! Where a chat is in the agent loop, for the Agents panel's Activity groups.
//!
//! The latest tool call that says so decides: reading and searching is
//! `exploring`, editing is `building`, tests and builds are `verifying`, and
//! commits, pushes and pull requests are `shipping`. It is the latest rather
//! than the furthest because the loop goes round: an edit after a failed test
//! is `building` again. Reads only go back to `exploring` from a new message:
//! within one reply, the reading an agent does while wrapping up keeps the
//! chat where it got to. Anything else (a plan, a sub-agent, an MCP tool, a
//! command with no clear purpose) leaves the chat where it was.
//!
//! The rules are `toolPurpose` (packages/shared/src/tool-purpose.ts), trimmed
//! to what a phase needs, and run its fixture. A list works this out for chats
//! no window is streaming, so it cannot wait for the renderer's copy.

use serde_json::Value;

const EDIT: &[&str] = &[
    "writefile",
    "editfile",
    "write",
    "edit",
    "multiedit",
    "applypatch",
    "notebookedit",
    "createfile",
    "strreplace",
    "strreplaceeditor",
    "strreplacebasededittool",
    "deletefile",
    "patch",
];
const EXPLORE: &[&str] = &[
    "readfile",
    "read",
    "view",
    "openfile",
    "notebookread",
    "readmanyfiles",
    "cat",
    "listdir",
    "ls",
    "listdirectory",
    "listfiles",
    "grep",
    "glob",
    "search",
    "find",
    "findfiles",
    "filesearch",
    "codebasesearch",
    "grepsearch",
    "searchfiles",
    "websearch",
    "searchweb",
    "googlesearch",
    "webfetch",
    "fetchurl",
    "fetch",
    "browser",
    "browse",
];
const SHELL: &[&str] = &[
    "bash",
    "shell",
    "runcommand",
    "runterminalcmd",
    "exec",
    "execcommand",
    "powershell",
    "terminal",
    "localshell",
    "runshellcommand",
    "startprocess",
    "readprocess",
    "killprocess",
    "bashoutput",
    "killshell",
    "killbash",
];
const WRAPPERS: &[&str] = &["sudo", "time", "env", "nohup", "command", "exec", "&", "call", "npx", "bunx", "pnpx"];
const NOISE: &[&str] = &[
    "cd",
    "pushd",
    "popd",
    "set-location",
    "sl",
    "export",
    "set",
    "source",
    ".",
    "echo",
    "write-host",
    "write-output",
    "true",
    ":",
    "sleep",
    "clear",
    "cls",
];
const CHECK_PROGS: &[&str] = &[
    "vitest",
    "jest",
    "pytest",
    "tsc",
    "vue-tsc",
    "eslint",
    "mypy",
    "ruff",
    "mocha",
    "rspec",
    "phpunit",
    "swiftlint",
    "ktlint",
    "golangci-lint",
    "biome",
    "playwright",
    "tox",
    "nox",
    "stylelint",
    "unittest",
];
const LOOK_PROGS: &[&str] = &[
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "bat",
    "type",
    "get-content",
    "gc",
    "ls",
    "dir",
    "tree",
    "get-childitem",
    "gci",
    "find",
    "fd",
    "rg",
    "grep",
    "ag",
    "ack",
    "wc",
    "select-string",
    "sls",
    "stat",
    "file",
    "realpath",
    "pwd",
    "which",
    "where",
    "get-item",
    "test-path",
    "du",
];
const INSTALL: &[&str] =
    &["install", "i", "add", "ci", "uninstall", "remove", "rm", "update", "upgrade", "init", "create", "exec", "dlx"];
const SCRIPTS: &[&str] = &["test", "t", "tests", "lint", "typecheck", "type-check", "build", "check", "verify", "e2e"];

#[derive(PartialEq, Clone, Copy)]
enum Kind {
    Ship,
    Git,
    Check,
    Explore,
    Run,
}

/// `key`: tool names compared without case, `_`, `-` or spaces.
fn key(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, '-' | '_') && !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// `shellCommand`: the command as one string; `["bash", "-lc", "…"]` keeps the script.
fn shell_command(input: Option<&Value>) -> String {
    let Some(input) = input else { return String::new() };
    let raw = ["command", "cmd", "script"].iter().find_map(|k| input.get(k).filter(|v| !v.is_null()));
    match raw {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(a)) => {
            let Some(words) = a.iter().map(Value::as_str).collect::<Option<Vec<_>>>() else {
                return String::new();
            };
            let dash_c = words.get(1).is_some_and(|w| {
                w.len() >= 2
                    && w.starts_with('-')
                    && w.ends_with('c')
                    && w[1..w.len() - 1].chars().all(|c| c.is_alphanumeric() || c == '_')
            });
            if words.len() >= 3 && dash_c { words[words.len() - 1].trim().to_string() } else { words.join(" ") }
        }
        _ => String::new(),
    }
}

/// `words`: env assignments and wrappers (`sudo`, `npx`) taken off the front.
fn words(segment: &str) -> Vec<&str> {
    let mut w: Vec<&str> = segment.split_whitespace().map(|x| x.trim_matches(['"', '\''])).collect();
    while let Some(first) = w.first() {
        let assignment = first.split_once('=').is_some_and(|(name, _)| {
            name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
        if assignment {
            w.remove(0);
        } else if WRAPPERS.contains(&first.to_lowercase().as_str()) {
            w.remove(0);
            // `npx --yes vitest`: the wrapper's own flags go too.
            while w.first().is_some_and(|x| x.starts_with('-')) {
                w.remove(0);
            }
        } else {
            break;
        }
    }
    w
}

/// `progName`: `./node_modules/.bin/vitest` and `.\gradlew.bat` read as `vitest`, `gradlew`.
fn prog_name(word: &str) -> String {
    let leaf = word.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(word).to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1", ".sh"] {
        if let Some(bare) = leaf.strip_suffix(ext) {
            return bare.to_string();
        }
    }
    leaf
}

/// `SCRIPT_RE`: a package script that tests, lints or builds, `test:unit` included.
fn is_script(arg: &str) -> bool {
    let (name, rest) = arg.split_once(':').unwrap_or((arg, "x"));
    SCRIPTS.contains(&name) && !rest.is_empty() && rest.chars().all(|c| c.is_alphanumeric() || "_:.-".contains(c))
}

/// `checkCommand`.
fn is_check(prog: &str, lower: &[String], plain: &[&str]) -> bool {
    let first = plain.first().copied().unwrap_or("");
    let any = |set: &[&str]| plain.iter().any(|a| set.contains(a));
    if CHECK_PROGS.contains(&prog) {
        return true;
    }
    match prog {
        "npm" | "pnpm" | "yarn" | "bun" => {
            !INSTALL.contains(&first) && plain.iter().any(|a| is_script(a) || CHECK_PROGS.contains(a))
        }
        "cargo" => ["test", "build", "check", "clippy", "nextest", "bench"].contains(&first),
        "go" => ["test", "build", "vet"].contains(&first),
        "swift" | "dotnet" => ["test", "build"].contains(&first),
        "deno" => ["test", "check", "lint"].contains(&first),
        "mvn" | "mvnw" => any(&["test", "verify", "package", "compile", "install"]),
        "gradle" | "gradlew" => {
            plain.iter().any(|a| ["test", "build", "assemble", "lint", "check"].iter().any(|t| a.contains(t)))
        }
        "make" | "just" => first.is_empty() || ["test", "check", "build", "lint", "all"].contains(&first),
        "xcodebuild" => any(&["test", "build", "build-for-testing", "test-without-building", "analyze"]),
        "python" | "python3" | "py" | "uv" | "poetry" | "pipenv" => any(CHECK_PROGS),
        "node" => lower.iter().any(|a| a == "--test"),
        _ => false,
    }
}

/// A commit, a push or a pull request, past any global options (`git -C path push`).
fn ships(prog: &str, args: &[String]) -> bool {
    let mut i = 0;
    while args.get(i).is_some_and(|a| a.starts_with('-')) {
        i += if args[i] == "-c" { 2 } else { 1 };
    }
    let sub = args.get(i).map_or("", String::as_str);
    let obj = args.get(i + 1).map_or("", String::as_str);
    match prog {
        "gh" => matches!((sub, obj), ("pr", "create" | "merge") | ("release", "create")),
        _ => matches!(sub, "commit" | "push"),
    }
}

/// `segmentKind`.
fn segment_kind(segment: &str) -> Option<Kind> {
    let w = words(segment);
    let prog = prog_name(w.first()?);
    let lower: Vec<String> = w[1..].iter().map(|a| a.to_lowercase()).collect();
    let plain: Vec<&str> = lower.iter().map(String::as_str).filter(|a| !a.starts_with(['-', '+'])).collect();
    if NOISE.contains(&prog.as_str()) {
        return None;
    }
    if prog == "git" || prog == "gh" {
        return Some(if ships(&prog, &lower) { Kind::Ship } else { Kind::Git });
    }
    if is_check(&prog, &lower, &plain) {
        return Some(Kind::Check);
    }
    if LOOK_PROGS.contains(&prog.as_str()) && !w[1..].iter().any(|a| a.starts_with('>')) {
        return Some(Kind::Explore);
    }
    Some(Kind::Run)
}

/// `shellPurpose`, with looking at git (`git status`) saying nothing.
fn shell_phase(command: &str) -> Option<&'static str> {
    let split = command.replace("&&", "\n").replace("||", "\n");
    let kinds: Vec<Kind> = split.split(['\n', ';', '|']).filter_map(segment_kind).collect();
    let git = |k: &Kind| matches!(k, Kind::Ship | Kind::Git);
    let shipping = kinds.contains(&Kind::Ship).then_some("shipping");
    if git(kinds.first()?) {
        return shipping;
    }
    if kinds.contains(&Kind::Check) {
        return Some("verifying");
    }
    if kinds.iter().any(git) {
        return shipping;
    }
    kinds.iter().all(|k| *k == Kind::Explore).then_some("exploring")
}

fn call_phase(call: &Value) -> Option<&'static str> {
    let name = call.get("name")?.as_str()?;
    if name.starts_with("mcp__") {
        return None;
    }
    let k = key(name);
    if EDIT.contains(&k.as_str()) {
        return Some("building");
    }
    if EXPLORE.contains(&k.as_str()) {
        return Some("exploring");
    }
    if SHELL.contains(&k.as_str()) {
        return shell_phase(&shell_command(call.get("input")));
    }
    None
}

/// The chat's phase: its latest turn that names one. `None` before any does.
pub fn loop_phase(messages: &[Value]) -> Option<&'static str> {
    messages.rsplit(new_work).find_map(turn_phase)
}

/// A message from the person. A watch's wake-up (`watches.rs`) is the agent
/// checking on its own work, so the reply it starts carries on the last one.
fn new_work(m: &Value) -> bool {
    m.get("role").and_then(Value::as_str) == Some("user")
        && !m.get("content").and_then(Value::as_str).is_some_and(|c| c.starts_with("[Agent watch "))
}

/// One reply's phase: its latest call past exploring, else exploring if it read.
/// The reads an agent does while wrapping up (a runbook, a memory file, a last
/// screenshot) do not send a chat that built or shipped back to exploring.
fn turn_phase(turn: &[Value]) -> Option<&'static str> {
    let mut read = false;
    for phase in turn.iter().filter_map(|m| m.get("toolCalls")?.as_array()).flatten().rev().filter_map(call_phase) {
        if phase != "exploring" {
            return Some(phase);
        }
        read = true;
    }
    read.then_some("exploring")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(name: &str, input: Value) -> Value {
        json!({ "name": name, "input": input })
    }

    fn bash(command: &str) -> Option<&'static str> {
        call_phase(&call("bash", json!({ "command": command })))
    }

    #[test]
    fn agrees_with_the_shared_purpose_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/shared/fixtures/tool-purpose.json");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = fixture["purposes"].as_array().unwrap();
        assert!(cases.len() >= 60);
        for case in cases {
            let got = call_phase(case);
            let want = match case["purpose"].as_str().unwrap() {
                "guidance" | "explore" | "web" => Some("exploring"),
                "edit" => Some("building"),
                "check" => Some("verifying"),
                // Only some git is shipping; the cases below say which.
                "git" => got.filter(|p| *p == "shipping"),
                _ => None,
            };
            assert_eq!(got, want, "{case}");
        }
    }

    #[test]
    fn only_landing_work_is_shipping() {
        for command in [
            "git add -A && git commit -m x",
            "git -C .worktrees/a push -u origin b",
            "gh pr create --title x",
            "gh pr merge --auto",
            "gh release create v1",
        ] {
            assert_eq!(bash(command), Some("shipping"), "{command}");
        }
        for command in
            ["git status", "git diff main", "git log -3", "gh pr view 3", "git pull --no-rebase", "git add ."]
        {
            assert_eq!(bash(command), None, "{command}");
        }
    }

    #[test]
    fn the_latest_telling_call_wins_and_the_loop_goes_round() {
        let turn = |calls: Vec<Value>| json!({ "role": "assistant", "content": "", "toolCalls": calls });
        let read = call("read_file", json!({ "path": "a.ts" }));
        let edit = call("edit_file", json!({ "path": "a.ts" }));
        let test = call("bash", json!({ "command": "npm test" }));
        let plan = call("update_plan", json!({}));
        let mcp = call("mcp__github__create_pull_request", json!({}));
        assert_eq!(loop_phase(&[]), None);
        assert_eq!(loop_phase(&[json!({ "role": "user", "content": "hi" })]), None);
        assert_eq!(loop_phase(&[turn(vec![plan.clone()])]), None);
        assert_eq!(loop_phase(&[turn(vec![read.clone()]), turn(vec![edit.clone()])]), Some("building"));
        assert_eq!(loop_phase(&[turn(vec![read, edit.clone(), test.clone()])]), Some("verifying"));
        assert_eq!(loop_phase(&[turn(vec![test.clone()]), turn(vec![edit])]), Some("building"));
        assert_eq!(loop_phase(&[turn(vec![test]), turn(vec![plan, mcp])]), Some("verifying"));
    }

    #[test]
    fn reads_while_wrapping_up_do_not_send_a_chat_back() {
        let turn = |calls: Vec<Value>| json!({ "role": "assistant", "content": "", "toolCalls": calls });
        let user = json!({ "role": "user", "content": "next" });
        let read = call("read_file", json!({ "path": "memory.md" }));
        let shot = call("browser", json!({ "action": "screenshot" }));
        let edit = call("edit_file", json!({ "path": "a.ts" }));
        let ship = call("bash", json!({ "command": "gh pr create --title x" }));
        assert_eq!(
            loop_phase(&[turn(vec![edit.clone(), ship.clone()]), turn(vec![read.clone(), shot])]),
            Some("shipping")
        );
        assert_eq!(loop_phase(&[turn(vec![edit.clone()]), turn(vec![read.clone()])]), Some("building"));
        // A new message that starts with reads is new work.
        assert_eq!(loop_phase(&[turn(vec![ship.clone()]), user.clone(), turn(vec![read.clone()])]), Some("exploring"));
        // A watch waking the agent to check on its PR is not new work.
        let wake = json!({ "role": "user", "content": "[Agent watch w1]\nWatch deadline reached." });
        assert_eq!(loop_phase(&[turn(vec![ship.clone()]), wake, turn(vec![read.clone()])]), Some("shipping"));
        // A turn that names no phase leaves the chat where the last one did.
        let plan = call("update_plan", json!({}));
        assert_eq!(loop_phase(&[turn(vec![ship, read]), user, turn(vec![plan])]), Some("shipping"));
    }
}
