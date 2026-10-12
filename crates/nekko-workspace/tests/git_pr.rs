//! git.rs and pr.rs against the TS functions: `golden/git-pr.json` is written
//! by packages/host/src/git-pr.golden.test.ts from `golden/git-pr-cases.json`.

use nekko_workspace::{git, pr};
use serde_json::{Map, Value, json};
use std::path::Path;

fn golden(name: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name)).unwrap()
}

#[test]
fn the_pure_halves_match_the_ts_host() {
    let c: Value = serde_json::from_str(&golden("git-pr-cases.json")).unwrap();
    let list = |k: &str| c[k].as_array().unwrap().clone();
    let stamp = |mut v: Value| {
        v["updatedAt"] = json!(0);
        v
    };
    let parsed = |url: &str| pr::parse_pr_url(url).unwrap();
    let mut out = Map::new();
    out.insert(
        "porcelain".into(),
        list("porcelain").iter().map(|s| stamp(git::parse_porcelain_v2("w", s.as_str().unwrap()))).collect(),
    );
    out.insert(
        "worktree".into(),
        list("worktree")
            .iter()
            .map(|p| git::parse_worktree(p[0].as_str().unwrap(), p[1].as_str().unwrap()).unwrap_or(Value::Null))
            .collect(),
    );
    out.insert("rollup".into(), list("rollup").iter().map(|r| json!(pr::rollup_checks(Some(r)))).collect());
    out.insert(
        "ghInfo".into(),
        list("ghInfo")
            .iter()
            .map(|a| {
                let url = a[0].as_str().unwrap();
                let (o, r, n) = parsed(url);
                pr::pr_info_from_gh(url, &o, &r, n, &a[1], a[2] == json!(true))
            })
            .collect(),
    );
    out.insert(
        "apiInfo".into(),
        list("apiInfo")
            .iter()
            .map(|a| {
                let url = a[0].as_str().unwrap();
                let (o, r, n) = parsed(url);
                pr::pr_info_from_api(url, &o, &r, n, &a[1], a[2].as_str().unwrap())
            })
            .collect(),
    );
    out.insert("checks".into(), list("checks").iter().map(|cj| json!(pr::checks_from_status(cj))).collect());
    out.insert(
        "diffs".into(),
        list("diffs").iter().map(|d| Value::Array(pr::parse_unified_diff(d.as_str().unwrap()))).collect(),
    );
    out.insert("apiFiles".into(), list("apiFiles").iter().map(pr::diff_file_from_api).collect());
    out.insert(
        "prUrls".into(),
        list("prUrls")
            .iter()
            .map(|u| match pr::parse_pr_url(u.as_str().unwrap()) {
                Some((owner, repo, number)) => json!({ "owner": owner, "repo": repo, "number": number }),
                None => Value::Null,
            })
            .collect(),
    );
    out.insert(
        "sessions".into(),
        list("sessions").iter().map(|m| json!(pr::collect_session_pr_urls(m.as_array().unwrap()))).collect(),
    );
    out.insert(
        "cooldown".into(),
        list("cooldown").iter().map(|s| json!(pr::read_cooldown_ms(s.as_str().unwrap()))).collect(),
    );
    let text = format!("{}\n", nekko_js::stringify_pretty(&Value::Object(out), "  "));
    let want = golden("git-pr.json").replace("\r\n", "\n");
    if text != want {
        for (i, (w, g)) in want.lines().zip(text.lines()).enumerate() {
            assert_eq!(g, w, "git-pr.json differs at line {}", i + 1);
        }
        assert_eq!(text.lines().count(), want.lines().count());
    }
}
