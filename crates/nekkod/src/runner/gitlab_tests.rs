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
    let gl = GitLab::new(http.clone(), Arc::new(FileVault::new(secrets)), now);
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
        (200, json!({"id": 2, "groups": [{"id": 5}]})),
        (500, json!({})),
        (204, Value::Null),
    ]);
    assert_eq!(t.gl.remove_stale(&group_rec(&[]), "nekko-mac1-").await.unwrap(), 1);
    assert_eq!(
        t.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/groups/9/runners?type=group_type&per_page=100&page=1",
            "GET https://gitlab.com/api/v4/runners/1",
            "GET https://gitlab.com/api/v4/runners/2",
            "GET https://gitlab.com/api/v4/runners/3",
            "DELETE https://gitlab.com/api/v4/runners/1",
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

// Connect.

const NOT_PUBLIC: &str = "This GitLab instance is not on the public internet, so a job VM could not reach it.";
const PREFIX: &str = "nekko-mac1-0a1b2c3d-";

struct C {
    http: Scripted,
    gl: GitLab<Scripted>,
    vault: FileVault,
    secrets: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn connect_rig(replies: Vec<(u16, Value)>) -> C {
    let dir = tempfile::tempdir().unwrap();
    let secrets = dir.path().join("runners/secrets.json");
    let http = Scripted::new(replies);
    let gl = GitLab::new(http.clone(), Arc::new(FileVault::new(secrets.clone())), now);
    C { http, gl, vault: FileVault::new(secrets.clone()), secrets, _dir: dir }
}

impl C {
    async fn connect(&self, req: GitlabConnectRequest) -> Result<RunnerRecord, String> {
        self.connect_with(req, None, public_ip).await
    }

    async fn connect_with(
        &self,
        req: GitlabConnectRequest,
        existing: Option<&RunnerRecord>,
        resolve: impl AsyncFn(&str) -> std::io::Result<Vec<std::net::IpAddr>>,
    ) -> Result<RunnerRecord, String> {
        let network = Some("gw:0a:1b:2c:3d:4e:05".to_string());
        self.gl.connect(req, existing, PREFIX, network, &nekko_runner::HostNets::default(), resolve).await
    }

    /// Nothing at all was stored.
    fn stored_nothing(&self) -> bool {
        !self.secrets.exists() || std::fs::read_to_string(&self.secrets).unwrap().trim() == "{}"
    }

    fn posted(&self) -> bool {
        self.http.urls().iter().any(|u| u.starts_with("POST"))
    }
}

async fn public_ip(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
    Ok(vec!["93.184.216.34".parse().unwrap()])
}

fn req_from(v: Value) -> GitlabConnectRequest {
    let mut v = v;
    v["provider"] = json!("gitlab");
    serde_json::from_value(v).unwrap()
}

fn req_project(owner: &str, repo: &str, token: &str) -> GitlabConnectRequest {
    req_from(json!({"scope": {"kind": "repo", "owner": owner, "repo": repo}, "accessToken": token}))
}

fn req_group(org: &str, projects: &[&str]) -> GitlabConnectRequest {
    req_from(json!({"scope": {"kind": "org", "org": org}, "projects": projects, "accessToken": "glpat-x"}))
}

fn found(id: u64, visibility: &str) -> (u16, Value) {
    (200, json!({"id": id, "visibility": visibility}))
}

fn scopes(s: &[&str]) -> (u16, Value) {
    (200, json!({"scopes": s, "active": true}))
}

fn probe() -> Vec<(u16, Value)> {
    vec![(201, json!({"id": 5, "token": "glrt-z"})), (204, Value::Null)]
}

#[tokio::test]
async fn connect_project_end_to_end() {
    let c = connect_rig(
        [vec![found(42, "private"), scopes(&["create_runner", "manage_runner", "read_api"])], probe()].concat(),
    );
    let r = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap();
    assert!(r.config.id.starts_with("gl-") && r.config.id.len() == 15, "{}", r.config.id);
    assert_eq!(
        r.gitlab().unwrap(),
        &GitlabLink {
            base_url: "https://gitlab.com".into(),
            namespace_id: 42,
            projects: vec![],
            allow_public: false,
            protected_only: true
        }
    );
    assert_eq!(r.config.settings.trusted_networks, vec!["gw:0a:1b:2c:3d:4e:05".to_string()]);
    assert!(r.config.settings.enabled);
    assert_eq!(r.config.label, "nekko-mac");
    assert_eq!(c.vault.get(&token_key(&r.config.id)).as_deref(), Some("glpat-x"));
    assert_eq!(
        c.http.urls(),
        vec![
            "GET https://gitlab.com/api/v4/projects/a%2Fb%2Fc",
            "GET https://gitlab.com/api/v4/personal_access_tokens/self",
            "POST https://gitlab.com/api/v4/user/runners",
            "DELETE https://gitlab.com/api/v4/runners/5",
        ]
    );
    let b = c.http.body(2);
    assert_eq!(
        (b["paused"].as_bool(), b["runner_type"].as_str(), b["project_id"].as_u64()),
        (Some(true), Some("project_type"), Some(42))
    );
    // Named like a VM's runner, so the stale sweep removes it if the DELETE never lands.
    assert!(is_ours(b["description"].as_str().unwrap(), PREFIX), "{b}");
    assert!(c.http.last().headers.contains(&("PRIVATE-TOKEN".into(), "glpat-x".into())));
}

#[tokio::test]
async fn bad_token_is_refused_and_not_stored() {
    let c = connect_rig(vec![(401, json!({"message": "401 Unauthorized"}))]);
    assert_eq!(c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err(), UNAUTHORIZED);
    assert!(c.stored_nothing() && !c.posted());
    assert_eq!(c.http.urls().len(), 1);
}

#[tokio::test]
async fn not_owner_is_refused_and_not_stored() {
    let c = connect_rig(vec![found(42, "private"), (404, json!({})), (403, json!({"message": "403 Forbidden"}))]);
    assert_eq!(c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err(), FORBIDDEN);
    assert!(c.stored_nothing());
}

#[tokio::test]
async fn a_create_only_token_is_refused() {
    // The token says what it may do.
    let c = connect_rig(vec![found(42, "private"), scopes(&["create_runner", "read_api"])]);
    let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
    assert!(e.contains(NO_MANAGE_TEXT), "{e}");
    assert!(c.stored_nothing() && !c.posted());
    // It does not (a project or group token on an older GitLab): the probe's DELETE finds out.
    let c = connect_rig(vec![found(42, "private"), (404, json!({})), probe()[0].clone(), (403, json!({}))]);
    let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
    assert!(e.contains(NO_MANAGE_TEXT), "{e}");
    assert!(e.contains("paused check runner"), "says what is left behind: {e}");
    assert!(c.stored_nothing());
    // `api` covers both.
    let c = connect_rig([vec![found(42, "private"), scopes(&["api"])], probe()].concat());
    c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap();
    // A token GitLab says is inactive.
    let c = connect_rig(vec![found(42, "private"), (200, json!({"scopes": ["api"], "active": false}))]);
    assert_eq!(c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err(), UNAUTHORIZED);
}

#[tokio::test]
async fn public_project_needs_explicit_allow() {
    let c = connect_rig(vec![found(42, "public")]);
    let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
    assert_eq!(e, "This project or group is public. Tick Allow public projects to run its jobs here.");
    assert!(c.stored_nothing() && !c.posted());
    let c = connect_rig([vec![found(42, "public"), scopes(&["api"])], probe()].concat());
    let mut req = req_project("a/b", "c", "glpat-x");
    req.allow_public = true;
    let r = c.connect(req).await.unwrap();
    assert!(r.gitlab().unwrap().allow_public);
}

#[tokio::test]
async fn lan_instance_is_refused() {
    async fn lan(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec!["93.184.216.34".parse().unwrap(), "192.168.1.20".parse().unwrap()])
    }
    async fn tailscale(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec!["100.101.102.103".parse().unwrap()])
    }
    async fn loopback(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec!["::1".parse().unwrap()])
    }
    async fn nothing(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec![])
    }
    async fn unknown(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Err(std::io::Error::other("no such host"))
    }
    let req = || {
        req_from(
            json!({"scope": {"kind": "repo", "owner": "a", "repo": "b"}, "baseUrl": "https://gitlab.lan", "accessToken": "glpat-x"}),
        )
    };
    let c = connect_rig(vec![]);
    assert_eq!(c.connect_with(req(), None, lan).await.unwrap_err(), NOT_PUBLIC);
    assert_eq!(c.connect_with(req(), None, tailscale).await.unwrap_err(), NOT_PUBLIC);
    assert_eq!(c.connect_with(req(), None, loopback).await.unwrap_err(), NOT_PUBLIC);
    assert_eq!(c.connect_with(req(), None, nothing).await.unwrap_err(), NOT_PUBLIC);
    assert_eq!(c.connect_with(req(), None, unknown).await.unwrap_err(), NOT_PUBLIC);
    // A global address that is this Mac's own network (a LAN with global IPv6).
    let nets = nekko_runner::HostNets::new(vec![], vec![("2a00:1450::".parse().unwrap(), 32)]);
    async fn lan6(_: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec!["2a00:1450::20".parse().unwrap()])
    }
    let e = c.gl.connect(req(), None, PREFIX, None, &nets, lan6).await.unwrap_err();
    assert_eq!(e, NOT_PUBLIC);
    assert!(c.http.urls().is_empty() && c.stored_nothing());
}

#[tokio::test]
async fn http_instance_is_refused() {
    let c = connect_rig(vec![]);
    let req = req_from(
        json!({"scope": {"kind": "repo", "owner": "a", "repo": "b"}, "baseUrl": "http://gitlab.example.com", "accessToken": "glpat-x"}),
    );
    assert_eq!(c.connect(req).await.unwrap_err(), "The GitLab instance URL must be https.");
    assert!(c.http.urls().is_empty());
}

#[tokio::test]
async fn bad_fields_are_refused_before_any_request() {
    let c = connect_rig(vec![]);
    let bad = |v: Value| {
        let mut m = json!({"provider": "gitlab", "scope": {"kind": "repo", "owner": "a", "repo": "b"}, "accessToken": "glpat-x"});
        for (k, x) in v.as_object().unwrap() {
            m[k] = x.clone();
        }
        serde_json::from_value::<GitlabConnectRequest>(m).unwrap()
    };
    for (v, want) in [
        (json!({"accessToken": null}), "Paste a GitLab access token."),
        (json!({"accessToken": "x".repeat(1025)}), "That is not a GitLab access token."),
        (json!({"accessToken": "glpat-x\nX-Evil: 1"}), "That is not a GitLab access token."),
        (json!({"label": "bad label"}), "The label may use letters, digits, '.', '_' and '-' only (at most 64)."),
        (json!({"scope": {"kind": "repo", "owner": "a/../b", "repo": "c"}}), "That is not a GitLab project path."),
        (json!({"provider": "github"}), "Unknown CI provider."),
    ] {
        assert_eq!(c.connect(bad(v)).await.unwrap_err(), want);
    }
    assert!(c.http.urls().is_empty());
}

#[tokio::test]
async fn group_needs_listed_projects_inside_it() {
    let c = connect_rig(vec![]);
    assert_eq!(c.connect(req_group("g", &[])).await.unwrap_err(), "Choose 1 to 20 projects in the group.");
    assert_eq!(c.connect(req_group("g", &["other/x"])).await.unwrap_err(), "other/x is not in g.");
    let many: Vec<String> = (0..21).map(|i| format!("g/p{i}")).collect();
    let many: Vec<&str> = many.iter().map(String::as_str).collect();
    assert_eq!(c.connect(req_group("g", &many)).await.unwrap_err(), "Choose 1 to 20 projects in the group.");
    assert!(c.http.urls().is_empty());

    let c = connect_rig(vec![found(9, "private"), (404, json!({}))]);
    assert_eq!(c.connect(req_group("g", &["g/a"])).await.unwrap_err(), "GitLab cannot find g/a with this token.");
    let c = connect_rig(vec![found(9, "private"), found(11, "public")]);
    assert!(c.connect(req_group("g", &["g/a"])).await.unwrap_err().contains("public"));

    let c = connect_rig([vec![found(9, "private"), found(11, "private"), scopes(&["api"])], probe()].concat());
    let r = c.connect(req_group("g", &["G/sub/a"])).await.unwrap();
    assert_eq!(
        c.http.urls()[..2],
        ["GET https://gitlab.com/api/v4/groups/g", "GET https://gitlab.com/api/v4/projects/g%2Fsub%2Fa"]
    );
    let b = c.http.body(3);
    assert_eq!((b["runner_type"].as_str(), b["group_id"].as_u64()), (Some("group_type"), Some(9)));
    let l = r.gitlab().unwrap();
    assert_eq!((l.namespace_id, l.projects.clone()), (9, vec!["g/sub/a".to_string()]));
}

#[tokio::test]
async fn group_not_found_is_a_plain_sentence() {
    let c = connect_rig(vec![(404, json!({"message": "404 Group Not Found"}))]);
    assert_eq!(
        c.connect(req_group("g", &["g/a"])).await.unwrap_err(),
        "GitLab cannot find that project or group with this token."
    );
}

#[tokio::test]
async fn reconnect_keeps_settings_and_id() {
    let c = connect_rig([vec![found(43, "private"), scopes(&["api"])], probe()].concat());
    let mut old =
        rec(Scope::Repo { owner: "a/b".into(), repo: "c".into() }, GitlabLink { protected_only: false, ..link() });
    old.config.id = "gl-0123456789ab".into();
    old.config.label = "studio".into();
    old.config.settings.max_job_minutes = 30;
    c.vault.set(&token_key("gl-0123456789ab"), "glpat-old").unwrap();
    let r = c.connect_with(req_project("a/b", "c", ""), Some(&old), public_ip).await;
    assert_eq!(r.unwrap_err(), "Paste a GitLab access token.", "an empty token is not the stored one");
    let mut req = req_project("a/b", "c", "x");
    req.access_token = None;
    let r = c.connect_with(req, Some(&old), public_ip).await.unwrap();
    assert_eq!(r.config.id, "gl-0123456789ab");
    assert_eq!((r.config.settings.max_job_minutes, r.config.label.as_str()), (30, "studio"));
    let l = r.gitlab().unwrap();
    assert_eq!((l.namespace_id, l.protected_only), (43, false));
    assert!(c.http.0.seen.lock().unwrap()[0].headers.contains(&("PRIVATE-TOKEN".into(), "glpat-old".into())));
    assert_eq!(c.vault.get(&token_key("gl-0123456789ab")).as_deref(), Some("glpat-old"));
}

#[tokio::test]
async fn failed_probe_delete_still_connects() {
    let c = connect_rig(vec![found(42, "private"), scopes(&["api"]), probe()[0].clone(), (500, json!({}))]);
    let r = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap();
    assert_eq!(c.vault.get(&token_key(&r.config.id)).as_deref(), Some("glpat-x"));
}

#[test]
fn connect_request_debug_redacts_the_token() {
    let s = format!("{:?}", req_project("a/b", "c", "glpat-secret"));
    assert!(!s.contains("glpat-secret") && s.contains("redacted"), "{s}");
}

#[test]
fn connect_request_reads_every_field_the_app_sends() {
    // The field names of `GitlabConnectRequest` in packages/shared/src/runners.ts.
    let r: GitlabConnectRequest = serde_json::from_value(json!({
        "provider": "gitlab", "scope": {"kind": "org", "org": "g"}, "baseUrl": "https://gitlab.example.com",
        "accessToken": "glpat-x", "projects": ["g/a"], "allowPublic": true, "protectedOnly": false, "label": "studio"
    }))
    .unwrap();
    assert_eq!(
        (r.base_url.as_deref(), r.projects.len(), r.allow_public, r.protected_only, r.label.as_deref()),
        (Some("https://gitlab.example.com"), 1, true, Some(false), Some("studio"))
    );
}

#[tokio::test]
async fn redirects_are_refused_without_following() {
    for (to, host) in [
        ("https://evil.example/api/v4/projects/1", "evil.example"),
        ("http://gitlab.com/api/v4/projects/1", "gitlab.com"),
    ] {
        let c = connect_rig(vec![]);
        c.http.push_redirect(302, to);
        let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
        assert_eq!(e, format!("GitLab redirected the request to {host}. Use the instance's own address."));
        assert_eq!(c.http.urls().len(), 1);
        assert!(c.http.last().no_redirect, "the client must not follow it with the token");
        assert!(c.stored_nothing());
    }
    // The supervisor's calls too.
    let t = rig(vec![]);
    t.http.push_redirect(301, "https://evil.example/x");
    let e = t.gl.status(&project_rec(), 77).await.unwrap_err();
    assert_eq!(
        e,
        ProviderError::Other("GitLab redirected the request to evil.example. Use the instance's own address.".into())
    );
    assert!(t.http.last().no_redirect);
}

#[tokio::test]
async fn stale_reads_every_page_before_deleting() {
    // Deleting while paging would shift page 2 under us and skip runners.
    let page1: Vec<Value> = (1..=100).map(|i| json!({"id": i, "description": format!("nekko-mac1-{i}-0")})).collect();
    let mut replies = vec![(200, Value::Array(page1)), (200, json!([{"id": 101, "description": "nekko-mac1-101-0"}]))];
    replies.extend((1..=101).map(|_| (204, Value::Null)));
    let t = rig(replies);
    assert_eq!(t.gl.remove_stale(&project_rec(), "nekko-mac1-").await.unwrap(), 101);
    let urls = t.http.urls();
    assert_eq!(urls[1], "GET https://gitlab.com/api/v4/projects/42/runners?type=project_type&per_page=100&page=2");
    assert_eq!(urls[2], "DELETE https://gitlab.com/api/v4/runners/1");
    assert_eq!(urls.len(), 103);
}

#[tokio::test]
async fn a_forbidden_job_list_names_manage_runner() {
    let t = rig(vec![(200, json!({"status": "online", "paused": false})), (403, json!({}))]);
    let e = t.gl.status(&project_rec(), 77).await.unwrap_err();
    assert!(matches!(&e, ProviderError::Auth(m) if m.contains(NO_MANAGE_TEXT)), "{e:?}");
    let t = rig(vec![(403, json!({}))]);
    let e = t.gl.job(&project_rec(), 77, "n").await.unwrap_err();
    assert!(matches!(&e, ProviderError::Auth(m) if m.contains(NO_MANAGE_TEXT)), "{e:?}");
}

#[tokio::test]
async fn a_token_without_read_api_is_refused_by_name() {
    let c = connect_rig(vec![(403, json!({"message": "403 Forbidden"}))]);
    let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
    assert!(e.contains("read_api"), "{e}");
    let c = connect_rig(vec![found(9, "private"), (403, json!({}))]);
    assert!(c.connect(req_group("g", &["g/a"])).await.unwrap_err().contains("read_api"));
    let c = connect_rig(vec![found(42, "private"), scopes(&["create_runner", "manage_runner"])]);
    let e = c.connect(req_project("a/b", "c", "glpat-x")).await.unwrap_err();
    assert!(e.contains("read_api"), "{e}");
    assert!(c.stored_nothing() && !c.posted());
}
