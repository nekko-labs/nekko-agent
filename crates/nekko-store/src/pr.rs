//! Creation-only PR attribution shared by session summaries and live PR reads.
//! Keep aligned with `packages/shared/src/pr.ts::collectSessionPrUrls`.
use nekko_js as js;
use regress::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).expect("PR attribution pattern compiles"))
}

/// Shell tools whose commands can open a PR: Nekko's `bash`, Claude Code's
/// `Bash`, and Claude Code's `PowerShell` on Windows.
const SHELL_TOOLS: [&str; 4] = ["bash", "Bash", "PowerShell", "powershell"];

/// Every non-overlapping match of `pattern` in `text`, replaced with `with`.
fn replace_all(pattern: &Regex, text: &str, with: &str) -> String {
    let mut out = text.to_string();
    let ranges: Vec<_> = pattern.find_iter(text).map(|m| m.range()).collect();
    for range in ranges.into_iter().rev() {
        out.replace_range(range, with);
    }
    out
}

/// The top-level commands of a shell line: split on unquoted line breaks, `;`,
/// `&` (so `&&` and `2>&1` too) and `|`. Quoted text stays inside its command.
/// `escape` is `\` in bash and a backtick in PowerShell.
fn top_level_commands(command: &str, escape: char) -> Vec<String> {
    let mut commands = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars();
    while let Some(ch) = chars.next() {
        if ch == escape && quote != Some('\'') {
            current.push(ch);
            if let Some(next) = chars.next() {
                current.push(next);
            }
        } else if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            current.push(ch);
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            current.push(ch);
        } else if matches!(ch, '\r' | '\n' | ';' | '&' | '|') {
            commands.push(js::trim(&current).to_string());
            current.clear();
        } else {
            current.push(ch);
        }
    }
    commands.push(js::trim(&current).to_string());
    commands.retain(|c| !c.is_empty());
    commands
}

/// Only successful PR-creation tool results attach PRs to this chat: a top-level
/// `gh pr create` (or a POST to the pulls API) whose output holds the new PRs'
/// URLs as bare lines, no more of them than it ran create commands. The full
/// rules are on the shared collector; `packages/shared/fixtures/pr-creation.json`
/// runs against both.
pub fn collect_session_pr_urls(messages: &[Value]) -> Vec<String> {
    static HEREDOC: OnceLock<Regex> = OnceLock::new();
    static HERE_STRING: OnceLock<Regex> = OnceLock::new();
    static CREATE: OnceLock<Regex> = OnceLock::new();
    static ANSI: OnceLock<Regex> = OnceLock::new();
    static EXISTS: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    let mut calls: HashMap<&str, &Value> = HashMap::new();
    for m in messages {
        for c in m.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = c.get("id").and_then(Value::as_str) {
                calls.insert(id, c);
            }
        }
    }
    let mut urls: Vec<String> = Vec::new();
    for m in messages {
        let Some(result) = m.get("toolResult") else { continue };
        let call = result.get("toolCallId").and_then(Value::as_str).and_then(|id| calls.get(id));
        let Some(call) = call else { continue };
        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
        if js::truthy(result.get("isError")) || !SHELL_TOOLS.contains(&name) {
            continue;
        }
        let raw = call.get("input").and_then(|i| i.get("command")).and_then(Value::as_str).unwrap_or("");
        let powershell = name.eq_ignore_ascii_case("powershell");
        // Body text (a bash heredoc or a PowerShell here-string) is not commands.
        let command = if powershell {
            replace_all(re(&HERE_STRING, r#"@(['"])\r?\n[\s\S]*?\r?\n\1@"#), raw, "''")
        } else {
            replace_all(
                re(
                    &HEREDOC,
                    r#"<<-?\s*(['"]?)([A-Za-z_]\w*)\1\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?:\r?\n[ \t]*(?=\))|(?=\r?\n|$))"#,
                ),
                raw,
                "<<HEREDOC",
            )
        };
        let create = re(
            &CREATE,
            r"^(?:\$[A-Za-z_][\w:]*\s*=\s*|[A-Za-z_]\w*=\S*\s+)*gh\s+(?:pr\s+create(?:\s|$)|api\s+\/?(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)(?=.*(?:-X|--method)\s+POST\b))",
        );
        let creates = top_level_commands(&command, if powershell { '`' } else { '\\' })
            .iter()
            .filter(|c| create.find(c).is_some())
            .count();
        if creates == 0 {
            continue;
        }
        let output = replace_all(
            re(&ANSI, r"\x1b\[[0-9;]*m"),
            result.get("output").and_then(Value::as_str).unwrap_or(""),
            "",
        );
        if re(&EXISTS, r"\balready exists\b").find(&output.to_ascii_lowercase()).is_some() {
            continue;
        }
        let url = re(&URL, r"^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$");
        let mut found: Vec<&str> = Vec::new();
        for line in output.split('\n').map(js::trim) {
            if url.find(line).is_some() && !found.contains(&line) {
                found.push(line);
            }
        }
        if found.len() <= creates {
            for value in found {
                if !urls.iter().any(|u| u == value) {
                    urls.push(value.to_string());
                }
            }
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn run(name: &str, command: &str, output: &str) -> Vec<Value> {
        vec![
            json!({"toolCalls": [{"id": "c", "name": name, "input": {"command": command}}]}),
            json!({"toolResult": {"toolCallId": "c", "output": output}}),
        ]
    }
    #[test]
    fn shared_pr_creation_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../packages/shared/fixtures/pr-creation.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let s = |k: &str| case[k].as_str().unwrap();
            let mut messages = run(s("tool"), s("command"), s("output"));
            if case["isError"] == json!(true) {
                messages[1]["toolResult"]["isError"] = json!(true);
            }
            let want: Vec<String> =
                case["expect"].as_array().unwrap().iter().map(|u| u.as_str().unwrap().to_string()).collect();
            assert_eq!(collect_session_pr_urls(&messages), want, "{}", s("name"));
        }
    }
    #[test]
    fn prose_mentions_do_not_attach_prs_and_repeats_dedupe() {
        let url = "https://github.com/o/r/pull/9";
        assert!(collect_session_pr_urls(&[json!({"role": "assistant", "content": url})]).is_empty());
        let mut twice = run("bash", "gh pr create --fill", url);
        twice.extend(run("bash", "gh pr create --fill", url));
        assert_eq!(collect_session_pr_urls(&twice), vec![url]);
    }
}
