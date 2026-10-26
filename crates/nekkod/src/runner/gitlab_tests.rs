use super::*;
use crate::runner::store::Link;
use crate::runner::test_http::Scripted;
use nekko_cloud::vault::FileVault;
use nekko_runner::{RunnerConfig, RunnerSettings};
use serde_json::json;

const UNAUTHORIZED: &str =
    "GitLab refused this access token. It may have expired or been revoked; connect again with a new token.";
const FORBIDDEN: &str = "GitLab would not create a runner here. The token needs the create_runner and manage_runner scopes and you need the Owner role.";

const NO_MANAGE_TEXT: &str = "manage_runner";

thread_local! {
    /// Each `#[tokio::test]` runs on its own thread, so each test has its own clock.
    static CLOCK: std::cell::Cell<u64> = const { std::cell::Cell::new(1_800_000_000) };
}

fn now() -> u64 {
    CLOCK.with(|c| c.get())
}

fn advance(secs: u64) {
    CLOCK.with(|c| c.set(c.get() + secs));
}

struct T {
    http: Scripted,
    gl: GitLab<Scripted>,
    _dir: tempfile::TempDir,
}

fn rig_with(replies: Vec<(u16, Value)>, with_token: bool) -> T {
    let dir = tempfile::tempdir().unwrap();
    let secrets = dir.path().join("runners/secrets.json");
    if with_token {
        FileVault::new(secrets.clone()).set(&token_key("r1"), "glpat-x").unwrap();
    }
    let http = Scripted::new(replies);
    let gl = GitLab::new(http.clone(), Box::new(FileVault::new(secrets)), now);
    T { http, gl, _dir: dir }
}

fn rig(replies: Vec<(u16, Value)>) -> T {
    rig_with(replies, true)
}

fn rec(scope: Scope, link: GitlabLink) -> RunnerRecord {
    RunnerRecord {
        config: RunnerConfig { id: "r1".into(), scope, label: "nekko-mac".into(), settings: RunnerSettings::default() },
        link: Link::Gitlab(link),
        image: None,
    }
}

fn link() -> GitlabLink {
    GitlabLink {
        base_url: "https://gitlab.com".into(),
        namespace_id: 42,
        projects: vec![],
        allow_public: false,
        protected_only: true,
    }
}

fn project_rec() -> RunnerRecord {
    rec(Scope::Repo { owner: "a/b".into(), repo: "c".into() }, link())
}

fn unprotected_rec() -> RunnerRecord {
    rec(Scope::Repo { owner: "a/b".into(), repo: "c".into() }, GitlabLink { protected_only: false, ..link() })
}

fn group_rec(projects: &[&str]) -> RunnerRecord {
    rec(
        Scope::Org { org: "g".into() },
        GitlabLink { namespace_id: 9, projects: projects.iter().map(|p| p.to_string()).collect(), ..link() },
    )
}

fn created() -> (u16, Value) {
    (201, json!({"id": 77, "token": "glrt-abc", "token_expires_at": null}))
}

fn job_tags(tags: &[&str]) -> Value {
    json!({"id": 1, "ref": "main", "tag": false, "tag_list": tags})
}

#[tokio::test]
async fn mint_creates_a_locked_tagged_project_runner() {
    let t = rig(vec![created()]);
    let m = t.gl.mint(&project_rec(), "nekko-mac1-100-0").await.unwrap();
    let req = t.http.last();
    assert_eq!((req.method, req.url.as_str()), ("POST", "https://gitlab.com/api/v4/user/runners"));
    assert!(req.headers.contains(&("PRIVATE-TOKEN".into(), "glpat-x".into())));
    assert!(req.headers.contains(&("User-Agent".into(), "nekko-agent".into())));
    assert!(req.headers.contains(&("Content-Type".into(), "application/json".into())));
    let b: Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
    assert_eq!(
        b,
        json!({"runner_type":"project_type","project_id":42,"description":"nekko-mac1-100-0","paused":false,
        "locked":true,"run_untagged":false,"tag_list":"nekko-mac,macos,arm64","access_level":"ref_protected","maximum_timeout":7200})
    );
    assert_eq!((m.runner_id, m.seed_file), (77, "gitlab-runner.toml"));
    assert!(m.jit_config.contains("token = \"glrt-abc\"") && m.jit_config.contains("url = \"https://gitlab.com\""));
}

#[tokio::test]
async fn group_scope_creates_a_group_runner() {
    let t = rig(vec![created()]);
    t.gl.mint(&group_rec(&["g/a"]), "n").await.unwrap();
    let b = t.http.body(0);
    assert_eq!((b["runner_type"].as_str(), b["group_id"].as_u64()), (Some("group_type"), Some(9)));
    assert!(b.get("project_id").is_none());
}

#[tokio::test]
async fn protected_only_off_sends_not_protected() {
    let t = rig(vec![created()]);
    t.gl.mint(&unprotected_rec(), "n").await.unwrap();
    assert_eq!(t.http.body(0)["access_level"], "not_protected");
}

#[tokio::test]
async fn self_managed_base_is_used() {
    let t = rig(vec![created()]);
    let r = rec(
        Scope::Repo { owner: "a/b".into(), repo: "c".into() },
        GitlabLink { base_url: "https://gitlab.example.com".into(), ..link() },
    );
    let m = t.gl.mint(&r, "n").await.unwrap();
    assert!(t.http.last().url.starts_with("https://gitlab.example.com/api/v4/"));
    assert!(m.jit_config.contains("url = \"https://gitlab.example.com\"\n"));
}

#[test]
fn runner_toml_escapes_strings() {
    assert!(runner_toml("https://g", "glrt-a\"b\\c").contains(r#"token = "glrt-a\"b\\c""#));
}

#[test]
fn runner_toml_is_exact() {
    assert_eq!(
        runner_toml("https://g", "glrt-t"),
        "concurrent = 1\n\n[[runners]]\n  name = \"nekko\"\n  url = \"https://g\"\n  token = \"glrt-t\"\n  executor = \"shell\"\n  shell = \"bash\"\n  builds_dir = \"/Users/runner/builds\"\n  cache_dir = \"/Users/runner/cache\"\n"
    );
}

#[tokio::test]
async fn non_glrt_token_is_refused_and_deleted() {
    let t = rig(vec![(201, json!({"id": 77, "token": "abc"})), (204, Value::Null)]);
    let e = t.gl.mint(&project_rec(), "n").await.unwrap_err();
    assert!(matches!(e, ProviderError::Other(_)));
    assert!(!e.to_string().contains("abc"));
    assert_eq!(t.http.urls()[1], "DELETE https://gitlab.com/api/v4/runners/77");
}

#[tokio::test]
async fn missing_token_is_auth_error() {
    let t = rig_with(vec![], false);
    let e = t.gl.mint(&project_rec(), "n").await.unwrap_err();
    assert_eq!(e, ProviderError::Auth("The GitLab access token is missing; connect again.".into()));
    assert!(t.http.urls().is_empty());
}

#[tokio::test]
async fn expired_token_is_auth_error() {
    let t = rig(vec![(401, json!({"message": "401 Unauthorized"}))]);
    assert_eq!(t.gl.mint(&project_rec(), "n").await.unwrap_err(), ProviderError::Auth(UNAUTHORIZED.into()));
}

#[tokio::test]
async fn forbidden_create_names_scopes_and_owner() {
    let t = rig(vec![(403, json!({"message": "403 Forbidden"}))]);
    assert_eq!(t.gl.mint(&project_rec(), "n").await.unwrap_err(), ProviderError::Auth(FORBIDDEN.into()));
}

#[tokio::test]
async fn status_maps_states() {
    let t = rig(vec![
        (200, json!({"status": "never_contacted"})),
        (200, json!({"status": "offline"})),
        (404, json!({"message": "404 Not found"})),
        (200, json!({"status": "online", "paused": false})),
        (200, json!([])),
        (200, json!({"status": "paused", "paused": true})),
        (200, json!([{"id": 501}])),
    ]);
    let r = project_rec();
    for want in
        [RunnerStatus::Offline, RunnerStatus::Offline, RunnerStatus::Missing, RunnerStatus::Idle, RunnerStatus::Busy]
    {
        assert_eq!(t.gl.status(&r, 77).await.unwrap(), want);
    }
    assert_eq!(t.http.urls()[0], "GET https://gitlab.com/api/v4/runners/77");
    assert_eq!(t.http.urls()[4], "GET https://gitlab.com/api/v4/runners/77/jobs?status=running&per_page=1");
}

#[tokio::test]
async fn busy_runner_is_paused_once() {
    let t = rig(vec![
        (200, json!({"status": "online", "paused": false})),
        (200, json!([{"id": 501}])),
        (200, json!({"id": 77, "paused": true})),
        (200, json!({"status": "paused", "paused": true})),
        (200, json!([{"id": 501}])),
        (200, json!({"status": "online"})),
        (200, json!([{"id": 501}])),
        (200, json!({"id": 77, "paused": true})),
    ]);
    let r = project_rec();
    assert_eq!(t.gl.status(&r, 77).await.unwrap(), RunnerStatus::Busy);
    assert_eq!(t.http.urls()[2], "PUT https://gitlab.com/api/v4/runners/77");
    assert_eq!(t.http.body(2), json!({"paused": true}));
    assert_eq!(t.gl.status(&r, 77).await.unwrap(), RunnerStatus::Busy);
    assert_eq!(t.http.urls().len(), 5, "a paused runner is not paused again");
    assert_eq!(t.gl.status(&r, 77).await.unwrap(), RunnerStatus::Busy);
    assert_eq!(t.http.urls()[7], "PUT https://gitlab.com/api/v4/runners/77", "no paused field: pause anyway");
}

#[tokio::test]
async fn a_failed_pause_is_an_error() {
    let t = rig(vec![
        (200, json!({"status": "online", "paused": false})),
        (200, json!([{"id": 501}])),
        (403, json!({"message": "403 Forbidden"})),
    ]);
    let e = t.gl.status(&project_rec(), 77).await.unwrap_err();
    assert!(matches!(&e, ProviderError::Auth(m) if m.contains(NO_MANAGE_TEXT)), "{e:?}");
}

#[tokio::test]
async fn forbidden_delete_and_list_name_manage_runner() {
    let t = rig(vec![(403, json!({})), (403, json!({}))]);
    for e in [
        t.gl.remove(&project_rec(), 77).await.unwrap_err(),
        t.gl.remove_stale(&project_rec(), "nekko-mac1-").await.unwrap_err(),
    ] {
        assert!(matches!(&e, ProviderError::Auth(m) if m.contains(NO_MANAGE_TEXT)), "{e:?}");
    }
}

#[tokio::test]
async fn job_without_an_id_is_none() {
    let t = rig(vec![(200, json!([{"name": "build", "ref": "main", "pipeline": {"id": 900}}]))]);
    assert_eq!(t.gl.job(&project_rec(), 77, "n").await.unwrap(), None);
}

#[tokio::test]
async fn job_maps_the_running_job() {
    let t = rig(vec![(
        200,
        json!([{"id":501,"name":"build","ref":"main","pipeline":{"id":900},"project":{"path_with_namespace":"a/b/c"}}]),
    )]);
    let j = t.gl.job(&project_rec(), 77, "n").await.unwrap();
    assert_eq!(
        j,
        Some(JobRef { repo: "a/b/c".into(), run_id: 900, job_id: 501, workflow: "main".into(), job: "build".into() })
    );
    assert_eq!(t.http.urls()[0], "GET https://gitlab.com/api/v4/runners/77/jobs?status=running&per_page=1");
}

#[tokio::test]
async fn job_is_none_without_a_running_job() {
    let t = rig(vec![(200, json!([]))]);
    assert_eq!(t.gl.job(&project_rec(), 77, "n").await.unwrap(), None);
}

#[tokio::test]
async fn queued_counts_jobs_our_tags_cover() {
    let jobs = json!([
        job_tags(&["nekko-mac"]),
        job_tags(&["macos", "nekko-mac"]),
        job_tags(&[]),
        job_tags(&["docker"]),
        job_tags(&["nekko-mac", "gpu"]),
    ]);
    let t = rig(vec![(200, jobs)]);
    assert_eq!(t.gl.queued(&unprotected_rec()).await.unwrap(), 2);
    assert_eq!(
        t.http.urls(),
        vec!["GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc/jobs?scope[]=pending&per_page=100"]
    );
}

#[tokio::test]
async fn queued_skips_unprotected_refs_when_protected_only() {
    let jobs = json!([
        {"id": 1, "ref": "main", "tag": false, "tag_list": ["nekko-mac"]},
        {"id": 2, "ref": "feature", "tag": false, "tag_list": ["nekko-mac"]},
        {"id": 3, "ref": "refs/merge-requests/3/head", "tag": false, "tag_list": ["nekko-mac"]},
        {"id": 4, "ref": "v1.0", "tag": true, "tag_list": ["nekko-mac"]},
        {"id": 5, "ref": "v2/rc", "tag": true, "tag_list": ["nekko-mac"]},
        {"id": 6, "ref": "gone", "tag": true, "tag_list": ["nekko-mac"]},
    ]);
    let t = rig(vec![
        (200, jobs.clone()),
        (200, json!({"name": "main", "protected": true})),
        (200, json!({"name": "feature", "protected": false})),
        (200, json!({"name": "v1.0", "protected": true})),
        (200, json!({"name": "v2/rc", "protected": false})),
        (404, json!({"message": "404 Tag Not Found"})),
        (200, jobs),
    ]);
    let r = project_rec();
    assert_eq!(t.gl.queued(&r).await.unwrap(), 2, "main and the protected tag");
    let urls = t.http.urls();
    assert_eq!(urls[1], "GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc/repository/branches/main");
    assert_eq!(urls[2], "GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc/repository/branches/feature");
    assert_eq!(urls[3], "GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc/repository/tags/v1.0");
    assert_eq!(urls[4], "GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc/repository/tags/v2%2Frc");
    assert_eq!(urls.len(), 6);
    assert_eq!(t.gl.queued(&r).await.unwrap(), 2);
    assert_eq!(t.http.urls().len(), 7, "the ref answers are cached");
}

#[tokio::test]
async fn protected_answers_expire_after_ten_minutes() {
    let jobs = json!([{"id": 1, "ref": "main", "tag": false, "tag_list": ["nekko-mac"]}]);
    let dev = json!([{"id": 2, "ref": "dev", "tag": false, "tag_list": ["nekko-mac"]}]);
    let t = rig(vec![
        (200, jobs.clone()),
        (200, json!({"protected": true})),
        (200, jobs.clone()),
        (200, jobs),
        (200, json!({"protected": false})),
        (200, dev),
        (200, json!({"protected": true})),
    ]);
    let r = project_rec();
    assert_eq!(t.gl.queued(&r).await.unwrap(), 1);
    advance(599);
    assert_eq!(t.gl.queued(&r).await.unwrap(), 1);
    assert_eq!(t.http.urls().len(), 3, "still cached at 599 s");
    advance(1);
    assert_eq!(t.gl.queued(&r).await.unwrap(), 0, "asked again at 600 s");
    assert!(t.http.urls()[4].ends_with("/repository/branches/main"));
    advance(600);
    assert_eq!(t.gl.queued(&r).await.unwrap(), 1);
    assert_eq!(t.gl.refs_cached(), 1, "the expired main entry was dropped");
}

#[tokio::test]
async fn group_queue_polls_each_listed_project() {
    let t =
        rig(vec![(200, json!([job_tags(&["nekko-mac"])])), (200, json!([job_tags(&["arm64"]), job_tags(&["macos"])]))]);
    let mut r = group_rec(&["g/a", "g/b"]);
    if let Link::Gitlab(l) = &mut r.link {
        l.protected_only = false;
    }
    assert_eq!(t.gl.queued(&r).await.unwrap(), 3);
    assert_eq!(
        t.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/projects/g%2Fa/jobs?scope[]=pending&per_page=100",
            "GET https://gitlab.com/api/v4/projects/g%2Fb/jobs?scope[]=pending&per_page=100",
        ]
    );
}

#[tokio::test]
async fn group_queue_skips_a_project_it_cannot_read() {
    let t = rig(vec![
        (404, json!({"message": "404 Project Not Found"})),
        (403, json!({"message": "403 Forbidden"})),
        (200, json!([job_tags(&["nekko-mac"])])),
    ]);
    let mut r = group_rec(&["g/gone", "g/hidden", "g/b"]);
    if let Link::Gitlab(l) = &mut r.link {
        l.protected_only = false;
    }
    assert_eq!(t.gl.queued(&r).await.unwrap(), 1);
}

#[tokio::test]
async fn group_queue_fails_when_no_project_can_be_read() {
    let t = rig(vec![(404, json!({})), (403, json!({}))]);
    let mut r = group_rec(&["g/gone", "g/hidden"]);
    if let Link::Gitlab(l) = &mut r.link {
        l.protected_only = false;
    }
    assert_eq!(t.gl.queued(&r).await.unwrap_err(), ProviderError::Other("GitLab answered 403".into()));
}

#[tokio::test]
async fn remove_tolerates_404() {
    let t = rig(vec![(404, json!({"message": "404 Not found"})), (204, Value::Null)]);
    t.gl.remove(&project_rec(), 77).await.unwrap();
    t.gl.remove(&project_rec(), 77).await.unwrap();
    assert_eq!(t.http.urls()[0], "DELETE https://gitlab.com/api/v4/runners/77");
}

#[tokio::test]
async fn stale_removes_every_runner_with_our_prefix() {
    let t = rig(vec![
        (
            200,
            json!([{"id":1,"description":"nekko-mac1-1-0","status":"online"},{"id":2,"description":"nekko-mac1-2-0","status":"offline"},
                {"id":3,"description":"other","status":"offline"},{"id":4,"description":"nekko-mac1-long-1-0","status":"offline"}]),
        ),
        (204, Value::Null),
        (204, Value::Null),
    ]);
    assert_eq!(t.gl.remove_stale(&project_rec(), "nekko-mac1-").await.unwrap(), 2);
    assert_eq!(
        t.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/projects/42/runners?type=project_type&per_page=100&page=1",
            "DELETE https://gitlab.com/api/v4/runners/1",
            "DELETE https://gitlab.com/api/v4/runners/2",
        ]
    );
}

#[tokio::test]
async fn stale_pages_a_group() {
    let full: Vec<Value> = (100..200).map(|i| json!({"id": i, "description": "x", "status": "offline"})).collect();
    let t = rig(vec![(200, Value::Array(full)), (200, json!([]))]);
    assert_eq!(t.gl.remove_stale(&group_rec(&[]), "nekko-mac1-").await.unwrap(), 0);
    assert_eq!(
        t.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/groups/9/runners?type=group_type&per_page=100&page=1",
            "GET https://gitlab.com/api/v4/groups/9/runners?type=group_type&per_page=100&page=2",
        ]
    );
}

#[tokio::test]
async fn group_stale_sweep_spares_an_ancestor_groups_runner() {
    let t = rig(vec![
        (
            200,
            json!([{"id":1,"description":"nekko-mac1-1-0","status":"offline"},{"id":2,"description":"nekko-mac1-2-0","status":"online"},
                {"id":3,"description":"nekko-mac1-3-0","status":"offline"}]),
        ),
        (200, json!({"id": 1, "groups": [{"id": 9}]})),
        (204, Value::Null),
        (200, json!({"id": 2, "groups": [{"id": 5}]})),
        (500, json!({})),
    ]);
    assert_eq!(t.gl.remove_stale(&group_rec(&[]), "nekko-mac1-").await.unwrap(), 1);
    assert_eq!(
        t.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/groups/9/runners?type=group_type&per_page=100&page=1",
            "GET https://gitlab.com/api/v4/runners/1",
            "DELETE https://gitlab.com/api/v4/runners/1",
            "GET https://gitlab.com/api/v4/runners/2",
            "GET https://gitlab.com/api/v4/runners/3",
        ]
    );
}

#[tokio::test]
async fn rerun_retries_the_job() {
    let t = rig(vec![(201, json!({"id": 502}))]);
    let job = JobRef { repo: "a/b/c".into(), run_id: 900, job_id: 501, workflow: "main".into(), job: "build".into() };
    t.gl.rerun(&project_rec(), &job).await.unwrap();
    assert_eq!(t.http.urls(), vec!["POST https://gitlab.com/api/v4/projects/a%2Fb%2Fc/jobs/501/retry"]);
}

#[tokio::test]
async fn rate_limited_is_other() {
    let t = rig(vec![(429, json!({"message": "Retry later"}))]);
    assert_eq!(t.gl.status(&project_rec(), 77).await.unwrap_err(), ProviderError::Other("GitLab answered 429".into()));
}
