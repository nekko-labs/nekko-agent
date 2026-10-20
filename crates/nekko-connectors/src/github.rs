//! GitHub CI and pull request sources and actions (#682): the failed-run and
//! PR polls a connector trigger runs, the failed jobs' log tails, and the one
//! comment per PR a workflow keeps up to date. These came after the TS engine
//! was deleted, so they have Rust tests and no golden set.

use crate::actions::{Outcome, repo_path, slugify};
use crate::http::{Http, Request, Response};
use crate::js::{self, arr, at, date_ms, num, obj, or_empty, setting};
use serde_json::{Map, Value, json};

/// The trigger events these polls answer, instead of the Events API.
pub const RUN_FAILED: &str = "workflow_run_failed";
pub const PR_OPENED: &str = "pr_opened";
pub const PR_UPDATED: &str = "pr_updated";

/// Head SHAs remembered per trigger: enough for any repo's open PRs.
const MAX_PR_HEADS: usize = 200;
/// Comment pages read looking for the marker (100 comments each).
const MAX_COMMENT_PAGES: u32 = 10;
/// Lines kept before and after each `##[error]` line.
const ERROR_BEFORE: usize = 40;
const ERROR_AFTER: usize = 5;
/// The most log text one action returns, across every job.
const MAX_LOG_TOTAL: usize = 60_000;
/// The longest comment body posted, in characters (GitHub's own limit is 65536).
const MAX_COMMENT_CHARS: usize = 20_000;

fn headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("Accept".into(), "application/vnd.github+json".into()),
        ("User-Agent".into(), "nekko-agent".into()),
    ]
}

fn get(url: String, token: &str) -> Request {
    let mut r = Request::get(url, &[]);
    r.headers = headers(token);
    r
}

fn with_body(mut r: Request, token: &str, body: &Value) -> Request {
    r.headers = headers(token);
    r.headers.push(("Content-Type".into(), "application/json".into()));
    r.body = Some(nekko_js::stringify(body));
    r
}

/// The trigger's repo as `owner/name`; these sources have no account-wide form.
fn trigger_repo(settings: &Value, event: &str) -> Result<String, String> {
    let repo = setting(Some(settings), "repo");
    if repo.is_empty() {
        return Err(format!(
            "The GitHub {event} event needs a repo (owner/name); account-wide polling isn't supported for it."
        ));
    }
    repo_path(&repo)
}

/// A failed listing, naming the token permission it needs on a 403 or 404.
fn read_error(res: &Response, repo: &str, what: &str, fine_grained: &str) -> String {
    if res.status == 403 || res.status == 404 {
        format!(
            "GitHub {}: can't read {what} on {repo}. Check the repo name, and that the token has {fine_grained} (fine-grained) or the repo scope (classic).",
            res.status
        )
    } else {
        format!("GitHub {}", res.status)
    }
}

/// Whether the trigger asks for one of these sources rather than the Events API.
pub fn handles(event: &str) -> bool {
    matches!(event, RUN_FAILED | PR_OPENED | PR_UPDATED)
}

/// The poll for `event` (one `handles` accepts).
pub async fn poll(http: &dyn Http, token: &str, settings: &Value, cursor: f64, event: &str) -> Result<Value, String> {
    if event == RUN_FAILED {
        poll_failed_runs(http, token, settings, cursor).await
    } else {
        poll_prs(http, token, settings, cursor, event).await
    }
}

/* ---------------------------- failed runs ---------------------------- */

/// Completed runs that failed or timed out since `cursor` (their `updated_at`:
/// a run completes long after it is created). The id is `<run>:<attempt>`, so
/// a re-run that fails again fires again.
async fn poll_failed_runs(http: &dyn Http, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    let repo = trigger_repo(settings, RUN_FAILED)?;
    let url = format!("https://api.github.com/repos/{repo}/actions/runs?status=completed&per_page=25");
    let res = http.send(get(url, token)).await?;
    if !res.ok() {
        return Err(read_error(&res, &repo, "Actions runs", "Actions: read"));
    }
    let data = js::parse_json(&res.body)?;
    let mut events = Vec::new();
    // Oldest first, so the runs start in the order they failed.
    for run in arr(data.get("workflow_runs")).iter().rev() {
        let conclusion = or_empty(run.get("conclusion"));
        if conclusion != "failure" && conclusion != "timed_out" {
            continue;
        }
        let updated = date_ms(run.get("updated_at"));
        if updated.is_nan() || updated <= cursor {
            continue;
        }
        let number = match run.get("pull_requests").and_then(|p| p.get(0)).and_then(|p| p.get("number")) {
            Some(n) if nekko_js::truthy(Some(n)) => Some(n.clone()),
            // A fork PR's run lists no pull requests: ask which PR holds the commit.
            _ => pr_for_commit(http, token, &repo, &or_empty(run.get("head_sha"))).await,
        };
        let workflow = run.get("name").filter(|v| !v.is_null()).map_or("Workflow".into(), nekko_js::display);
        let branch = or_empty(run.get("head_branch"));
        let text = format!("{workflow} failed on {branch} (run {})", or_empty(run.get("run_number")));
        let actor = at(run, &["triggering_actor", "login"])
            .or_else(|| at(run, &["actor", "login"]))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| json!(s));
        events.push(obj(vec![
            ("id", Some(json!(format!("{}:{}", or_empty(run.get("id")), or_empty(run.get("run_attempt")))))),
            ("cursor", Some(num(updated))),
            ("event", Some(json!(RUN_FAILED))),
            ("text", Some(json!(text))),
            ("source", Some(json!(repo))),
            (
                "payload",
                Some(obj(vec![
                    ("run_id", run.get("id").cloned()),
                    ("run_attempt", run.get("run_attempt").cloned()),
                    ("workflow", Some(json!(workflow))),
                    ("branch", Some(json!(branch))),
                    ("sha", run.get("head_sha").cloned()),
                    ("html_url", run.get("html_url").cloned()),
                    ("conclusion", Some(json!(conclusion))),
                    ("trigger_event", run.get("event").cloned()),
                    ("number", number),
                ])),
            ),
            ("actor", actor),
        ]));
    }
    Ok(result(events, cursor, None))
}

/// The PR whose head is `sha`, else the first PR holding it; `None` when
/// there is none or the lookup fails (the event still fires, without a number).
async fn pr_for_commit(http: &dyn Http, token: &str, repo: &str, sha: &str) -> Option<Value> {
    if sha.is_empty() {
        return None;
    }
    let url = format!("https://api.github.com/repos/{repo}/commits/{}/pulls", js::encode_uri_component(sha));
    let res = http.send(get(url, token)).await.ok().filter(Response::ok)?;
    let pulls = arr(Some(&serde_json::from_str(&res.body).ok()?));
    let pick = pulls.iter().find(|p| at(p, &["head", "sha"]).and_then(Value::as_str) == Some(sha)).or(pulls.first());
    pick.and_then(|p| p.get("number")).filter(|n| nekko_js::truthy(Some(n))).cloned()
}

fn result(events: Vec<Value>, cursor: f64, state: Option<Value>) -> Value {
    let next = events.iter().filter_map(|e| e.get("cursor").and_then(Value::as_f64)).fold(cursor, f64::max);
    obj(vec![("events", Some(Value::Array(events))), ("nextCursor", Some(num(next))), ("pollState", state)])
}

/* ------------------------------- PRs -------------------------------- */

/// Open PRs, most recently updated first. A PR seen for the first time fires
/// `pr_opened`, a new head SHA on one fires `pr_updated`; the trigger takes
/// the one it names. The head SHAs live in the cursor record's `pollState`
/// (`{ prHeads: { "<number>": "<sha>" } }`, oldest first, bounded). With no
/// state yet the poll arms: it records the open PRs and fires nothing, so a
/// new trigger does not review the backlog. Drafts are skipped (and not
/// recorded, so marking one ready fires `pr_opened`) unless `includeDrafts`.
async fn poll_prs(http: &dyn Http, token: &str, settings: &Value, cursor: f64, want: &str) -> Result<Value, String> {
    let repo = trigger_repo(settings, want)?;
    let url = format!("https://api.github.com/repos/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=25");
    let res = http.send(get(url, token)).await?;
    if !res.ok() {
        return Err(read_error(&res, &repo, "pull requests", "Pull requests: read"));
    }
    let data = js::parse_json(&res.body)?;
    let drafts = nekko_js::truthy(settings.get("includeDrafts"));
    let prior = at(settings, &["pollState", "prHeads"]).and_then(Value::as_object);
    let arming = prior.is_none();
    let mut heads: Map<String, Value> = prior.cloned().unwrap_or_default();
    let mut events = Vec::new();
    for pr in arr(Some(&data)).iter().rev() {
        let number = or_empty(pr.get("number"));
        let sha = or_empty(at(pr, &["head", "sha"]));
        if number.is_empty() || sha.is_empty() {
            continue;
        }
        let draft = nekko_js::truthy(pr.get("draft"));
        if draft && !drafts {
            continue;
        }
        let kind = match heads.get(&number).and_then(Value::as_str) {
            None => PR_OPENED,
            Some(seen) if seen != sha => PR_UPDATED,
            Some(_) => continue,
        };
        // Move it to the end: the map drops the PRs it heard of longest ago.
        heads.shift_remove(&number);
        heads.insert(number.clone(), json!(sha));
        if arming || kind != want {
            continue;
        }
        let base_repo = at(pr, &["base", "repo", "full_name"]).and_then(Value::as_str);
        let head_repo = at(pr, &["head", "repo", "full_name"]).and_then(Value::as_str);
        // A deleted fork leaves the head repo null; it was still a fork.
        let is_fork = head_repo.is_none() || head_repo != base_repo;
        let title = or_empty(pr.get("title"));
        let verb = if kind == PR_OPENED { "opened" } else { "updated" };
        // The head SHA map decides what is new; the event's cursor only has to
        // clear the listener's, even when this machine's clock runs ahead of GitHub's.
        let updated = date_ms(pr.get("updated_at"));
        let c = if updated > cursor { updated } else { cursor + 1.0 };
        let author = at(pr, &["user", "login"]).cloned();
        events.push(obj(vec![
            ("id", Some(json!(format!("{number}:{sha}")))),
            ("cursor", Some(num(c))),
            ("event", Some(json!(kind))),
            ("text", Some(json!(nekko_js::trim(&format!("PR #{number} {verb}: {title}")).to_string()))),
            ("source", Some(json!(repo))),
            (
                "payload",
                Some(obj(vec![
                    ("number", pr.get("number").cloned()),
                    ("title", Some(json!(title))),
                    ("branch", at(pr, &["head", "ref"]).cloned()),
                    ("base", at(pr, &["base", "ref"]).cloned()),
                    ("sha", Some(json!(sha))),
                    ("author", author.clone()),
                    ("author_association", pr.get("author_association").cloned()),
                    ("head_repo", Some(head_repo.map_or(Value::Null, |r| json!(r)))),
                    ("is_fork", Some(json!(is_fork))),
                    ("draft", Some(json!(draft))),
                    ("html_url", pr.get("html_url").cloned()),
                ])),
            ),
            ("actor", author.filter(|a| a.as_str().is_some_and(|s| !s.is_empty()))),
        ]));
    }
    let excess = heads.len().saturating_sub(MAX_PR_HEADS);
    let heads: Map<String, Value> = heads.into_iter().skip(excess).collect();
    Ok(result(events, cursor, Some(json!({ "prHeads": heads }))))
}

/* --------------------------- failure logs ---------------------------- */

fn is_failed(v: Option<&Value>) -> bool {
    matches!(v.and_then(Value::as_str), Some("failure" | "timed_out"))
}

/// A whole-number param, else its default, clamped.
fn count(v: Option<&Value>, default: usize, min: usize, max: usize) -> usize {
    let n = nekko_js::to_number(v.filter(|v| !v.is_null() && v.as_str() != Some("")));
    if n.is_finite() && n >= 1.0 { (n as usize).clamp(min, max) } else { default }
}

/// `github.runFailureLogs`: the failed jobs of a run, each with its failed
/// steps and the part of its log around the errors.
pub async fn run_failure_logs(http: &dyn Http, token: &str, repo: &str, run_id: &str, params: &Value) -> Outcome {
    let per_job = count(params.get("max_bytes_per_job"), 12_000, 500, MAX_LOG_TOTAL);
    let max_jobs = count(params.get("max_jobs"), 3, 1, 20);
    let url = format!(
        "https://api.github.com/repos/{repo}/actions/runs/{}/jobs?filter=latest&per_page=100",
        js::encode_uri_component(run_id)
    );
    let res = match http.send(get(url, token)).await {
        Ok(r) => r,
        Err(e) => return Outcome::fail(e),
    };
    if !res.ok() {
        return crate::actions::http_error(&res, &format!("GitHub jobs for {repo} run {run_id}"));
    }
    let data = js::parse_json(&res.body).unwrap_or(Value::Null);
    let failed: Vec<Value> = arr(data.get("jobs")).into_iter().filter(|j| is_failed(j.get("conclusion"))).collect();
    if failed.is_empty() {
        return Outcome::ok(format!("No failed jobs in {repo} run {run_id}."));
    }
    let mut sections = Vec::new();
    let mut budget = MAX_LOG_TOTAL;
    let mut unreadable = 0;
    for job in failed.iter().take(max_jobs) {
        let name = job.get("name").filter(|v| !v.is_null()).map_or("job".into(), nekko_js::display);
        let steps: Vec<String> = arr(job.get("steps"))
            .iter()
            .filter(|s| is_failed(s.get("conclusion")))
            .map(|s| or_empty(s.get("name")))
            .filter(|s| !s.is_empty())
            .collect();
        let heading =
            if steps.is_empty() { format!("### {name}") } else { format!("### {name} / {}", steps.join(", ")) };
        let body = match job_log(http, token, repo, &or_empty(job.get("id"))).await {
            Ok(log) => {
                let cap = per_job.min(budget);
                let text = trim_log(&log, cap);
                budget = budget.saturating_sub(text.len());
                text
            }
            Err(why) => {
                unreadable += 1;
                format!("(log unavailable: {why})")
            }
        };
        sections.push(format!("{heading}\n{body}"));
    }
    if failed.len() > max_jobs {
        sections.push(format!("({} more failed jobs not shown)", failed.len() - max_jobs));
    }
    let output = sections.join("\n\n");
    if unreadable == failed.len().min(max_jobs) { Outcome::fail(output) } else { Outcome::ok(output) }
}

/// A job's log. The API answers with a redirect to blob storage; that hop is
/// taken by hand and without the Authorization header, so the token never
/// reaches the storage host.
async fn job_log(http: &dyn Http, token: &str, repo: &str, job_id: &str) -> Result<String, String> {
    let url = format!("https://api.github.com/repos/{repo}/actions/jobs/{}/logs", js::encode_uri_component(job_id));
    let mut req = get(url, token);
    req.no_redirect = true;
    let res = http.send(req).await?;
    if res.ok() {
        return Ok(res.body);
    }
    if !(300..400).contains(&res.status) {
        return Err(format!("HTTP {}", res.status));
    }
    let location = res.location.filter(|l| js::parse_url(l).is_some_and(|u| u.protocol == "https:"));
    let Some(location) = location else { return Err(format!("HTTP {} without an https location", res.status)) };
    let blob = http.send(Request::get(location, &[("User-Agent", "nekko-agent")])).await?;
    if !blob.ok() {
        return Err(format!("HTTP {}", blob.status));
    }
    Ok(blob.body)
}

/// One log line without its runner timestamp and ANSI colour codes.
fn clean_line(line: &str) -> String {
    let line = line.strip_suffix('\r').unwrap_or(line).trim_start_matches('\u{feff}');
    let line = match line.split_once(' ') {
        Some((stamp, rest)) if is_timestamp(stamp) => rest,
        _ if is_timestamp(line) => "",
        _ => line,
    };
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI: ESC [ parameters, then one final byte in @..~.
        if chars.peek() == Some(&'[') {
            chars.next();
            for f in chars.by_ref() {
                if ('@'..='~').contains(&f) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

/// `2026-01-02T03:04:05.1234567Z`, as the runner prefixes every line.
fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    b.len() >= 20
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19)
        && b[b.len() - 1] == b'Z'
}

/// The useful part of a job log, at most `cap` bytes: the lines around each
/// `##[error]` line (else the whole log), keeping the end when it is too long.
pub fn trim_log(raw: &str, cap: usize) -> String {
    let lines: Vec<String> = raw.split('\n').map(clean_line).collect();
    let errors: Vec<usize> =
        lines.iter().enumerate().filter(|(_, l)| l.contains("##[error]")).map(|(i, _)| i).collect();
    let text = if errors.is_empty() {
        lines.join("\n")
    } else {
        let mut keep: Vec<(usize, usize)> = Vec::new();
        for i in errors {
            let (from, to) = (i.saturating_sub(ERROR_BEFORE), (i + ERROR_AFTER).min(lines.len() - 1));
            match keep.last_mut() {
                Some(last) if from <= last.1 + 1 => last.1 = last.1.max(to),
                _ => keep.push((from, to)),
            }
        }
        keep.iter().map(|&(a, b)| lines[a..=b].join("\n")).collect::<Vec<_>>().join("\n…\n")
    };
    let text = text.trim_matches('\n');
    if text.len() <= cap {
        return text.to_string();
    }
    let marker = "… (earlier lines trimmed)\n";
    let room = cap.saturating_sub(marker.len());
    let mut start = text.len() - room;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    // Start on a whole line when one begins close by.
    if let Some(nl) = text[start..].find('\n').filter(|&nl| nl < 200) {
        start += nl + 1;
    }
    format!("{marker}{}", &text[start..])
}

/* ---------------------------- PR comment ----------------------------- */

/// `github.upsertPRComment`: the PR's one comment carrying `<!-- marker -->`,
/// updated in place, else a new one. The body is often a model's words about
/// text someone else wrote, so it pings nobody and stays bounded.
pub async fn upsert_pr_comment(
    http: &dyn Http,
    token: &str,
    repo: &str,
    number: &str,
    body: &str,
    marker: &str,
) -> Result<Outcome, String> {
    // A marker holding `--` or `>` would close the HTML comment early.
    let marker: String = marker.replace("--", "-").chars().filter(|c| *c != '>').collect();
    let tag = format!("<!-- {marker} -->");
    let full = format!("{}\n\n{tag}", cap_comment(&quiet_mentions(body)));
    let n = js::encode_uri_component(number);
    let mut found: Option<Value> = None;
    for page in 1..=MAX_COMMENT_PAGES {
        let url = format!("https://api.github.com/repos/{repo}/issues/{n}/comments?per_page=100&page={page}");
        let res = http.send(get(url, token)).await?;
        if !res.ok() {
            return Ok(crate::actions::http_error(&res, &format!("GitHub comments on {repo}#{number}")));
        }
        let comments = arr(Some(&js::parse_json(&res.body)?));
        found = comments.iter().find(|c| or_empty(c.get("body")).contains(&tag)).cloned();
        if found.is_some() || comments.len() < 100 {
            break;
        }
    }
    let payload = json!({ "body": full });
    let (res, verb) = match &found {
        Some(c) => {
            let url = format!("https://api.github.com/repos/{repo}/issues/comments/{}", or_empty(c.get("id")));
            (http.send(with_body(Request::patch(url, &[], None), token, &payload)).await?, "Updated")
        }
        None => {
            let url = format!("https://api.github.com/repos/{repo}/issues/{n}/comments");
            (http.send(with_body(Request::post(url, &[], None), token, &payload)).await?, "Created")
        }
    };
    if !res.ok() {
        return Ok(crate::actions::http_error(&res, &format!("GitHub comment on {repo}#{number}")));
    }
    let json: Value = serde_json::from_str(&res.body).unwrap_or(Value::Null);
    let link = json.get("html_url").and_then(Value::as_str).map(|u| format!(" {u}")).unwrap_or_default();
    Ok(Outcome::ok(format!("{verb} the comment on {repo}#{number}{link}")))
}

/// `@name` and `@org/team` with a zero-width space after the `@`, so GitHub
/// renders them as text and notifies no one. An `@` inside a word (an email
/// address) is not a mention and is left alone.
pub fn quiet_mentions(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut prev: Option<char> = None;
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        let starts_word = !prev.is_some_and(|p| p.is_alphanumeric() || p == '_' || p == '`');
        if c == '@' && starts_word && chars.peek().is_some_and(|n| n.is_ascii_alphanumeric()) {
            out.push('\u{200b}');
        }
        prev = Some(c);
    }
    out
}

/// The body cut to `MAX_COMMENT_CHARS`, saying so when it was.
pub fn cap_comment(body: &str) -> String {
    if body.chars().count() <= MAX_COMMENT_CHARS {
        return body.to_string();
    }
    let cut: String = body.chars().take(MAX_COMMENT_CHARS).collect();
    format!("{cut}\n\n… (trimmed)")
}

/// The marker a workflow's comment carries when the step names none.
pub fn default_marker(workflow_name: &str) -> String {
    format!("nekko-agent:{}", slugify(workflow_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_runner_lines() {
        assert_eq!(clean_line("2026-01-02T03:04:05.1234567Z \u{1b}[31mboom\u{1b}[0m done\r"), "boom done");
        assert_eq!(clean_line("\u{feff}2026-01-02T03:04:05.1234567Z ##[group]Run x"), "##[group]Run x");
        assert_eq!(clean_line("plain line"), "plain line");
        assert_eq!(clean_line("2026-01-02T03:04:05.1Z"), "");
    }

    #[test]
    fn windows_errors_and_caps() {
        let mut log: Vec<String> = (0..200).map(|i| format!("2026-01-02T03:04:05.0000000Z line {i}")).collect();
        log[100] = "2026-01-02T03:04:05.0000000Z ##[error]Process completed with exit code 1.".into();
        let out = trim_log(&log.join("\n"), 100_000);
        assert!(out.starts_with("line 60\n"), "{out}");
        assert!(out.ends_with("line 105"), "{out}");
        assert!(out.contains("##[error]Process completed"));
        assert!(!out.contains("line 59\n"));

        let capped = trim_log(&log.join("\n"), 300);
        assert!(capped.len() <= 300, "{}", capped.len());
        assert!(capped.starts_with("… (earlier lines trimmed)\n"));
        assert!(capped.ends_with("line 105"));
    }

    #[test]
    fn no_error_lines_keeps_the_tail() {
        let log: Vec<String> = (0..1000).map(|i| format!("line {i}")).collect();
        let out = trim_log(&log.join("\n"), 200);
        assert!(out.ends_with("line 999"));
        assert!(out.len() <= 200);
    }

    #[test]
    fn mentions_are_quieted() {
        let zw = '\u{200b}';
        assert_eq!(quiet_mentions("cc @octocat and @org/team"), format!("cc @{zw}octocat and @{zw}org/team"));
        assert_eq!(quiet_mentions("@here: fix it"), format!("@{zw}here: fix it"));
        assert_eq!(quiet_mentions("(@a) [@b]"), format!("(@{zw}a) [@{zw}b]"));
        assert_eq!(quiet_mentions("mail dev@example.com"), "mail dev@example.com");
        assert_eq!(quiet_mentions("a lone @ and @@"), "a lone @ and @@");
    }

    #[test]
    fn long_comments_are_capped() {
        let long = "é".repeat(MAX_COMMENT_CHARS + 50);
        let out = cap_comment(&long);
        assert!(out.ends_with("… (trimmed)"));
        assert_eq!(out.chars().filter(|c| *c == 'é').count(), MAX_COMMENT_CHARS);
        assert_eq!(cap_comment("short"), "short");
    }

    #[test]
    fn two_error_windows_are_separated() {
        let mut log: Vec<String> = (0..300).map(|i| format!("l{i}")).collect();
        log[50] = "##[error]first".into();
        log[250] = "##[error]second".into();
        let out = trim_log(&log.join("\n"), 100_000);
        assert!(out.contains("l55\n…\nl210"), "{out}");
    }
}
