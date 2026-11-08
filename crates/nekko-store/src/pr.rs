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

pub fn collect_session_pr_urls(messages: &[Value]) -> Vec<String> {
    static HEREDOC: OnceLock<Regex> = OnceLock::new();
    static CD: OnceLock<Regex> = OnceLock::new();
    static TRIM: OnceLock<Regex> = OnceLock::new();
    static CREATE: OnceLock<Regex> = OnceLock::new();
    static API: OnceLock<Regex> = OnceLock::new();
    static POST: OnceLock<Regex> = OnceLock::new();
    static URL: OnceLock<Regex> = OnceLock::new();
    let mut calls: HashMap<&str, &Value> = HashMap::new();
    for m in messages {
        for c in m.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = c.get("id").and_then(Value::as_str) {
                calls.insert(id, c);
            }
        }
    }
    let mut urls = Vec::new();
    for m in messages {
        let Some(result) = m.get("toolResult") else { continue };
        let call = result.get("toolCallId").and_then(Value::as_str).and_then(|id| calls.get(id));
        let Some(call) = call else { continue };
        if js::truthy(result.get("isError"))
            || !matches!(call.get("name").and_then(Value::as_str), Some("bash" | "Bash"))
        {
            continue;
        }
        let raw = call.get("input").and_then(|i| i.get("command")).and_then(Value::as_str).unwrap_or("");
        // Strip only the same bounded wrappers as the shared collector. Bodies
        // are not shell batches; additional commands and arbitrary pipes fail closed.
        let heredoc = re(
            &HEREDOC,
            r#"<<-?\s*(['"]?)([A-Za-z_]\w*)\1\r?\n[\s\S]*?\r?\n[ \t]*\2[ \t]*(?:\r?\n[ \t]*(?=\))|(?=\r?\n|$))"#,
        );
        let mut command = raw.to_string();
        let ranges: Vec<_> = heredoc.find_iter(raw).map(|m| m.range()).collect();
        for range in ranges.into_iter().rev() {
            command.replace_range(range, "<<HEREDOC");
        }
        command = js::trim(&command).to_string();
        if let Some(m) = re(&CD, r#"^cd\s+(?:"[^"`$]*"|'[^']*'|[^\s;&|`$"']+)\s*&&\s*"#).find(&command) {
            command = command[m.end()..].to_string();
        }
        if let Some(m) = re(&TRIM, r"(?:\s+2>&1)?(?:\s*\|\s*(?:tail|head)\s+(?:-n\s*)?-?\d+)?\s*$").find(&command) {
            command.truncate(m.start());
        }
        if !command.starts_with("gh ") || command.contains(['\r', '\n', ';', '&', '|', '`']) {
            continue;
        }
        let create = re(&CREATE, r"^gh\s+pr\s+create(?:\s|$)").find(&command).is_some();
        let api = re(&API, r"^gh\s+api\s+(?:repos\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls(?:\s|$)")
            .find(&command)
            .is_some()
            && re(&POST, r"(?:-X|--method)\s+POST\b").find(&command).is_some();
        if !create && !api {
            continue;
        }
        let output = js::trim(result.get("output").and_then(Value::as_str).unwrap_or(""));
        // gh emits the created URL last, possibly following warnings.
        let value = if create { js::trim(output.rsplit('\n').next().unwrap_or("")) } else { output };
        if re(&URL, r"^https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$").find(value).is_some()
            && !urls.iter().any(|u| u == value)
        {
            urls.push(value.to_string());
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
    fn claude_code_wrappers_and_warnings_match_shared_attribution() {
        let url = "https://github.com/o/r/pull/9";
        for name in ["bash", "Bash"] {
            for command in [
                "gh pr create --fill",
                "gh pr create --title Fix --body \"$(cat <<'EOF'\n## Summary\n- one; two | three\nEOF\n)\"",
                "cd C:/Users/me/code/app/.worktrees/fix && gh pr create --fill",
                "cd \"/tmp/my repo\" && gh pr create --fill",
                "cd a && gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n)\" 2>&1 | tail -5",
                "gh api repos/o/r/pulls -X POST",
                "gh api o/r/pulls --method POST",
            ] {
                assert_eq!(collect_session_pr_urls(&run(name, command, url)), vec![url], "{name}: {command}");
            }
            assert_eq!(
                collect_session_pr_urls(&run(
                    name,
                    "gh pr create --fill",
                    &format!("Warning: 1 uncommitted change\r\n{url}")
                )),
                vec![url]
            );
        }
    }
    #[test]
    fn ambiguous_commands_outputs_and_mentions_do_not_attach_prs() {
        let url = "https://github.com/o/r/pull/9";
        for command in [
            "cd a && cd b && gh pr create --fill",
            "cd $(mktemp -d) && gh pr create --fill",
            "gh pr create --fill && gh pr merge --auto",
            "gh pr create --fill | grep http",
            "gh pr create --body \"$(cat <<'EOF'\nx\nEOF\n)\" && gh pr merge --auto",
            "gh pr view 9",
            "echo gh pr create --fill",
        ] {
            assert!(collect_session_pr_urls(&run("Bash", command, url)).is_empty(), "{command}");
        }
        assert!(collect_session_pr_urls(&run("Read", "gh pr create --fill", url)).is_empty());
        assert!(
            collect_session_pr_urls(&run("bash", "gh pr create --fill", &format!("{url}\nsomething else"))).is_empty()
        );
        let mut failed = run("bash", "gh pr create --fill", url);
        failed[1]["toolResult"]["isError"] = json!(true);
        assert!(collect_session_pr_urls(&failed).is_empty());
        assert!(collect_session_pr_urls(&[json!({"role": "assistant", "content": url})]).is_empty());
        let mut twice = run("bash", "gh pr create --fill", url);
        twice.extend(run("bash", "gh pr create --fill", url));
        assert_eq!(collect_session_pr_urls(&twice), vec![url]);
    }
}
