//! The GitHub CI and PR sources and actions (#682) against scripted replies:
//! the requests they send and what they return.

use nekko_connectors::http::{BoxFut, Http, Request, Response};
use nekko_connectors::{poll, run_action};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Mutex;

/// Replies in order (`(status, body, location)`) and the requests seen.
#[derive(Default)]
struct Scripted {
    replies: Mutex<VecDeque<(u16, String, Option<String>)>>,
    seen: Mutex<Vec<Request>>,
}

impl Scripted {
    fn new(replies: Vec<(u16, Value)>) -> Self {
        let s = Self::default();
        for (status, body) in replies {
            s.push(status, body);
        }
        s
    }
    fn push(&self, status: u16, body: Value) {
        let text = match body {
            Value::String(t) => t,
            v => v.to_string(),
        };
        self.replies.lock().unwrap().push_back((status, text, None));
    }
    fn redirect(&self, to: &str) {
        self.replies.lock().unwrap().push_back((302, String::new(), Some(to.into())));
    }
    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|r| format!("{} {}", r.method, r.url)).collect()
    }
    fn request(&self, i: usize) -> Request {
        self.seen.lock().unwrap()[i].clone()
    }
}

impl Http for Scripted {
    fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>> {
        self.seen.lock().unwrap().push(req);
        let next = self.replies.lock().unwrap().pop_front();
        Box::pin(async move {
            let (status, body, location) = next.ok_or_else(|| "fetch failed".to_string())?;
            Ok(Response { status, body, location })
        })
    }
}

fn header<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

const T0: f64 = 1_767_225_600_000.0; // 2026-01-01T00:00:00Z

fn run(id: u64, attempt: u64, conclusion: &str, updated: &str, prs: Value) -> Value {
    json!({
        "id": id, "run_attempt": attempt, "run_number": id + 100, "name": "CI", "head_branch": "feat",
        "head_sha": format!("sha{id}"), "html_url": format!("https://github.com/o/r/actions/runs/{id}"),
        "conclusion": conclusion, "event": "pull_request", "updated_at": updated, "created_at": "2025-12-31T00:00:00Z",
        "pull_requests": prs, "triggering_actor": { "login": "dev" },
    })
}

fn runs_settings() -> Value {
    json!({ "repo": "o/r", "event": "workflow_run_failed" })
}

/* ---------------------------- failed runs ---------------------------- */

#[tokio::test]
async fn failed_runs_keep_failures_and_timeouts_only() {
    let http = Scripted::new(vec![(
        200,
        json!({ "workflow_runs": [
            run(4, 1, "timed_out", "2026-01-01T00:04:00Z", json!([{ "number": 9 }])),
            run(3, 1, "cancelled", "2026-01-01T00:03:00Z", json!([{ "number": 9 }])),
            run(2, 1, "success", "2026-01-01T00:02:00Z", json!([{ "number": 9 }])),
            run(1, 1, "failure", "2026-01-01T00:01:00Z", json!([{ "number": 9 }])),
        ] }),
    )]);
    let out = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap();
    assert_eq!(http.urls(), ["GET https://api.github.com/repos/o/r/actions/runs?status=completed&per_page=25"]);
    assert_eq!(header(&http.request(0), "Authorization"), Some("Bearer tok"));
    let events = out["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    // Oldest first.
    assert_eq!(
        events[0],
        json!({
            "id": "1:1", "cursor": T0 as i64 + 60_000, "event": "workflow_run_failed",
            "text": "CI failed on feat (run 101)", "source": "o/r",
            "payload": {
                "run_id": 1, "run_attempt": 1, "workflow": "CI", "branch": "feat", "sha": "sha1",
                "html_url": "https://github.com/o/r/actions/runs/1", "conclusion": "failure",
                "trigger_event": "pull_request", "number": 9,
            },
            "actor": "dev",
        })
    );
    assert_eq!(events[1]["id"], "4:1");
    assert_eq!(events[1]["payload"]["conclusion"], "timed_out");
    assert_eq!(out["nextCursor"], json!(T0 as i64 + 240_000));
}

#[tokio::test]
async fn fork_pr_number_comes_from_the_commit_lookup() {
    let http = Scripted::new(vec![
        (200, json!({ "workflow_runs": [run(5, 1, "failure", "2026-01-01T00:05:00Z", json!([]))] })),
        (200, json!([{ "number": 3, "head": { "sha": "other" } }, { "number": 12, "head": { "sha": "sha5" } }])),
    ]);
    let out = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap();
    assert_eq!(http.urls()[1], "GET https://api.github.com/repos/o/r/commits/sha5/pulls");
    assert_eq!(out["events"][0]["payload"]["number"], 12);
}

#[tokio::test]
async fn a_push_with_no_pr_leaves_the_number_unset() {
    let http = Scripted::new(vec![
        (200, json!({ "workflow_runs": [run(6, 1, "failure", "2026-01-01T00:05:00Z", json!([]))] })),
        (200, json!([])),
    ]);
    let out = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap();
    assert!(out["events"][0]["payload"].get("number").is_none());
    // A failed lookup does not fail the poll either.
    let http = Scripted::new(vec![
        (200, json!({ "workflow_runs": [run(6, 1, "failure", "2026-01-01T00:05:00Z", json!([]))] })),
        (500, json!("oops")),
    ]);
    let out = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap();
    assert_eq!(out["events"].as_array().unwrap().len(), 1);
    assert!(out["events"][0]["payload"].get("number").is_none());
}

#[tokio::test]
async fn a_rerun_that_fails_again_fires_again_and_old_runs_do_not() {
    let http = Scripted::new(vec![(
        200,
        json!({ "workflow_runs": [
            run(7, 2, "failure", "2026-01-01T00:10:00Z", json!([{ "number": 9 }])),
            run(8, 1, "failure", "2026-01-01T00:00:00Z", json!([{ "number": 9 }])),
        ] }),
    )]);
    // The cursor sits after attempt 1 of run 7 and at run 8's update.
    let out = poll(&http, "github", "tok", &runs_settings(), T0 + 300_000.0).await.unwrap();
    let ids: Vec<&str> = out["events"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["7:2"]);
    assert_eq!(out["nextCursor"], json!(T0 as i64 + 600_000));
    // Nothing new: the cursor stays.
    let http = Scripted::new(vec![(200, json!({ "workflow_runs": [] }))]);
    let out = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap();
    assert_eq!(out["nextCursor"], json!(T0 as i64));
}

#[tokio::test]
async fn failed_runs_need_a_repo_and_name_the_missing_scope() {
    let http = Scripted::default();
    let err = poll(&http, "github", "tok", &json!({ "event": "workflow_run_failed" }), T0).await.unwrap_err();
    assert!(err.contains("needs a repo (owner/name)"), "{err}");
    assert!(http.urls().is_empty());

    for status in [403, 404] {
        let http = Scripted::new(vec![(status, json!({ "message": "Resource not accessible by integration" }))]);
        let err = poll(&http, "github", "tok", &runs_settings(), T0).await.unwrap_err();
        assert!(err.starts_with(&format!("GitHub {status}: can't read Actions runs on o/r")), "{err}");
        assert!(err.contains("Actions: read") && err.contains("repo scope"), "{err}");
    }
}

/* ------------------------------- PRs -------------------------------- */

fn pr(number: u64, sha: &str, updated: &str, draft: bool, head_repo: Option<&str>) -> Value {
    json!({
        "number": number, "title": format!("PR {number}"), "draft": draft, "updated_at": updated,
        "html_url": format!("https://github.com/o/r/pull/{number}"), "author_association": "CONTRIBUTOR",
        "user": { "login": "alice" },
        "head": { "ref": "feat", "sha": sha, "repo": head_repo.map(|r| json!({ "full_name": r })) },
        "base": { "ref": "main", "repo": { "full_name": "o/r" } },
    })
}

async fn poll_prs(event: &str, prs: Value, state: Option<&Value>, cursor: f64, drafts: bool) -> (Value, Scripted) {
    let http = Scripted::new(vec![(200, prs)]);
    let mut settings = json!({ "repo": "o/r", "event": event });
    if let Some(s) = state {
        settings["pollState"] = s.clone();
    }
    if drafts {
        settings["includeDrafts"] = json!(true);
    }
    let out = poll(&http, "github", "tok", &settings, cursor).await.unwrap();
    (out, http)
}

fn ids(out: &Value) -> Vec<String> {
    out["events"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn arming_records_open_prs_without_firing() {
    let (out, http) = poll_prs(
        "pr_opened",
        json!([
            pr(2, "b", "2026-01-01T00:02:00Z", false, Some("o/r")),
            pr(1, "a", "2026-01-01T00:01:00Z", false, Some("o/r"))
        ]),
        None,
        T0,
        false,
    )
    .await;
    assert_eq!(
        http.urls(),
        ["GET https://api.github.com/repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=25"]
    );
    assert!(ids(&out).is_empty());
    assert_eq!(out["pollState"], json!({ "prHeads": { "1": "a", "2": "b" } }));
    assert_eq!(out["nextCursor"], json!(T0 as i64));
}

#[tokio::test]
async fn opened_fires_once_and_a_new_push_fires_updated() {
    let armed = json!({ "prHeads": { "1": "a" } });
    let list = json!([
        pr(2, "b", "2026-01-01T00:02:00Z", false, Some("fork/r")),
        pr(1, "a", "2026-01-01T00:01:00Z", false, Some("o/r")),
    ]);
    let (out, _) = poll_prs("pr_opened", list.clone(), Some(&armed), T0, false).await;
    assert_eq!(ids(&out), ["2:b"]);
    let ev = &out["events"][0];
    assert_eq!(ev["event"], "pr_opened");
    assert_eq!(ev["text"], "PR #2 opened: PR 2");
    assert_eq!(ev["actor"], "alice");
    assert_eq!(
        ev["payload"],
        json!({
            "number": 2, "title": "PR 2", "branch": "feat", "base": "main", "sha": "b", "author": "alice",
            "author_association": "CONTRIBUTOR", "head_repo": "fork/r", "is_fork": true, "draft": false,
            "html_url": "https://github.com/o/r/pull/2",
        })
    );
    // The state carried to the next poll (as the cursor record keeps it) fires nothing again.
    let state = out["pollState"].clone();
    let (again, _) = poll_prs("pr_opened", list, Some(&state), out["nextCursor"].as_f64().unwrap(), false).await;
    assert!(ids(&again).is_empty());
    assert_eq!(again["pollState"], state);

    // A push to PR 1: pr_updated fires, pr_opened does not.
    let pushed = json!([
        pr(1, "a2", "2026-01-01T00:05:00Z", false, Some("o/r")),
        pr(2, "b", "2026-01-01T00:02:00Z", false, Some("fork/r"))
    ]);
    let (upd, _) = poll_prs("pr_updated", pushed.clone(), Some(&state), T0 + 120_000.0, false).await;
    assert_eq!(ids(&upd), ["1:a2"]);
    assert_eq!(upd["events"][0]["payload"]["is_fork"], false);
    assert_eq!(upd["events"][0]["text"], "PR #1 updated: PR 1");
    let (opened, _) = poll_prs("pr_opened", pushed, Some(&state), T0 + 120_000.0, false).await;
    assert!(ids(&opened).is_empty());
    assert_eq!(opened["pollState"]["prHeads"]["1"], "a2");
}

#[tokio::test]
async fn drafts_are_skipped_unless_asked_for() {
    let armed = json!({ "prHeads": {} });
    let list = json!([pr(3, "c", "2026-01-01T00:03:00Z", true, Some("o/r"))]);
    let (out, _) = poll_prs("pr_opened", list.clone(), Some(&armed), T0, false).await;
    assert!(ids(&out).is_empty());
    // Not recorded, so marking it ready later fires pr_opened.
    assert_eq!(out["pollState"], json!({ "prHeads": {} }));
    let (out, _) = poll_prs("pr_opened", list, Some(&armed), T0, true).await;
    assert_eq!(ids(&out), ["3:c"]);
    assert_eq!(out["events"][0]["payload"]["draft"], true);
}

#[tokio::test]
async fn a_deleted_fork_is_still_a_fork_and_a_clock_ahead_of_github_still_fires() {
    let armed = json!({ "prHeads": {} });
    let list = json!([pr(4, "d", "2026-01-01T00:00:00Z", false, None)]);
    // This machine's cursor is ahead of the PR's updated_at.
    let (out, _) = poll_prs("pr_opened", list, Some(&armed), T0 + 60_000.0, false).await;
    assert_eq!(out["events"][0]["payload"]["is_fork"], true);
    assert_eq!(out["events"][0]["payload"]["head_repo"], Value::Null);
    assert_eq!(out["events"][0]["cursor"], json!(T0 as i64 + 60_001));
}

#[tokio::test]
async fn the_head_map_is_bounded() {
    let heads: serde_json::Map<String, Value> = (0..200).map(|i| (format!("{}", 1000 + i), json!("x"))).collect();
    let state = json!({ "prHeads": heads });
    let (out, _) =
        poll_prs("pr_opened", json!([pr(7, "s", "2026-01-01T00:03:00Z", false, Some("o/r"))]), Some(&state), T0, false)
            .await;
    let kept = out["pollState"]["prHeads"].as_object().unwrap();
    assert_eq!(kept.len(), 200);
    assert!(!kept.contains_key("1000"));
    assert_eq!(kept.keys().next_back().unwrap(), "7");
}

/* --------------------------- failure logs ---------------------------- */

fn gh_config() -> Value {
    json!({ "token": "tok" })
}

fn logs_ctx() -> Value {
    json!({ "event": { "repo": "o/r", "payload": { "run_id": 77 } }, "run": { "workflowName": "CI fixer" } })
}

fn jobs(list: Value) -> Value {
    json!({ "total_count": 3, "jobs": list })
}

#[tokio::test]
async fn logs_follow_the_redirect_without_the_token() {
    let http = Scripted::new(vec![(
        200,
        jobs(json!([
            { "id": 11, "name": "build", "conclusion": "failure", "steps": [
                { "name": "Checkout", "conclusion": "success" }, { "name": "Run tests", "conclusion": "failure" } ] },
            { "id": 12, "name": "lint", "conclusion": "success", "steps": [] },
        ])),
    )]);
    http.redirect("https://pipelines.actions.githubusercontent.com/logs/11?sig=abc");
    let log =
        "2026-01-01T00:00:00.0000000Z setup\n2026-01-01T00:00:01.0000000Z \u{1b}[31m##[error]tests failed\u{1b}[0m\n";
    http.push(200, json!(log));
    let out = run_action(&http, "github.runFailureLogs", Some(&gh_config()), &json!({}), &logs_ctx()).await;
    assert!(!out.is_error, "{}", out.output);
    assert_eq!(out.output, "### build / Run tests\nsetup\n##[error]tests failed");
    assert_eq!(
        http.urls(),
        [
            "GET https://api.github.com/repos/o/r/actions/runs/77/jobs?filter=latest&per_page=100",
            "GET https://api.github.com/repos/o/r/actions/jobs/11/logs",
            "GET https://pipelines.actions.githubusercontent.com/logs/11?sig=abc",
        ]
    );
    let api = http.request(1);
    assert!(api.no_redirect, "the API hop must not be followed automatically");
    assert_eq!(header(&api, "Authorization"), Some("Bearer tok"));
    let blob = http.request(2);
    assert_eq!(header(&blob, "Authorization"), None);
    assert!(blob.headers.iter().all(|(_, v)| !v.contains("tok")));
}

#[tokio::test]
async fn logs_cap_each_job_and_the_job_count() {
    let failing = |id: u64| json!({ "id": id, "name": format!("job{id}"), "conclusion": "failure", "steps": [] });
    let http = Scripted::new(vec![(200, jobs(json!([failing(1), failing(2), failing(3)])))]);
    let long: String = (0..5000).map(|i| format!("line {i}\n")).collect();
    for _ in 0..2 {
        http.redirect("https://blob.example/x");
        http.push(200, json!(long.clone()));
    }
    let params = json!({ "max_bytes_per_job": 1000, "max_jobs": 2 });
    let out = run_action(&http, "github.runFailureLogs", Some(&gh_config()), &params, &logs_ctx()).await;
    assert!(!out.is_error, "{}", out.output);
    let sections: Vec<&str> = out.output.split("\n\n").collect();
    assert_eq!(sections.len(), 3);
    assert!(sections[0].starts_with("### job1\n… (earlier lines trimmed)\n"));
    assert!(sections[0].ends_with("line 4999"));
    assert!(sections[0].len() <= 1000 + "### job1\n".len());
    assert!(sections[1].starts_with("### job2\n"));
    assert_eq!(sections[2], "(1 more failed jobs not shown)");
    assert_eq!(http.urls().len(), 5);
}

#[tokio::test]
async fn no_failed_jobs_and_unreadable_logs() {
    let http = Scripted::new(vec![(200, jobs(json!([{ "id": 1, "name": "a", "conclusion": "success" }])))]);
    let out = run_action(&http, "github.runFailureLogs", Some(&gh_config()), &json!({}), &logs_ctx()).await;
    assert_eq!(out.output, "No failed jobs in o/r run 77.");
    assert!(!out.is_error);

    let http = Scripted::new(vec![
        (200, jobs(json!([{ "id": 1, "name": "a", "conclusion": "failure", "steps": [] }]))),
        (404, json!({ "message": "Not Found" })),
    ]);
    let out = run_action(&http, "github.runFailureLogs", Some(&gh_config()), &json!({}), &logs_ctx()).await;
    assert!(out.is_error);
    assert_eq!(out.output, "### a\n(log unavailable: HTTP 404)");

    let http = Scripted::new(vec![(404, json!({ "message": "Not Found" }))]);
    let out = run_action(&http, "github.runFailureLogs", Some(&gh_config()), &json!({}), &logs_ctx()).await;
    assert!(out.is_error);
    assert_eq!(out.output, "GitHub jobs for o/r run 77 failed: 404: {\"message\":\"Not Found\"}");

    // Params win over the event.
    let http = Scripted::new(vec![(200, jobs(json!([])))]);
    let params = json!({ "repo": "a/b", "run_id": "5" });
    run_action(&http, "github.runFailureLogs", Some(&gh_config()), &params, &logs_ctx()).await;
    assert_eq!(http.urls(), ["GET https://api.github.com/repos/a/b/actions/runs/5/jobs?filter=latest&per_page=100"]);
}

/* ---------------------------- PR comment ----------------------------- */

fn comment_ctx(number: Option<u64>) -> Value {
    let mut payload = json!({ "run_id": 77 });
    if let Some(n) = number {
        payload["number"] = json!(n);
    }
    json!({ "event": { "repo": "o/r", "payload": payload }, "run": { "workflowName": "CI Fixer" } })
}

#[tokio::test]
async fn upsert_creates_when_no_comment_has_the_marker() {
    let http = Scripted::new(vec![
        (200, json!([{ "id": 1, "body": "LGTM" }, { "id": 2, "body": "<!-- nekko-agent:other -->" }])),
        (201, json!({ "id": 3, "html_url": "https://github.com/o/r/pull/9#issuecomment-3" })),
    ]);
    let out = run_action(
        &http,
        "github.upsertPRComment",
        Some(&gh_config()),
        &json!({ "body": "Fixed, @octocat" }),
        &comment_ctx(Some(9)),
    )
    .await;
    assert_eq!(out.output, "Created the comment on o/r#9 https://github.com/o/r/pull/9#issuecomment-3");
    assert_eq!(
        http.urls(),
        [
            "GET https://api.github.com/repos/o/r/issues/9/comments?per_page=100&page=1",
            "POST https://api.github.com/repos/o/r/issues/9/comments",
        ]
    );
    // The mention goes out with a zero-width space after the @, so nobody is pinged.
    let body: Value = serde_json::from_str(&http.request(1).body.unwrap()).unwrap();
    assert_eq!(body, json!({ "body": "Fixed, @\u{200b}octocat\n\n<!-- nekko-agent:ci-fixer -->" }));
}

#[tokio::test]
async fn upsert_updates_the_comment_with_the_marker() {
    let page1: Vec<Value> = (0..100).map(|i| json!({ "id": i, "body": "noise" })).collect();
    let http = Scripted::new(vec![
        (200, json!(page1)),
        (200, json!([{ "id": 500, "body": "old\n\n<!-- mine -->" }])),
        (200, json!({ "id": 500, "html_url": "https://github.com/o/r/pull/9#issuecomment-500" })),
    ]);
    let params = json!({ "body": "new", "marker": "mine", "number": "#9" });
    let out = run_action(&http, "github.upsertPRComment", Some(&gh_config()), &params, &comment_ctx(None)).await;
    assert_eq!(out.output, "Updated the comment on o/r#9 https://github.com/o/r/pull/9#issuecomment-500");
    assert_eq!(
        http.urls(),
        [
            "GET https://api.github.com/repos/o/r/issues/9/comments?per_page=100&page=1",
            "GET https://api.github.com/repos/o/r/issues/9/comments?per_page=100&page=2",
            "PATCH https://api.github.com/repos/o/r/issues/comments/500",
        ]
    );
    assert_eq!(http.request(2).body.unwrap(), r#"{"body":"new\n\n<!-- mine -->"}"#);
}

#[tokio::test]
async fn upsert_with_no_pr_skips_cleanly() {
    let http = Scripted::default();
    let out =
        run_action(&http, "github.upsertPRComment", Some(&gh_config()), &json!({ "body": "x" }), &comment_ctx(None))
            .await;
    assert_eq!(out.output, "No PR, skipped.");
    assert!(!out.is_error);
    assert!(http.urls().is_empty());

    let http = Scripted::new(vec![(403, json!({ "message": "Forbidden" }))]);
    let out =
        run_action(&http, "github.upsertPRComment", Some(&gh_config()), &json!({ "body": "x" }), &comment_ctx(Some(9)))
            .await;
    assert!(out.is_error);
    assert!(out.output.starts_with("GitHub comments on o/r#9 failed: 403"), "{}", out.output);
}
