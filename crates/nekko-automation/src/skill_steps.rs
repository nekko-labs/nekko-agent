//! What a skill step adds to a run: Claude Code's argument placeholders, the
//! skill's own allowlist, and the trust a pull request's run gets.

use serde_json::Value;

/// `$ARGUMENTS`, `$1`..`$9` and `${CLAUDE_PLUGIN_ROOT}` filled in, as Claude
/// Code fills a command's. A template with no `$ARGUMENTS` gets the arguments
/// on a line of their own after it, so they are never dropped.
pub fn expand_skill_template(template: &str, args: &str, plugin_root: Option<&str>) -> String {
    let args = args.trim();
    let words = split_args(args);
    let mut text = match plugin_root {
        Some(root) => template.replace("${CLAUDE_PLUGIN_ROOT}", root),
        None => template.to_string(),
    };
    let had_arguments = text.contains("$ARGUMENTS");
    text = text.replace("$ARGUMENTS", args);
    // `$1`..`$9`, not `$10` or `$1x` read as `$1` and a digit.
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$'
            && let Some(d) = chars.get(i + 1).and_then(|c| c.to_digit(10)).filter(|d| (1..=9).contains(d))
            && !chars.get(i + 2).is_some_and(char::is_ascii_digit)
        {
            out.push_str(words.get(d as usize - 1).map(String::as_str).unwrap_or(""));
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    if !had_arguments && !args.is_empty() {
        out = format!("{}\n\nARGUMENTS: {args}", out.trim_end());
    }
    out
}

/// Arguments split on whitespace, with `"..."` and `'...'` kept whole.
fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut in_word = false;
    for c in args.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                }
                in_word = false;
            }
            (None, c) => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    out
}

/// The associations GitHub gives people who can push to the repo.
const TRUSTED_ASSOCIATIONS: &[&str] = &["OWNER", "MEMBER", "COLLABORATOR"];

/// The pull request a run was started for, from its event: `Some(number)`
/// for a GitHub or git PR event that names one.
pub fn pr_number(event: Option<&Value>) -> Option<String> {
    let e = event?;
    let kind = e.get("event").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "pr_opened" | "pr_updated") {
        return None;
    }
    let n = e.pointer("/payload/number").or_else(|| e.get("number"))?;
    let n = match n {
        Value::Number(n) => n.as_u64()?.to_string(),
        Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.clone(),
        _ => return None,
    };
    Some(n)
}

/// A PR is trusted when its head is in the same repo and its author can
/// push to it (`OWNER`, `MEMBER`, `COLLABORATOR`). Anything missing is untrusted.
pub fn pr_trusted(event: &Value) -> bool {
    let p = event.get("payload").unwrap_or(&Value::Null);
    let same_repo = p.get("is_fork") == Some(&Value::Bool(false));
    let assoc = p.get("author_association").and_then(Value::as_str).unwrap_or("");
    same_repo && TRUSTED_ASSOCIATIONS.contains(&assoc)
}

/// What an untrusted PR's step is told, so its review says what it skipped.
pub const UNTRUSTED_NOTE: &str = "This pull request is untrusted (it comes from a fork, or its author cannot push to the repository), so commands that run the repository's code (package managers, build tools, linters, tests, scripts) are unavailable in this run. Do not try them. Review by reading the code, and where your instructions ask for those checks, report \"lint/audit skipped: untrusted PR\" instead of failing the step.";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn arguments_and_the_plugin_root_are_filled_in() {
        let t = "Review PR $ARGUMENTS (first $1, second $2, none $3, not $10) from ${CLAUDE_PLUGIN_ROOT}/refs.";
        assert_eq!(
            expand_skill_template(t, " 42 \"two words\" ", Some("/p")),
            "Review PR 42 \"two words\" (first 42, second two words, none , not $10) from /p/refs."
        );
        // No plugin root: the placeholder stays as written.
        assert!(expand_skill_template("${CLAUDE_PLUGIN_ROOT}", "", None).contains("${CLAUDE_PLUGIN_ROOT}"));
    }

    #[test]
    fn arguments_with_no_placeholder_follow_the_template() {
        assert_eq!(expand_skill_template("Review the diff.\n", "12", None), "Review the diff.\n\nARGUMENTS: 12");
        assert_eq!(expand_skill_template("Review the diff.", "", None), "Review the diff.");
    }

    #[test]
    fn trust_needs_a_same_repo_head_and_a_pushing_author() {
        let pr = |assoc: Value, fork: Value| json!({ "event": "pr_opened", "payload": { "number": 7, "author_association": assoc, "is_fork": fork } });
        assert!(pr_trusted(&pr(json!("OWNER"), json!(false))));
        assert!(pr_trusted(&pr(json!("COLLABORATOR"), json!(false))));
        assert!(!pr_trusted(&pr(json!("CONTRIBUTOR"), json!(false))));
        assert!(!pr_trusted(&pr(json!("MEMBER"), json!(true))));
        assert!(!pr_trusted(&pr(Value::Null, Value::Null)));
        assert_eq!(pr_number(Some(&pr(json!("OWNER"), json!(false)))), Some("7".into()));
        assert_eq!(pr_number(Some(&json!({ "event": "push", "payload": { "number": 7 } }))), None);
        assert_eq!(pr_number(Some(&json!({ "event": "pr_opened", "payload": { "number": "7; rm" } }))), None);
    }
}
