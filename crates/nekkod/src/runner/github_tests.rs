use super::*;
use crate::runner::store::same_scope;
use crate::runner::test_http::Scripted;
use nekko_cloud::vault::FileVault;
use nekko_runner::{RunnerSettings, Scope};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

struct FakeSigner;

impl Signer for FakeSigner {
    fn rs256(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        Ok(vec![1, 2, 3])
    }
}

const NOW: u64 = 1_800_000_000; // 2027-01-15T08:00:00Z
const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";
const NET: &str = "gw:0a:1b:2c:3d:4e:05";

fn fixed() -> u64 {
    NOW
}

struct T {
    http: Scripted,
    gh: GitHub<Scripted>,
    secrets: PathBuf,
    _dir: tempfile::TempDir,
}

impl T {
    fn vault(&self) -> FileVault {
        FileVault::new(self.secrets.clone())
    }
}

fn rig_at(replies: Vec<(u16, Value)>, with_key: bool, now: fn() -> u64) -> T {
    let dir = tempfile::tempdir().unwrap();
    let secrets = dir.path().join("runners/secrets.json");
    if with_key {
        FileVault::new(secrets.clone()).set(&key_name(123), PEM).unwrap();
    }
    let http = Scripted::new(replies);
    let gh = GitHub::new(
        http.clone(),
        "https://api.github.com".into(),
        Box::new(FileVault::new(secrets.clone())),
        Box::new(FakeSigner),
        now,
    );
    T { http, gh, secrets, _dir: dir }
}

fn rig(replies: Vec<(u16, Value)>, with_key: bool) -> T {
    rig_at(replies, with_key, fixed)
}

fn token() -> (u16, Value) {
    (201, json!({ "token": "ghs_inst", "expires_at": "2030-01-01T00:00:00Z" }))
}

fn repo_record() -> RunnerRecord {
    RunnerRecord {
        config: RunnerConfig {
            id: "r1".into(),
            scope: Scope::Repo { owner: "o".into(), repo: "r".into() },
            label: "nekko-cloud-mac".into(),
            settings: RunnerSettings::default(),
        },
        link: Link::Github(GithubLink {
            app_id: 123,
            installation_id: 9,
            group_id: None,
            repos: vec!["o/r".into()],
            allow_public: false,
            slug: None,
        }),
        image: None,
    }
}

fn gh_mut(r: &mut RunnerRecord) -> &mut GithubLink {
    let Link::Github(g) = &mut r.link else { unreachable!("a GitHub record") };
    g
}

fn org_record() -> RunnerRecord {
    let mut r = repo_record();
    r.config.scope = Scope::Org { org: "acme".into() };
    gh_mut(&mut r).group_id = Some(7);
    gh_mut(&mut r).repos = vec!["acme/a".into()];
    r
}

fn header<'a>(r: &'a Request, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn repo_request(allow_public: bool) -> ConnectRequest {
    serde_json::from_value(json!({
        "provider": "github",
        "scope": { "kind": "repo", "owner": "o", "repo": "r" },
        "appId": 123,
        "installationId": 9,
        "privateKeyPem": PEM,
        "allowPublic": allow_public,
    }))
    .unwrap()
}

fn org_request() -> ConnectRequest {
    serde_json::from_value(json!({
        "provider": "github",
        "scope": { "kind": "org", "org": "acme" },
        "appId": 123,
        "installationId": 9,
        "privateKeyPem": PEM,
        "repos": ["a", "acme/b"],
    }))
    .unwrap()
}

fn b64json(part: &str) -> Value {
    serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap()
}

#[test]
fn jwt_is_rs256_with_app_issuer() {
    let t = rig(vec![], true);
    let jwt = t.gh.app_jwt(123).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert!(!jwt.contains('='));
    let (h, p) = (b64json(parts[0]), b64json(parts[1]));
    assert_eq!((h["alg"].as_str(), h["typ"].as_str()), (Some("RS256"), Some("JWT")));
    assert_eq!(p["iss"], "123");
    assert_eq!(p["exp"].as_u64().unwrap() - p["iat"].as_u64().unwrap(), 600);
    assert_eq!(p["iat"].as_u64(), Some(NOW - 60));
    assert_eq!(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap(), vec![1, 2, 3]);
}

#[tokio::test]
async fn missing_key_is_auth_error() {
    let t = rig(vec![token()], false);
    assert!(matches!(t.gh.mint(&repo_record(), "n").await, Err(ProviderError::Auth(_))));
    assert!(t.http.urls().is_empty());
}

#[tokio::test]
async fn jit_config_request_has_labels_and_group() {
    let jit = (201, json!({ "runner": { "id": 23 }, "encoded_jit_config": "abc" }));
    let t = rig(vec![token(), (200, json!({ "id": 5, "private": true })), jit.clone()], true);
    let minted = t.gh.mint(&repo_record(), "nekko-mac1-1-1").await.unwrap();
    assert_eq!(minted, Minted { runner_id: 23, seed_file: GITHUB_SEED, jit_config: "abc".into() });
    assert_eq!(t.http.urls()[0], "POST https://api.github.com/app/installations/9/access_tokens");
    let last = t.http.last();
    assert_eq!(
        format!("{} {}", last.method, last.url),
        "POST https://api.github.com/repos/o/r/actions/runners/generate-jitconfig"
    );
    assert_eq!(header(&last, "Authorization"), Some("Bearer ghs_inst"));
    assert_eq!(header(&last, "Accept"), Some("application/vnd.github+json"));
    assert_eq!(header(&last, "X-GitHub-Api-Version"), Some("2022-11-28"));
    assert_eq!(header(&last, "User-Agent"), Some("nekko-agent"));
    assert_eq!(t.http.urls()[1], "GET https://api.github.com/repos/o/r");
    let body = t.http.body(2);
    assert_eq!(body["name"], "nekko-mac1-1-1");
    assert_eq!(body["labels"], json!(["self-hosted", "macOS", "ARM64", "nekko-cloud-mac"]));
    assert_eq!(body["runner_group_id"], 1);
    assert_eq!(body["work_folder"], "_work");

    // Org scope: the org's endpoint and the record's group; the token is cached.
    t.http.push(jit.0, jit.1);
    t.gh.mint(&org_record(), "n2").await.unwrap();
    let last = t.http.last();
    assert_eq!(last.url, "https://api.github.com/orgs/acme/actions/runners/generate-jitconfig");
    assert_eq!(t.http.body(3)["runner_group_id"], 7);
    assert_eq!(t.http.urls().len(), 4);
}

#[tokio::test]
async fn org_scope_creates_group_limited_to_repos() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "account": { "login": "Acme" } })),
            (200, json!({ "id": 11, "private": true })),
            (200, json!({ "id": 12, "private": true })),
            (200, json!({ "total_count": 1, "runner_groups": [{ "id": 1, "name": "Default" }] })),
            (201, json!({ "id": 7, "name": "nekko-nekko-cloud-mac" })),
        ],
        false,
    );
    let rec = t.gh.connect(org_request(), Some(NET.into())).await.unwrap();
    let urls = t.http.urls();
    assert_eq!(urls[1], "GET https://api.github.com/app/installations/9");
    assert_eq!(urls[2], "GET https://api.github.com/repos/acme/a");
    assert_eq!(urls[3], "GET https://api.github.com/repos/acme/b");
    assert_eq!(urls[4], "GET https://api.github.com/orgs/acme/actions/runner-groups?per_page=100");
    assert_eq!(urls[5], "POST https://api.github.com/orgs/acme/actions/runner-groups");
    assert_eq!(
        t.http.body(5),
        json!({
            "name": "nekko-nekko-cloud-mac",
            "visibility": "selected",
            "selected_repository_ids": [11, 12],
            "allows_public_repositories": false,
        })
    );
    assert_eq!(rec.github().unwrap().group_id, Some(7));
    assert_eq!(rec.github().unwrap().repos, vec!["acme/a".to_string(), "acme/b".to_string()]);
}

#[tokio::test]
async fn org_with_our_group_updates_it_instead() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "account": { "login": "acme" } })),
            (200, json!({ "id": 11, "private": true })),
            (200, json!({ "id": 12, "private": true })),
            (
                200,
                json!({ "runner_groups": [{
                    "id": 8,
                    "name": "nekko-nekko-cloud-mac",
                    "restricted_to_workflows": true,
                    "selected_workflows": ["acme/app/.github/workflows/ios.yml@refs/heads/main"],
                }] }),
            ),
            (200, json!({ "id": 8 })),
            (204, json!(null)),
        ],
        false,
    );
    let rec = t.gh.connect(org_request(), None).await.unwrap();
    let urls = t.http.urls();
    assert_eq!(urls[5], "PATCH https://api.github.com/orgs/acme/actions/runner-groups/8");
    // The owner's "Selected workflows" restriction survives a reconnect.
    assert_eq!(
        t.http.body(5),
        json!({
            "name": "nekko-nekko-cloud-mac",
            "visibility": "selected",
            "allows_public_repositories": false,
            "restricted_to_workflows": true,
            "selected_workflows": ["acme/app/.github/workflows/ios.yml@refs/heads/main"],
        })
    );
    assert_eq!(urls[6], "PUT https://api.github.com/orgs/acme/actions/runner-groups/8/repositories");
    assert_eq!(t.http.body(6), json!({ "selected_repository_ids": [11, 12] }));
    assert_eq!(rec.github().unwrap().group_id, Some(8));
    assert!(rec.config.settings.trusted_networks.is_empty());
}

#[tokio::test]
async fn org_without_runner_groups_is_refused() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "account": { "login": "acme" } })),
            (200, json!({ "id": 11, "private": true })),
            (200, json!({ "id": 12, "private": true })),
            (200, json!({ "runner_groups": [] })),
            (403, json!({ "message": "Forbidden" })),
        ],
        false,
    );
    let err = t.gh.connect(org_request(), None).await.unwrap_err();
    assert_eq!(err, "This org cannot create runner groups. Connect a single repo instead.");
    assert_eq!(t.vault().get(&key_name(123)), None);
}

#[tokio::test]
async fn public_repo_needs_explicit_allow() {
    let replies =
        || vec![token(), (200, json!({ "account": { "login": "o" } })), (200, json!({ "id": 11, "private": false }))];
    let t = rig(replies(), false);
    let err = t.gh.connect(repo_request(false), None).await.unwrap_err();
    assert!(err.contains("public"), "{err}");
    assert!(t.http.urls().iter().all(|u| !u.contains("generate-jitconfig") && !u.contains("runner-groups")));
    assert_eq!(t.vault().get(&key_name(123)), None);

    let t = rig(replies(), false);
    let rec = t.gh.connect(repo_request(true), None).await.unwrap();
    assert!(rec.github().unwrap().allow_public);
}

#[tokio::test]
async fn installation_must_belong_to_the_scope_owner() {
    let t = rig(vec![token(), (200, json!({ "account": { "login": "someone-else" } }))], false);
    let err = t.gh.connect(repo_request(false), None).await.unwrap_err();
    assert!(err.contains("someone-else"), "{err}");
    assert_eq!(t.vault().get(&key_name(123)), None);
    assert_eq!(t.http.urls().len(), 2);
}

#[tokio::test]
async fn revoked_key_marks_runner_error() {
    let t = rig(vec![(401, json!({ "message": "Bad credentials" }))], false);
    let err = t.gh.connect(repo_request(false), None).await.unwrap_err();
    assert_eq!(err, "GitHub refused this app key. It may have been revoked; connect again with a new key.");
    assert_eq!(t.vault().get(&key_name(123)), None);

    let t = rig(vec![(401, json!({ "message": "Bad credentials" }))], true);
    assert!(matches!(t.gh.mint(&repo_record(), "n").await, Err(ProviderError::Auth(_))));
}

#[tokio::test]
async fn connect_stores_the_key_only_after_github_accepts_it() {
    let t = rig(
        vec![token(), (200, json!({ "account": { "login": "O" } })), (200, json!({ "id": 11, "private": true }))],
        false,
    );
    *t.http.0.watch.lock().unwrap() = Some(t.secrets.clone());
    let rec = t.gh.connect(repo_request(false), Some(NET.into())).await.unwrap();
    assert_eq!(*t.http.0.key_seen.lock().unwrap(), vec![false, false, false]);
    assert_eq!(t.vault().get(&key_name(123)).as_deref(), Some(PEM));
    assert!(rec.config.settings.enabled);
    assert_eq!(rec.config.settings.trusted_networks, vec![NET.to_string()]);
    assert_eq!(rec.config.label, "nekko-cloud-mac");
    assert_eq!(rec.config.scope, Scope::Repo { owner: "o".into(), repo: "r".into() });
    assert_eq!(
        *rec.github().unwrap(),
        GithubLink {
            app_id: 123,
            installation_id: 9,
            group_id: None,
            repos: vec!["o/r".into()],
            allow_public: false,
            slug: None,
        }
    );
    assert!(!rec.config.id.is_empty());
}

#[tokio::test]
async fn connect_can_leave_a_new_runner_off() {
    let t = rig(
        vec![token(), (200, json!({ "account": { "login": "O" } })), (200, json!({ "id": 11, "private": true }))],
        false,
    );
    let req = ConnectRequest { enabled: false, ..repo_request(false) };
    assert!(!t.gh.connect(req, None).await.unwrap().config.settings.enabled);
}

#[tokio::test]
async fn connect_refuses_bad_input_before_asking_github() {
    let t = rig(vec![], false);
    let mut bad = repo_request(false);
    bad.label = Some("has space".into());
    assert!(t.gh.connect(bad, None).await.is_err());
    let mut pkcs8 = repo_request(false);
    pkcs8.private_key_pem = Some("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n".into());
    assert!(t.gh.connect(pkcs8, None).await.unwrap_err().contains("BEGIN RSA PRIVATE KEY"));
    let mut sneaky = repo_request(false);
    sneaky.scope = Scope::Repo { owner: "o".into(), repo: "../../evil".into() };
    assert!(t.gh.connect(sneaky, None).await.is_err());
    let mut org = org_request();
    org.repos.clear();
    assert!(t.gh.connect(org, None).await.is_err());
    let mut gitlab = repo_request(false);
    gitlab.provider = "gitlab".into();
    assert!(t.gh.connect(gitlab, None).await.is_err());
    // No key given and none stored.
    let mut keyless = repo_request(false);
    keyless.private_key_pem = None;
    assert!(t.gh.connect(keyless, None).await.is_err());
    assert!(t.http.urls().is_empty());
}

static CLOCK: AtomicU64 = AtomicU64::new(NOW);

fn clock() -> u64 {
    CLOCK.load(Ordering::SeqCst)
}

#[tokio::test]
async fn installation_token_is_cached_until_near_expiry() {
    // Expires an hour after NOW.
    let tok = (201, json!({ "token": "ghs_1", "expires_at": "2027-01-15T09:00:00Z" }));
    let t = rig_at(vec![tok.clone(), (200, json!({ "runners": [] })), (200, json!({ "runners": [] }))], true, clock);
    let link = repo_record().github().unwrap().clone();
    assert_eq!(t.gh.installation_token(&link).await.unwrap(), "ghs_1");
    CLOCK.store(NOW + 3600 - 301, Ordering::SeqCst);
    assert_eq!(t.gh.installation_token(&link).await.unwrap(), "ghs_1");
    assert_eq!(t.http.urls().len(), 1);
    CLOCK.store(NOW + 3600 - 300, Ordering::SeqCst);
    t.http.0.replies.lock().unwrap().push_front((
        201,
        json!({ "token": "ghs_2", "expires_at": "2030-01-01T00:00:00Z" }).to_string(),
        None,
    ));
    assert_eq!(t.gh.installation_token(&link).await.unwrap(), "ghs_2");
    assert_eq!(t.http.urls().len(), 2);
}

#[tokio::test]
async fn status_maps_busy_offline_and_missing() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "id": 5, "status": "online", "busy": true })),
            (200, json!({ "id": 5, "status": "online", "busy": false })),
            (200, json!({ "id": 5, "status": "offline", "busy": false })),
            (404, json!({ "message": "Not Found" })),
        ],
        true,
    );
    let r = repo_record();
    assert_eq!(t.gh.status(&r, 5).await, Ok(RunnerStatus::Busy));
    assert_eq!(t.gh.status(&r, 5).await, Ok(RunnerStatus::Idle));
    assert_eq!(t.gh.status(&r, 5).await, Ok(RunnerStatus::Offline));
    assert_eq!(t.gh.status(&r, 5).await, Ok(RunnerStatus::Missing));
    assert_eq!(t.http.last().url, "https://api.github.com/repos/o/r/actions/runners/5");
}

#[tokio::test]
async fn remove_tolerates_404_and_stale_removes_only_ours() {
    let t = rig(
        vec![
            token(),
            (404, json!({ "message": "Not Found" })),
            (
                200,
                json!({ "total_count": 3, "runners": [
                    { "id": 1, "name": "nekko-mac1-abcd1234-1-1", "status": "offline" },
                    { "id": 2, "name": "nekko-mac1-abcd1234-1-2", "status": "online" },
                    { "id": 3, "name": "other", "status": "offline" },
                ] }),
            ),
            (204, json!(null)),
        ],
        true,
    );
    let r = org_record();
    assert_eq!(t.gh.remove(&r, 40).await, Ok(()));
    assert_eq!(t.http.urls()[1], "DELETE https://api.github.com/orgs/acme/actions/runners/40");
    assert_eq!(t.gh.remove_stale(&r, "nekko-mac1-abcd1234-").await, Ok(1));
    let urls = t.http.urls();
    assert_eq!(urls[2], "GET https://api.github.com/orgs/acme/actions/runners?per_page=100");
    assert_eq!(&urls[3..], ["DELETE https://api.github.com/orgs/acme/actions/runners/1"]);
}

#[tokio::test]
async fn queued_counts_jobs_with_our_labels() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "workflow_runs": [{ "id": 100, "name": "CI" }] })),
            (
                200,
                json!({ "jobs": [
                    { "id": 1, "status": "queued", "labels": ["self-hosted", "macOS", "nekko-cloud-mac"] },
                    { "id": 2, "status": "queued", "labels": ["ubuntu-latest"] },
                    { "id": 3, "status": "queued", "labels": ["self-hosted", "gpu"] },
                    { "id": 4, "status": "in_progress", "labels": ["self-hosted"] },
                ] }),
            ),
        ],
        true,
    );
    assert_eq!(t.gh.queued(&repo_record()).await, Ok(1));
    let urls = t.http.urls();
    assert_eq!(urls[1], "GET https://api.github.com/repos/o/r/actions/runs?status=queued&per_page=10");
    assert_eq!(urls[2], "GET https://api.github.com/repos/o/r/actions/runs/100/jobs?filter=latest&per_page=100");
}

fn in_progress() -> Vec<(u16, Value)> {
    vec![
        (200, json!({ "workflow_runs": [{ "id": 100, "name": "CI" }] })),
        (200, json!({ "jobs": [{ "id": 5, "name": "build", "run_id": 100, "runner_name": "nekko-mac1-1-1" }] })),
    ]
}

#[tokio::test]
async fn job_finds_the_runner_by_name() {
    let mut replies = vec![token()];
    replies.extend(in_progress());
    replies.extend(in_progress());
    let t = rig(replies, true);
    let r = repo_record();
    let job = t.gh.job(&r, 0, "nekko-mac1-1-1").await.unwrap();
    assert_eq!(
        job,
        Some(JobRef { repo: "o/r".into(), run_id: 100, job_id: 5, workflow: "CI".into(), job: "build".into() })
    );
    assert_eq!(t.http.urls()[1], "GET https://api.github.com/repos/o/r/actions/runs?status=in_progress&per_page=10");
    // A runner that never took a job has none.
    assert_eq!(t.gh.job(&r, 0, "nekko-mac1-9-9").await, Ok(None));
}

#[tokio::test]
async fn rerun_posts_the_job() {
    let t = rig(vec![token(), (201, json!({}))], true);
    let job = JobRef { repo: "o/r".into(), run_id: 100, job_id: 5, workflow: "CI".into(), job: "build".into() };
    assert_eq!(t.gh.rerun(&repo_record(), &job).await, Ok(()));
    assert_eq!(t.http.urls()[1], "POST https://api.github.com/repos/o/r/actions/jobs/5/rerun");
}

#[test]
fn scopes_match_in_any_case() {
    let a = Scope::Repo { owner: "Octo".into(), repo: "Hello".into() };
    assert!(same_scope(&a, &Scope::Repo { owner: "octo".into(), repo: "HELLO".into() }));
    assert!(!same_scope(&a, &Scope::Repo { owner: "octo".into(), repo: "other".into() }));
    assert!(same_scope(&Scope::Org { org: "ACME".into() }, &Scope::Org { org: "acme".into() }));
    assert!(!same_scope(&Scope::Org { org: "o".into() }, &Scope::Repo { owner: "o".into(), repo: "o".into() }));
}

#[cfg(target_os = "macos")]
#[test]
fn rs256_signature_verifies() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key.pem");
    let ssl = |args: &[&str]| Command::new("/usr/bin/openssl").args(args).current_dir(dir.path()).output().unwrap();
    // OpenSSL 3 needs -traditional for PKCS#1; LibreSSL writes PKCS#1 already and has no such flag.
    if !ssl(&["genrsa", "-traditional", "-out", "key.pem", "2048"]).status.success() {
        assert!(ssl(&["genrsa", "-out", "key.pem", "2048"]).status.success());
    }
    let pem = std::fs::read_to_string(&key).unwrap();
    assert!(pem.contains("BEGIN RSA PRIVATE KEY"), "{pem}");
    assert!(ssl(&["rsa", "-in", "key.pem", "-pubout", "-out", "pub.pem"]).status.success());
    let msg = b"header.payload";
    let sig = SecKeySigner.rs256(&pem, msg).unwrap();
    std::fs::write(dir.path().join("msg"), msg).unwrap();
    std::fs::write(dir.path().join("sig"), &sig).unwrap();
    let out = ssl(&["dgst", "-sha256", "-verify", "pub.pem", "-signature", "sig", "msg"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));

    assert!(ssl(&["pkcs8", "-topk8", "-nocrypt", "-in", "key.pem", "-out", "p8.pem"]).status.success());
    let p8 = std::fs::read_to_string(dir.path().join("p8.pem")).unwrap();
    let err = SecKeySigner.rs256(&p8, msg).unwrap_err();
    assert!(err.contains("BEGIN RSA PRIVATE KEY"), "{err}");
}

#[tokio::test]
async fn a_failed_connect_leaves_no_token_behind() {
    let t = rig(
        vec![
            token(),
            (200, json!({ "account": { "login": "o" } })),
            (200, json!({ "id": 11, "private": false })),
            (201, json!({ "token": "ghs_fresh", "expires_at": "2030-01-01T00:00:00Z" })),
        ],
        true,
    );
    assert!(t.gh.connect(repo_request(false), None).await.is_err());
    assert_eq!(t.gh.installation_token(repo_record().github().unwrap()).await.unwrap(), "ghs_fresh");
}

#[test]
fn connect_requests_never_print_the_key() {
    let shown = format!("{:?}", repo_request(false));
    assert!(!shown.contains("MIIB") && shown.contains("redacted"), "{shown}");
}

fn early() -> u64 {
    10
}

#[test]
fn a_clock_near_zero_does_not_underflow() {
    let t = rig_at(vec![], true, early);
    let jwt = t.gh.app_jwt(123).unwrap();
    assert_eq!(b64json(jwt.split('.').nth(1).unwrap())["iat"], 0);
}

#[tokio::test]
async fn stale_sweep_matches_only_this_install_exactly() {
    let t = rig(
        vec![
            token(),
            (
                200,
                json!({ "runners": [
                    { "id": 1, "name": "nekko-macbook-pro-abcd1234-1700000000-1", "status": "offline" },
                    { "id": 2, "name": "nekko-macbook-pro-2-abcd1234-1700000000-1", "status": "offline" },
                    { "id": 3, "name": "nekko-macbook-pro-ffff0000-1700000000-1", "status": "offline" },
                    { "id": 4, "name": "nekko-macbook-pro-abcd1234-1700000000-1-x", "status": "offline" },
                    { "id": 5, "name": "nekko-macbook-pro-abcd1234-17x-1", "status": "offline" },
                    { "id": 6, "name": "nekko-macbook-pro-abcd1234-1700000000-2", "status": "online" },
                ] }),
            ),
            (204, json!(null)),
        ],
        true,
    );
    assert_eq!(t.gh.remove_stale(&org_record(), "nekko-macbook-pro-abcd1234-").await, Ok(1));
    assert_eq!(t.http.urls().last().unwrap(), "DELETE https://api.github.com/orgs/acme/actions/runners/1");
}

#[tokio::test]
async fn rate_limits_are_not_a_revoked_key() {
    for msg in [
        "You have exceeded a secondary rate limit. Please wait a few minutes.",
        "API rate limit exceeded for installation ID 9.",
    ] {
        let t = rig(vec![(403, json!({ "message": msg }))], true);
        assert!(matches!(t.gh.mint(&org_record(), "n").await, Err(ProviderError::Other(_))), "{msg}");
    }
    let t = rig(vec![(403, json!({ "message": "Resource not accessible by integration" }))], true);
    assert!(matches!(t.gh.mint(&org_record(), "n").await, Err(ProviderError::Auth(_))));
}

#[tokio::test]
async fn a_repo_that_went_public_is_refused_at_mint() {
    let t = rig(vec![token(), (200, json!({ "id": 5, "private": false }))], true);
    match t.gh.mint(&repo_record(), "n").await {
        Err(ProviderError::Auth(m)) => assert!(m.contains("o/r is public"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(t.http.urls()[1], "GET https://api.github.com/repos/o/r");
    assert!(!t.http.urls().iter().any(|u| u.contains("generate-jitconfig")));

    let mut allowed = repo_record();
    gh_mut(&mut allowed).allow_public = true;
    let jit = (201, json!({ "runner": { "id": 23 }, "encoded_jit_config": "abc" }));
    let t = rig(vec![token(), jit], true);
    assert!(t.gh.mint(&allowed, "n").await.is_ok());
    assert!(!t.http.urls().iter().any(|u| u.ends_with("/repos/o/r")), "allowed: no extra check");
}
