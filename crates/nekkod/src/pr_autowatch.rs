//! Watching a chat's own PRs until they are merge-ready, by default.
//!
//! An agent that opens a PR and ends its turn used to stop there unless it
//! chose to arm `agent_watch`, and a Claude Code chat has no `agent_watch` at
//! all. So the host arms the watch itself: when a turn ends, every PR the chat
//! opened that is still open and has no armed watch gets a PR watch whose
//! continuation is "get this PR merge-ready". When it wakes the chat (a check
//! finished, a review landed, or the deadline passed) the agent fixes what it
//! can, and the next turn end re-arms the watch while the PR stays open.
//!
//! It stops for a PR once the PR is merged or closed, once the user cancels
//! the host's watch on it, after a failed wake-up, or after [`MAX_ROUNDS`]
//! wake-ups. Settings > Pull requests turns it off (`watchUntilMergeReady`).

use serde_json::Value;

/// How long one watch waits for the PR to change before waking anyway.
pub const TIMEOUT_SECONDS: f64 = 3.0 * 3600.0;

/// Wake-ups per PR and chat before the host stops re-arming (about three days
/// of a PR that never changes, far more when it does).
pub const MAX_ROUNDS: usize = 24;

/// On unless the user turned it off.
pub fn enabled(settings: &Value) -> bool {
    settings.pointer("/pullRequests/watchUntilMergeReady") != Some(&Value::Bool(false))
}

/// Chats the host may drive on its own: not incognito, offline or a training
/// run (whose turns report experiments, not PRs).
pub fn eligible(session: &Value) -> bool {
    let on = |k: &str| nekko_js::truthy(session.get(k));
    !on("incognito") && !on("offline") && !on("trainingRunId") && !on("archivedAt")
}

/// The continuation the watch wakes the chat with.
pub fn continuation(url: &str) -> String {
    format!(
        "Get {url} merge-ready. Nekko armed this watch by default because this chat opened the PR. \
Fetch its current state first: required checks, reviews and unresolved review comments, merge conflicts, \
the description's Unfinished work / release blockers section, and any evidence the repository requires. \
Fix what this change broke and push; diagnose a failing check before rerunning it, and rerun only for a named \
transient cause. Address review comments and resolve conflicts. Once nothing blocks it, land it the way the \
repository lands changes (its merge queue or auto-merge) if the user or the repository's own instructions \
authorize landing; otherwise say it is merge-ready. Never bypass branch protections, required reviews or \
approvals, and never weaken or delete a check. If only the user can unblock it (a decision, a credential, an \
approval), say exactly what is needed. If the user asked to hold this PR, leave it alone. Nekko re-arms this \
watch while the PR stays open, so you do not need to arm one yourself."
    )
}

/// The PRs this chat opened: a successful `gh pr create` (or `gh api
/// .../pulls -X POST`) through a shell tool, or a connector's
/// create-pull-request tool, and the PR URL its output names (the last one,
/// since gh prints warnings first). Other PRs the chat only mentions or read
/// are not its to drive.
pub fn opened_prs(messages: &[Value]) -> Vec<String> {
    let mut calls: std::collections::HashMap<String, &Value> = std::collections::HashMap::new();
    for m in messages {
        for c in m.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = c.get("id").and_then(Value::as_str) {
                calls.insert(id.to_string(), c);
            }
        }
    }
    let mut urls: Vec<String> = Vec::new();
    for m in messages {
        let Some(result) = m.get("toolResult").filter(|r| r.is_object()) else { continue };
        if nekko_js::truthy(result.get("isError")) {
            continue;
        }
        let Some(call) = result.get("toolCallId").and_then(Value::as_str).and_then(|id| calls.get(id)) else {
            continue;
        };
        if !creates_pr(call) {
            continue;
        }
        let output = result.get("output").map(nekko_js::display).unwrap_or_default();
        if let Some(url) = last_pr_url(&output)
            && !urls.contains(&url)
        {
            urls.push(url);
        }
    }
    urls
}

fn creates_pr(call: &Value) -> bool {
    let name = call.get("name").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    if name.ends_with("create_pull_request") || name.ends_with("create_pr") {
        return true;
    }
    if !matches!(name.as_str(), "bash" | "shell" | "powershell" | "run_command" | "terminal") {
        return false;
    }
    let command = call.pointer("/input/command").and_then(Value::as_str).unwrap_or_default();
    let words: Vec<&str> = command.split_whitespace().collect();
    words.windows(3).any(|w| w == ["gh", "pr", "create"])
        || (words.windows(2).any(|w| w == ["gh", "api"])
            && command.contains("/pulls")
            && words.windows(2).any(|w| matches!(w[0], "-X" | "--method") && w[1].eq_ignore_ascii_case("post")))
}

/// The last `https://github.com/<owner>/<repo>/pull/<n>` in the text, cut at
/// the number.
fn last_pr_url(text: &str) -> Option<String> {
    let mut found = None;
    let mut rest = text;
    while let Some(at) = rest.find("https://github.com/") {
        let tail = &rest[at..];
        let parts: Vec<&str> = tail["https://github.com/".len()..].splitn(4, '/').collect();
        if parts.len() == 4 && parts[2] == "pull" {
            let ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
            let digits: String = parts[3].chars().take_while(char::is_ascii_digit).collect();
            if ok(parts[0]) && ok(parts[1]) && !digits.is_empty() {
                found = Some(format!("https://github.com/{}/{}/pull/{digits}", parts[0], parts[1]));
            }
        }
        rest = &tail["https://github.com/".len()..];
    }
    found
}

/// Whether the host should arm another watch for this PR, from the chat's
/// watches on it (all statuses).
pub fn should_arm(watches_on_pr: &[&Value]) -> bool {
    let status = |w: &Value| w.get("status").and_then(Value::as_str).map(str::to_string);
    // Any armed watch, the agent's own included, already covers it.
    if watches_on_pr.iter().any(|w| status(w).as_deref() == Some("active")) {
        return false;
    }
    let auto: Vec<&&Value> = watches_on_pr.iter().filter(|w| w.get("auto") == Some(&Value::Bool(true))).collect();
    // The user cancelled the host's watch, or a wake-up could not be delivered.
    if auto.iter().any(|w| matches!(status(w).as_deref(), Some("cancelled" | "error"))) {
        return false;
    }
    auto.len() < MAX_ROUNDS
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn(name: &str, command: &str, output: &str, error: bool) -> Vec<Value> {
        vec![
            json!({ "role": "assistant", "toolCalls": [{ "id": "c1", "name": name, "input": { "command": command } }] }),
            json!({ "role": "tool", "toolResult": { "toolCallId": "c1", "output": output, "isError": error } }),
        ]
    }

    #[test]
    fn finds_prs_the_chat_opened_from_any_harness() {
        let url = "https://github.com/nekko-labs/nekko-agent/pull/1700";
        // Native bash, a chained command, and Claude Code's `Bash` with gh's warnings first.
        assert_eq!(opened_prs(&turn("bash", "gh pr create --fill", url, false)), vec![url]);
        assert_eq!(
            opened_prs(&turn(
                "Bash",
                "cd x && git push -u origin b && gh pr create --title t",
                &format!("Warning: 1 uncommitted change\n{url}\n"),
                false
            )),
            vec![url]
        );
        assert_eq!(
            opened_prs(&turn(
                "bash",
                "gh api repos/o/r/pulls -X POST -f title=t",
                "{\"html_url\":\"https://github.com/o/r/pull/9\"}",
                false
            )),
            vec!["https://github.com/o/r/pull/9"]
        );
        let mcp = vec![
            json!({ "role": "assistant", "toolCalls": [{ "id": "m", "name": "mcp__github__create_pull_request", "input": {} }] }),
            json!({ "role": "tool", "toolResult": { "toolCallId": "m", "output": "{\"html_url\":\"https://github.com/o/r/pull/3\"}" } }),
        ];
        assert_eq!(opened_prs(&mcp), vec!["https://github.com/o/r/pull/3"]);
    }

    #[test]
    fn ignores_prs_it_only_read_or_failed_to_open() {
        let url = "https://github.com/o/r/pull/5";
        assert!(opened_prs(&turn("bash", "gh pr view 5", url, false)).is_empty());
        assert!(opened_prs(&turn("bash", "gh pr create --fill", url, true)).is_empty());
        assert!(opened_prs(&turn("read_file", "gh pr create", url, false)).is_empty());
        assert!(opened_prs(&turn("bash", "echo gh pr creates", url, false)).is_empty());
    }

    #[test]
    fn cuts_the_url_at_the_number() {
        assert_eq!(
            last_pr_url("see https://github.com/o/r/pull/12/files."),
            Some("https://github.com/o/r/pull/12".into())
        );
        assert_eq!(last_pr_url("https://github.com/o/r/issues/1"), None);
    }

    #[test]
    fn arms_until_cancelled_failed_or_out_of_rounds() {
        let w = |status: &str, auto: bool| json!({ "status": status, "auto": auto });
        assert!(should_arm(&[]));
        let done = w("done", true);
        assert!(should_arm(&[&done]));
        // The agent's own watch on the PR is armed: nothing to add.
        let own = w("active", false);
        assert!(!should_arm(&[&done, &own]));
        // A finished watch of the agent's own does not stop the host.
        let own_done = w("done", false);
        assert!(should_arm(&[&own_done]));
        let cancelled = w("cancelled", true);
        assert!(!should_arm(&[&done, &cancelled]));
        let failed = w("error", true);
        assert!(!should_arm(&[&failed]));
        let rounds: Vec<Value> = (0..MAX_ROUNDS).map(|_| w("done", true)).collect();
        assert!(!should_arm(&rounds.iter().collect::<Vec<_>>()));
    }

    #[test]
    fn on_by_default_and_for_ordinary_chats_only() {
        assert!(enabled(&json!({})));
        assert!(enabled(&json!({ "pullRequests": { "linkIssue": false } })));
        assert!(!enabled(&json!({ "pullRequests": { "watchUntilMergeReady": false } })));
        assert!(eligible(&json!({ "id": "s", "parentSessionId": "p" })));
        assert!(!eligible(&json!({ "incognito": true })));
        assert!(!eligible(&json!({ "trainingRunId": "t" })));
    }
}
