//! The GitHub CI sources and actions against a real repo whose workflow fails
//! on purpose and which has an open PR. Ignored by default:
//!
//! NEKKO_LIVE_REPO=owner/name NEKKO_LIVE_TOKEN=$(gh auth token) \
//!   cargo test -p nekko-connectors --test github_live -- --ignored --nocapture

use nekko_connectors::{Net, poll, run_action};
use serde_json::json;

fn env() -> Option<(String, String)> {
    Some((std::env::var("NEKKO_LIVE_REPO").ok()?, std::env::var("NEKKO_LIVE_TOKEN").ok()?))
}

#[tokio::test]
#[ignore]
async fn live_failed_run_logs_and_comment() {
    let Some((repo, token)) = env() else { return };
    let net = Net::default();
    let config = json!({ "token": token });

    // Every failed attempt fires once, with the PR's number.
    let runs =
        poll(&net, "github", &token, &json!({ "repo": repo, "event": "workflow_run_failed" }), 0.0).await.unwrap();
    let events = runs["events"].as_array().unwrap();
    println!("failed runs: {}", serde_json::to_string_pretty(events).unwrap());
    assert!(!events.is_empty());
    let mut ids: Vec<&str> = events.iter().map(|e| e["id"].as_str().unwrap()).collect();
    ids.dedup();
    assert_eq!(ids.len(), events.len());
    let on_pr = events.iter().find(|e| e["payload"]["number"].is_number()).expect("a failed run on the PR");
    let again = poll(
        &net,
        "github",
        &token,
        &json!({ "repo": repo, "event": "workflow_run_failed" }),
        runs["nextCursor"].as_f64().unwrap(),
    )
    .await
    .unwrap();
    assert!(again["events"].as_array().unwrap().is_empty());

    // The PR poll arms without firing.
    let prs = poll(&net, "github", &token, &json!({ "repo": repo, "event": "pr_opened" }), 0.0).await.unwrap();
    println!("arm: {}", prs["pollState"]);
    assert!(prs["events"].as_array().unwrap().is_empty());
    assert!(!prs["pollState"]["prHeads"].as_object().unwrap().is_empty());

    // The failed job's log holds the error.
    let ctx =
        json!({ "event": { "repo": repo, "payload": on_pr["payload"] }, "run": { "workflowName": "Live check" } });
    let logs = run_action(&net, "github.runFailureLogs", Some(&config), &json!({}), &ctx).await;
    println!("logs:\n{}", logs.output);
    assert!(!logs.is_error);
    assert!(logs.output.contains("### build / Run tests"));
    assert!(logs.output.contains("boom: expected failure"));

    // One comment: created, then updated in place.
    let first = run_action(&net, "github.upsertPRComment", Some(&config), &json!({ "body": "first pass" }), &ctx).await;
    let second =
        run_action(&net, "github.upsertPRComment", Some(&config), &json!({ "body": "second pass" }), &ctx).await;
    println!("{}\n{}", first.output, second.output);
    assert!(!first.is_error && !second.is_error);
    let url = |o: &str| o.rsplit(' ').next().unwrap().to_string();
    assert_eq!(url(&first.output), url(&second.output));
    assert!(second.output.starts_with("Updated"));
}
