use super::*;
use serde_json::json;

const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB\n-----END RSA PRIVATE KEY-----\n";

fn org() -> Owner {
    Owner::Org("nekko-labs".into())
}

fn user() -> Owner {
    Owner::User("ermish".into())
}

fn perms(m: &Value) -> &serde_json::Map<String, Value> {
    m["default_permissions"].as_object().unwrap()
}

#[test]
fn name_is_capped_at_34_and_never_split_mid_character() {
    assert_eq!(app_name("nekko-labs", "3fa9"), "Nekko Runner nekko-labs 3fa9");
    let long = app_name("a-very-long-organization-name", "3fa9");
    assert_eq!(long, "Nekko Runner a-very-long-orga 3fa9");
    assert_eq!(long.chars().count(), 34);
    let wide = app_name(&"\u{732b}".repeat(40), "3fa9");
    assert_eq!(wide.chars().count(), 34);
    assert!(wide.ends_with("\u{732b} 3fa9"), "{wide}");
}

#[test]
fn manifest_has_the_designed_fields() {
    let m = manifest(&org(), 4242, "3fa9", false);
    assert_eq!(m["name"], "Nekko Runner nekko-labs 3fa9");
    assert_eq!(m["url"], "https://nekkoagent.com/docs/ci-runners");
    assert_eq!(m["hook_attributes"], json!({ "url": "https://nekkoagent.com/docs/ci-runners", "active": false }));
    assert_eq!(m["redirect_url"], "http://localhost:4242/created");
    assert_eq!(m["setup_url"], "http://localhost:4242/installed");
    assert_eq!(m["public"], false);
}

#[test]
fn org_manifest_has_the_runner_permission_and_no_administration() {
    let m = manifest(&org(), 1, "abcd", false);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "organization_self_hosted_runners": "write" })
            .as_object()
            .unwrap()
    );
}

#[test]
fn user_manifest_has_administration() {
    let m = manifest(&user(), 1, "abcd", false);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "administration": "write" }).as_object().unwrap()
    );
}

#[test]
fn an_org_gets_administration_only_on_the_single_repo_path() {
    let m = manifest(&org(), 1, "abcd", true);
    assert_eq!(
        perms(&m),
        json!({ "actions": "write", "metadata": "read", "administration": "write" }).as_object().unwrap()
    );
}

#[test]
fn urls_name_the_right_place() {
    assert_eq!(create_url(&user(), "s1"), "https://github.com/settings/apps/new?state=s1");
    assert_eq!(create_url(&org(), "s1"), "https://github.com/organizations/nekko-labs/settings/apps/new?state=s1");
    assert_eq!(install_url("nekko-runner-3fa9"), "https://github.com/apps/nekko-runner-3fa9/installations/new");
}

#[test]
fn form_page_escapes_the_manifest() {
    let page =
        form_page("https://github.com/settings/apps/new?state=a&b=1", &json!({ "name": "\"><script>x</script>" }));
    assert!(page.contains("method=\"post\"") && page.contains("name=\"manifest\""), "{page}");
    assert!(page.contains("action=\"https://github.com/settings/apps/new?state=a&amp;b=1\""), "{page}");
    assert!(page.contains("&quot;&gt;&lt;script&gt;x"), "{page}");
    assert!(!page.contains("\"><script>x"), "{page}");
    assert!(page.contains(".submit()"), "{page}");
}

#[test]
fn conversion_reads_the_new_app() {
    let c = parse_conversion(&json!({ "id": 7, "slug": "nekko-runner", "pem": PEM, "client_secret": "s" })).unwrap();
    assert_eq!((c.app_id, c.slug.as_str(), c.pem.as_str()), (7, "nekko-runner", PEM));
    assert!(!format!("{c:?}").contains("MIIBOgIBAAJB"));
}

#[test]
fn conversion_refuses_a_key_that_is_not_pkcs1_and_never_echoes_it() {
    let pem = "-----BEGIN PRIVATE KEY-----\nSECRETBODY\n-----END PRIVATE KEY-----\n";
    let e = parse_conversion(&json!({ "id": 7, "slug": "s", "pem": pem })).unwrap_err();
    assert!(e.contains("BEGIN RSA PRIVATE KEY") && !e.contains("SECRETBODY"), "{e}");
}

#[test]
fn conversion_refuses_a_slug_that_could_leave_the_install_path() {
    let e = parse_conversion(&json!({ "id": 7, "slug": "../evil", "pem": PEM })).unwrap_err();
    assert!(!e.is_empty() && !e.contains("MIIBOgIBAAJB"), "{e}");
    assert!(parse_conversion(&json!({ "slug": "s", "pem": PEM })).is_err());
    assert!(parse_conversion(&json!({ "id": 7, "slug": "s" })).is_err());
}

// The setup session. `Scripted` stands in for GitHub: no test reaches the network.

use crate::runner::github::{GitHub, Signer};
use crate::runner::keychain::key_name;
use crate::runner::store::{GithubLink, Link, RunnerRecord};
use crate::runner::test_http::Scripted;
use axum::http::{StatusCode, header};
use nekko_cloud::vault::{FileVault, Vault};
use nekko_runner::{RunnerConfig, RunnerSettings, Scope};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

struct FakeSigner;

impl Signer for FakeSigner {
    fn rs256(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        Ok(vec![1, 2, 3])
    }
}

const SECRET_CODE: &str = "c0de5ecret";

struct T {
    http: Scripted,
    setup: Arc<GithubSetup<Scripted>>,
    secrets: PathBuf,
    dir: tempfile::TempDir,
}

/// A setup over `dir`, as a daemon would start on it.
fn setup_at(dir: &Path, http: &Scripted) -> Arc<GithubSetup<Scripted>> {
    let secrets = dir.join("secrets.json");
    let gh = GitHub::new(
        http.clone(),
        "https://api.github.com".into(),
        Box::new(FileVault::new(secrets)),
        Box::new(FakeSigner),
        || 1_800_000_000,
    );
    GithubSetup::with_timing(
        gh,
        dir,
        crate::hub::Hub::new(),
        "/nonexistent/gh".into(),
        Duration::from_millis(2),
        Duration::from_secs(30),
    )
}

fn rig(replies: Vec<(u16, Value)>) -> T {
    let dir = tempfile::tempdir().unwrap();
    let http = Scripted::new(replies);
    let setup = setup_at(dir.path(), &http);
    T { secrets: dir.path().join("secrets.json"), http, setup, dir }
}

impl T {
    fn key(&self, app: u64) -> Option<String> {
        FileVault::new(self.secrets.clone()).get(&key_name(app))
    }
    fn pending(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.dir.path().join("pending-app.json")).unwrap()).unwrap()
    }
    fn seed_pending(&self, owner: &str) {
        FileVault::new(self.secrets.clone()).set(&key_name(7), PEM).unwrap();
        let body = json!({ "appId": 7, "slug": "nekko-runner-acme", "owner": owner, "kind": "org" });
        std::fs::write(self.dir.path().join("pending-app.json"), body.to_string()).unwrap();
    }
    async fn start(&self) -> Value {
        let req = StartRequest { owner: "acme".into(), kind: Kind::Org, repo_admin: false };
        self.setup.start(req, &[]).await.unwrap()
    }
    fn state(&self) -> String {
        self.setup.lock().state.clone().unwrap()
    }
    async fn get(&self, path: &str) -> (StatusCode, String, String) {
        let res = self.setup.clone().page(path.parse().unwrap()).await;
        let status = res.status();
        let location = res.headers().get(header::LOCATION).map(|l| l.to_str().unwrap().to_string()).unwrap_or_default();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, location, String::from_utf8_lossy(&bytes).into_owned())
    }
    /// The browser coming back from GitHub with a good `state`.
    async fn created(&self) -> (StatusCode, String, String) {
        self.get(&format!("/created?code={SECRET_CODE}&state={}", self.state())).await
    }
    async fn step_becomes(&self, step: Step) {
        for _ in 0..1000 {
            if self.setup.view().step == step {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("never reached {step:?}: {:?}", self.setup.view());
    }
}

fn conversion() -> (u16, Value) {
    (201, json!({ "id": 7, "slug": "nekko-runner-acme", "pem": PEM, "client_secret": "cs", "webhook_secret": "ws" }))
}

fn installed() -> (u16, Value) {
    (200, json!([{ "id": 55, "account": { "login": "ACME" } }]))
}

fn inst_token() -> (u16, Value) {
    (201, json!({ "token": "ghs_inst", "expires_at": "2030-01-01T00:00:00Z" }))
}

fn repos() -> (u16, Value) {
    (
        200,
        json!({ "repositories": [
        { "full_name": "acme/app", "private": true },
        { "full_name": "acme/site", "private": false },
    ] }),
    )
}

fn saved(slug: Option<&str>) -> RunnerRecord {
    RunnerRecord {
        config: RunnerConfig {
            id: "gh-1".into(),
            scope: Scope::Org { org: "acme".into() },
            label: "nekko-cloud-mac".into(),
            settings: RunnerSettings::default(),
        },
        link: Link::Github(GithubLink {
            app_id: 7,
            installation_id: 55,
            group_id: Some(3),
            repos: vec!["acme/app".into()],
            allow_public: false,
            slug: slug.map(str::to_string),
        }),
        image: None,
    }
}

fn url_of(v: &Value) -> &str {
    v["url"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn start_opens_the_one_time_page() {
    let t = rig(vec![]);
    let started = t.start().await;
    let path = url_of(&started).strip_prefix("http://localhost:").unwrap();
    let path = &path[path.find('/').unwrap()..];
    assert!(path.starts_with("/start?t="), "{path}");
    assert_eq!(t.setup.view().step, Step::Create);

    let (status, _, page) = t.get(path).await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("https://github.com/organizations/acme/settings/apps/new?state="), "{page}");
    assert!(page.contains(&t.state()), "{page}");
    assert!(page.contains("organization_self_hosted_runners"), "{page}");
    // One use: the page holds the state.
    assert_eq!(t.get(path).await.0, StatusCode::NOT_FOUND);
    assert_eq!(t.get("/start?t=guess").await.0, StatusCode::NOT_FOUND);
    assert_eq!(t.get("/elsewhere").await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_real_browser_can_reach_the_page_on_loopback() {
    let t = rig(vec![]);
    let started = t.start().await;
    let url = url_of(&started).replace("localhost", "127.0.0.1");
    let res = reqwest::Client::new().get(url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.text().await.unwrap().contains("name=\"manifest\""));
}

#[tokio::test]
async fn a_wrong_state_makes_no_conversion_call() {
    let t = rig(vec![conversion()]);
    t.start().await;
    for path in ["/created?code=abc&state=wrong", "/created?code=abc", "/created?state=wrong"] {
        assert_eq!(t.get(path).await.0, StatusCode::BAD_REQUEST, "{path}");
    }
    assert!(t.http.urls().is_empty());
    assert_eq!(t.setup.view().step, Step::Create);
    assert!(!t.dir.path().join("pending-app.json").exists());
}

#[tokio::test]
async fn a_replayed_callback_converts_nothing() {
    let t = rig(vec![conversion()]);
    t.start().await;
    let state = t.state();
    t.created().await;
    let conversions = |t: &T| t.http.urls().iter().filter(|u| u.contains("/app-manifests/")).count();
    assert_eq!(conversions(&t), 1);
    let (status, _, _) = t.get(&format!("/created?code={SECRET_CODE}&state={state}")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(conversions(&t), 1);
}

#[tokio::test]
async fn a_code_that_could_leave_the_path_is_refused() {
    let t = rig(vec![conversion()]);
    t.start().await;
    let (status, _, _) = t.get(&format!("/created?code=..%2Fx&state={}", t.state())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(t.http.urls().is_empty());
}

#[tokio::test]
async fn a_good_callback_stores_the_key_and_pending_before_redirecting() {
    let t = rig(vec![conversion()]);
    t.start().await;
    let (status, location, _) = t.created().await;
    assert_eq!(status, StatusCode::SEE_OTHER);
    assert_eq!(location, "https://github.com/apps/nekko-runner-acme/installations/new");
    assert_eq!(t.key(7).as_deref(), Some(PEM));
    assert_eq!(
        t.pending(),
        json!({ "appId": 7, "slug": "nekko-runner-acme", "owner": "acme", "kind": "org", "repoAdmin": false })
    );
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(t.dir.path().join("pending-app.json")).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);

    let call = t.http.0.seen.lock().unwrap()[0].clone();
    assert_eq!(call.url, format!("https://api.github.com/app-manifests/{SECRET_CODE}/conversions"));
    assert!(!call.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization")));
    let v = t.setup.view();
    assert_eq!((v.step, v.app_id, v.slug.as_deref()), (Step::Install, Some(7), Some("nekko-runner-acme")));
    assert!(t.pending().get("client_secret").is_none());
}

#[tokio::test]
async fn a_restart_with_a_pending_file_resumes_at_install() {
    let t = rig(vec![conversion()]);
    t.start().await;
    t.created().await;
    t.setup.cancel();

    let http = Scripted::new(vec![(200, json!([]))]);
    let restarted = setup_at(t.dir.path(), &http);
    let req = StartRequest { owner: "ACME".into(), kind: Kind::Org, repo_admin: false };
    let started = restarted.start(req, &[]).await.unwrap();
    assert_eq!(url_of(&started), "https://github.com/apps/nekko-runner-acme/installations/new");
    assert_eq!(restarted.view().step, Step::Install);
    assert!(restarted.lock().state.is_none(), "no way back to the create page");
    assert!(http.urls().iter().all(|u| !u.contains("app-manifests")));
    restarted.cancel();
}

#[tokio::test]
async fn reopening_after_a_restart_resumes_from_status_alone() {
    let t = rig(vec![(200, json!([]))]);
    t.seed_pending("acme");
    assert_eq!(t.setup.view().step, Step::Idle);
    let v = t.setup.status().await;
    assert_eq!((v.step, v.owner.as_deref(), v.kind), (Step::Install, Some("acme"), Some(Kind::Org)));
    t.setup.cancel();
}

#[tokio::test]
async fn a_pending_app_without_its_key_is_not_resumed() {
    let t = rig(vec![]);
    t.seed_pending("acme");
    FileVault::new(t.secrets.clone()).delete(&key_name(7));
    assert_eq!(t.setup.status().await.step, Step::Idle);
    assert!(url_of(&t.start().await).contains("/start?t="));
    assert!(!t.dir.path().join("pending-app.json").exists());
}

#[tokio::test]
async fn a_second_app_for_the_same_owner_is_not_created() {
    let t = rig(vec![conversion(), (200, json!([]))]);
    let first = t.start().await;
    // Pressed twice before GitHub: the same attempt, the same state, a fresh one-use page.
    let state = t.state();
    let again = t.start().await;
    assert_eq!(t.state(), state);
    assert!(url_of(&again).contains("/start?t=") && url_of(&again) != url_of(&first));
    assert_eq!(t.get(&url_of(&first)[url_of(&first).find("/start").unwrap()..]).await.0, StatusCode::NOT_FOUND);

    t.created().await;
    let third = t.start().await;
    assert_eq!(url_of(&third), "https://github.com/apps/nekko-runner-acme/installations/new");
    assert!(t.setup.lock().state.is_none());
    assert_eq!(t.http.urls().iter().filter(|u| u.contains("/app-manifests/")).count(), 1);
    t.setup.cancel();
}

#[tokio::test]
async fn the_poll_finds_the_installation_with_no_installed_hit() {
    let t = rig(vec![conversion(), (200, json!([])), installed(), inst_token(), repos()]);
    t.start().await;
    t.created().await;
    t.step_becomes(Step::Confirm).await;
    let v = t.setup.view();
    assert_eq!(v.installation_id, Some(55));
    assert_eq!(
        v.repos,
        vec![
            RepoView { name: "acme/app".into(), private: true },
            RepoView { name: "acme/site".into(), private: false }
        ]
    );
    let urls = t.http.urls();
    assert!(urls.iter().any(|u| u.ends_with("/app/installations?per_page=100")), "{urls:?}");
    assert!(urls.iter().any(|u| u.ends_with("/installation/repositories?per_page=100")), "{urls:?}");
    let last = t.http.last();
    assert!(last.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer ghs_inst"), "{last:?}");
}

#[tokio::test]
async fn installed_only_wakes_the_poll() {
    let t = rig(vec![]);
    t.start().await;
    let (status, location, body) = t.get("/installed?installation_id=999&setup_action=install").await;
    assert_eq!((status, location.as_str()), (StatusCode::OK, ""));
    assert!(body.contains("Nekko"), "{body}");
    assert!(t.http.urls().is_empty());
    assert_eq!(t.setup.view().installation_id, None);
}

#[tokio::test]
async fn an_installation_on_another_account_does_not_count() {
    let other = (200, json!([{ "id": 1, "account": { "login": "someone-else" } }]));
    let t = rig(vec![other]);
    t.seed_pending("acme");
    t.start().await;
    assert_eq!(t.setup.view().step, Step::Install);
    t.setup.cancel();
}

#[tokio::test]
async fn start_with_the_installation_already_there_goes_straight_to_confirm() {
    let t = rig(vec![installed(), inst_token(), repos()]);
    t.seed_pending("acme");
    assert_eq!(t.start().await["url"], Value::Null);
    assert_eq!(t.setup.view().step, Step::Confirm);
}

#[tokio::test]
async fn a_saved_record_of_the_same_owner_reuses_its_app() {
    let t = rig(vec![installed(), inst_token(), repos()]);
    FileVault::new(t.secrets.clone()).set(&key_name(7), PEM).unwrap();
    let req = StartRequest { owner: "Acme".into(), kind: Kind::Org, repo_admin: false };
    assert_eq!(t.setup.start(req, &[saved(Some("nekko-runner-acme"))]).await.unwrap()["url"], Value::Null);
    let v = t.setup.view();
    assert_eq!((v.step, v.app_id, v.slug.as_deref()), (Step::Confirm, Some(7), Some("nekko-runner-acme")));
    assert!(t.http.urls().iter().all(|u| !u.contains("app-manifests")));
}

#[tokio::test]
async fn a_saved_record_with_no_slug_cannot_be_reused() {
    let t = rig(vec![]);
    FileVault::new(t.secrets.clone()).set(&key_name(7), PEM).unwrap();
    let req = StartRequest { owner: "acme".into(), kind: Kind::Org, repo_admin: false };
    assert!(url_of(&t.setup.start(req, &[saved(None)]).await.unwrap()).contains("/start?t="));
}

#[tokio::test]
async fn cancel_stops_the_poll() {
    let t = rig(vec![conversion()]);
    t.start().await;
    t.created().await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(t.http.urls().len() > 1, "the poll runs");
    assert_eq!(t.setup.cancel().step, Step::Idle);
    tokio::task::yield_now().await;
    let seen = t.http.urls().len();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(t.http.urls().len(), seen);
    // Leaving is safe: the app and its key stay, so it can resume.
    assert_eq!(t.key(7).as_deref(), Some(PEM));
    assert_eq!(t.pending()["appId"], 7);
}

#[tokio::test]
async fn the_wait_ends_after_its_limit() {
    let dir = tempfile::tempdir().unwrap();
    let http = Scripted::default();
    let gh = GitHub::new(
        http.clone(),
        "https://api.github.com".into(),
        Box::new(FileVault::new(dir.path().join("secrets.json"))),
        Box::new(FakeSigner),
        || 1_800_000_000,
    );
    let setup = GithubSetup::with_timing(
        gh,
        dir.path(),
        crate::hub::Hub::new(),
        "/nonexistent/gh".into(),
        Duration::from_millis(2),
        Duration::from_millis(20),
    );
    let started = setup.start(StartRequest { owner: "acme".into(), kind: Kind::Org, repo_admin: false }, &[]).await;
    let url = url_of(&started.unwrap()).replace("localhost", "127.0.0.1");
    tokio::time::sleep(Duration::from_millis(60)).await;
    let v = setup.view();
    assert_eq!(v.step, Step::Failed);
    assert!(v.error.unwrap().contains("Start again"));
    assert!(reqwest::Client::new().get(url).send().await.is_err(), "the listener is gone");
}

#[tokio::test]
async fn a_conversion_error_never_contains_the_code_or_pem() {
    let t = rig(vec![(422, json!({ "message": format!("bad code {SECRET_CODE} {PEM}") }))]);
    t.start().await;
    let (status, _, body) = t.created().await;
    assert!(status.is_client_error() || status.is_server_error());
    let error = t.setup.view().error.unwrap();
    assert_eq!(t.setup.view().step, Step::Failed);
    for text in [&error, &body] {
        assert!(!text.contains(SECRET_CODE) && !text.contains("BEGIN RSA"), "{text}");
    }

    let bad_key = (201, json!({ "id": 7, "slug": "s", "pem": format!("not a key {SECRET_CODE}") }));
    let t = rig(vec![bad_key]);
    t.start().await;
    let (_, _, body) = t.created().await;
    let error = t.setup.view().error.unwrap();
    for text in [&error, &body] {
        assert!(!text.contains(SECRET_CODE), "{text}");
    }
    assert_eq!(t.key(7), None);
    assert!(!t.dir.path().join("pending-app.json").exists());
}

#[tokio::test]
async fn a_deleted_app_is_forgotten_so_the_next_start_can_create_one() {
    let t = rig(vec![(401, json!({ "message": "Integration not found" }))]);
    t.seed_pending("acme");
    assert_eq!(t.start().await["url"], Value::Null);
    let v = t.setup.view();
    assert_eq!(v.step, Step::Failed);
    assert!(v.error.unwrap().contains("Start again"));
    assert!(!t.dir.path().join("pending-app.json").exists());
    assert_eq!(t.key(7), None);
}

#[tokio::test]
async fn a_refused_key_keeps_the_pending_app() {
    let t = rig(vec![(401, json!({ "message": "'Expiration time' claim is too far in the future" }))]);
    t.seed_pending("acme");
    t.start().await;
    assert_eq!(t.setup.view().step, Step::Failed);
    assert!(t.dir.path().join("pending-app.json").exists());
    assert_eq!(t.key(7).as_deref(), Some(PEM));
}

#[tokio::test]
async fn connected_ends_the_session_and_removes_pending() {
    let t = rig(vec![conversion(), installed(), inst_token(), repos()]);
    t.start().await;
    t.created().await;
    t.step_becomes(Step::Confirm).await;
    assert_eq!(t.setup.slug_for(7).as_deref(), Some("nekko-runner-acme"));
    t.setup.connected(7);
    assert_eq!(t.setup.view().step, Step::Idle);
    assert!(!t.dir.path().join("pending-app.json").exists());
    assert_eq!(t.key(7).as_deref(), Some(PEM), "the runner signs with it now");
    assert_eq!(t.setup.slug_for(7), None);
}

#[tokio::test]
async fn the_saved_record_names_the_app_it_was_set_up_with() {
    let t = rig(vec![]);
    t.seed_pending("acme");
    let mut rec = saved(None);
    t.setup.stamp(&mut rec);
    assert_eq!(rec.github().unwrap().slug.as_deref(), Some("nekko-runner-acme"));
    let mut manual = saved(None);
    manual.link = Link::Github(GithubLink { app_id: 8, ..manual.github().unwrap().clone() });
    t.setup.stamp(&mut manual);
    assert_eq!(manual.github().unwrap().slug, None);
}

#[tokio::test]
async fn connecting_another_app_leaves_a_pending_app_alone() {
    let t = rig(vec![]);
    t.seed_pending("acme");
    t.setup.connected(8);
    assert!(t.dir.path().join("pending-app.json").exists());
    assert_eq!(t.setup.slug_for(7).as_deref(), Some("nekko-runner-acme"));
}

#[tokio::test]
async fn every_change_is_pushed() {
    let t = rig(vec![conversion()]);
    let mut events = t.setup.hub.subscribe();
    t.start().await;
    let frame: Value = serde_json::from_str(events.recv().await.unwrap().text.as_str()).unwrap();
    assert_eq!(frame["channel"], "runner:githubChanged");
    assert_eq!(frame["payload"]["step"], "create");
    assert_eq!(frame["payload"]["owner"], "acme");
    t.setup.cancel();
}

#[tokio::test]
async fn start_refuses_a_name_that_is_not_an_account() {
    let t = rig(vec![]);
    for owner in ["", "a/b", "a b", ".."] {
        let req = StartRequest { owner: owner.into(), kind: Kind::User, repo_admin: false };
        assert!(t.setup.start(req, &[]).await.is_err(), "{owner}");
    }
    assert_eq!(t.setup.view().step, Step::Idle);
}

#[tokio::test]
async fn a_user_start_uses_the_personal_page_and_administration() {
    let t = rig(vec![]);
    let started =
        t.setup.start(StartRequest { owner: "ermish".into(), kind: Kind::User, repo_admin: false }, &[]).await;
    let url = started.unwrap();
    let (_, _, page) = t.get(&url_of(&url)[url_of(&url).find("/start").unwrap()..]).await;
    assert!(page.contains("action=\"https://github.com/settings/apps/new?state="), "{page}");
    assert!(page.contains("administration"), "{page}");
    assert!(!page.contains("organization_self_hosted_runners"), "{page}");
}

#[tokio::test]
async fn repo_admin_restarts_an_attempt_that_had_not_reached_github() {
    let t = rig(vec![]);
    t.start().await;
    let state = t.state();
    let req = StartRequest { owner: "acme".into(), kind: Kind::Org, repo_admin: true };
    let url = t.setup.start(req, &[]).await.unwrap();
    assert_ne!(t.state(), state);
    assert!(t.setup.view().repo_admin);
    let (_, _, page) = t.get(&url_of(&url)[url_of(&url).find("/start").unwrap()..]).await;
    assert!(page.contains("administration") && !page.contains("organization_self_hosted_runners"), "{page}");
}

#[tokio::test]
async fn accounts_are_empty_with_no_gh() {
    let t = rig(vec![]);
    assert_eq!(t.setup.accounts().await, json!({ "login": null, "accounts": [] }));
}

/// A stand-in `gh` that prints per `api <path>`, for the orgs below.
fn fake_gh(dir: &Path, script: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-gh");
    std::fs::write(&path, format!("#!/bin/sh\necho \"$@\" >> {}/gh.log\n{script}\n", dir.display())).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

fn with_gh(t: T, script: &str) -> T {
    let gh = GitHub::new(
        t.http.clone(),
        "https://api.github.com".into(),
        Box::new(FileVault::new(t.secrets.clone())),
        Box::new(FakeSigner),
        || 1_800_000_000,
    );
    let path = fake_gh(t.dir.path(), script);
    let setup = GithubSetup::with_timing(
        gh,
        t.dir.path(),
        crate::hub::Hub::new(),
        path,
        Duration::from_millis(2),
        Duration::from_secs(30),
    );
    T { setup, ..t }
}

#[tokio::test]
async fn accounts_come_from_gh_with_each_orgs_plan() {
    let script = r#"case "$2" in
  user) echo '{"login":"ermish"}' ;;
  user/orgs*) echo '[{"login":"nekko-labs"},{"login":"free-org"},{"login":"hidden-plan"},{"login":"bad name"}]' ;;
  orgs/nekko-labs) echo '{"plan":{"name":"team"}}' ;;
  orgs/free-org) echo '{"plan":{"name":"free"}}' ;;
  orgs/hidden-plan) echo '{}' ;;
  *) exit 1 ;;
esac"#;
    let t = with_gh(rig(vec![]), script);
    assert_eq!(
        t.setup.accounts().await,
        json!({ "login": "ermish", "accounts": [
            { "login": "nekko-labs", "kind": "org", "canGroup": true },
            { "login": "free-org", "kind": "org", "canGroup": false },
            { "login": "hidden-plan", "kind": "org", "canGroup": null },
            { "login": "ermish", "kind": "user", "canGroup": null },
        ] })
    );
}
