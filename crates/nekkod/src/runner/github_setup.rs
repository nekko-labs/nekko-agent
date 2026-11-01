//! Connecting GitHub with clicks: a one-time local page posts a GitHub App
//! manifest, GitHub hands back the new app's key, and the owner installs it.
//! No key is pasted, and nothing here starts a runner: the sheet's confirm
//! still goes through `runner:connect`.
//!
//! The key is stored the moment GitHub hands it over, beside a pending file,
//! so a closed tab or a quit resumes at Install instead of leaving a dead app.

use super::github::{GitHub, ok, pkcs1_der, plain_name};
use super::keychain::key_name;
use super::provider::ProviderError;
use super::signals::output;
use super::store::{Link, RunnerRecord};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use nekko_automation::workflows::constant_time_eq;
use nekko_connectors::Http;
use nekko_runner::Scope;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::task::AbortHandle;

/// Kept apart from `runner::CHANNELS`, which `Runners::route` handles with records in hand.
pub const CHANNELS: &[&str] = &[
    "runner:githubAccounts",
    "runner:githubStart",
    "runner:githubStatus",
    "runner:githubCancel",
    "runner:setForkApproval",
];
/// Pushed with `GithubSetupView` whenever it changes.
pub const EVENT: &str = "runner:githubChanged";
const GITHUB: &str = "https://github.com";
const DOCS: &str = "https://nekkoagent.com/docs/ci-runners";
/// GitHub's limit on an app's name.
const MAX_NAME: usize = 34;
/// How long a setup waits on GitHub before it lets go of the port and the poll.
const WAIT: Duration = Duration::from_secs(3600);
const POLL_EVERY: Duration = Duration::from_secs(3);
const GH_LIMIT: Duration = Duration::from_secs(10);
const BAD_CONVERSION: &str = "GitHub's answer about the new app was not readable.";
const WAITED: &str = "Setup waited an hour for GitHub and stopped. Start again to carry on.";
const APP_GONE: &str = "That app no longer exists on GitHub. Start again to create a new one.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    User(String),
    Org(String),
}

/// `Nekko Runner <owner> <suffix>`, the owner cut so it fits GitHub's limit.
pub fn app_name(owner: &str, suffix: &str) -> String {
    let room = MAX_NAME.saturating_sub("Nekko Runner  ".len() + suffix.chars().count());
    format!("Nekko Runner {} {suffix}", owner.chars().take(room).collect::<String>())
}

/// What GitHub is asked to create, exactly as the design lists it. An org app
/// stays on the runner permission unless `repo_admin` (an org with no runner groups).
pub fn manifest(owner: &Owner, port: u16, suffix: &str, repo_admin: bool) -> Value {
    let mut permissions = json!({ "actions": "write", "metadata": "read" });
    let extra = match owner {
        Owner::Org(_) if !repo_admin => "organization_self_hosted_runners",
        _ => "administration",
    };
    permissions[extra] = json!("write");
    let name = match owner {
        Owner::User(o) | Owner::Org(o) => o,
    };
    json!({
        "name": app_name(name, suffix),
        "url": DOCS,
        "hook_attributes": { "url": DOCS, "active": false },
        "redirect_url": format!("http://localhost:{port}/created"),
        "setup_url": format!("http://localhost:{port}/installed"),
        "public": false,
        "default_permissions": permissions,
    })
}

pub fn create_url(owner: &Owner, state: &str) -> String {
    match owner {
        Owner::User(_) => format!("{GITHUB}/settings/apps/new?state={state}"),
        Owner::Org(org) => format!("{GITHUB}/organizations/{org}/settings/apps/new?state={state}"),
    }
}

pub fn install_url(slug: &str) -> String {
    format!("{GITHUB}/apps/{slug}/installations/new")
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// GitHub takes a manifest only as a browser form post, so this page posts itself.
pub fn form_page(action: &str, manifest: &Value) -> String {
    let (action, manifest) = (escape(action), escape(&manifest.to_string()));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Nekko Agent</title></head><body>\
         <form method=\"post\" action=\"{action}\"><input type=\"hidden\" name=\"manifest\" value=\"{manifest}\">\
         <button type=\"submit\">Continue to GitHub</button></form>\
         <script>document.forms[0].submit()</script></body></html>"
    )
}

pub struct Converted {
    pub app_id: u64,
    pub slug: String,
    pub pem: String,
}

impl std::fmt::Debug for Converted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Converted")
            .field("app_id", &self.app_id)
            .field("slug", &self.slug)
            .field("pem", &"(redacted)")
            .finish()
    }
}

/// The new app from GitHub's conversion answer. Errors never carry the key.
pub fn parse_conversion(v: &Value) -> Result<Converted, String> {
    let app_id = v["id"].as_u64().filter(|id| *id > 0).ok_or(BAD_CONVERSION)?;
    let slug = v["slug"].as_str().filter(|s| plain_name(s, 100)).ok_or(BAD_CONVERSION)?;
    let pem = v["pem"].as_str().ok_or(BAD_CONVERSION)?;
    pkcs1_der(pem)?;
    Ok(Converted { app_id, slug: slug.to_string(), pem: pem.to_string() })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    #[default]
    Idle,
    Create,
    Install,
    Confirm,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    User,
    Org,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RepoView {
    pub name: String,
    pub private: bool,
}

/// What the sheet shows. `repo_admin` means one repo, under an org or not.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSetupView {
    pub step: Step,
    pub owner: Option<String>,
    pub kind: Option<Kind>,
    pub repo_admin: bool,
    pub slug: Option<String>,
    pub app_id: Option<u64>,
    pub installation_id: Option<u64>,
    pub repos: Vec<RepoView>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub owner: String,
    pub kind: Kind,
    #[serde(default)]
    pub repo_admin: bool,
}

/// `runners/pending-app.json`: an app with a stored key and no runner yet.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingApp {
    app_id: u64,
    slug: String,
    owner: String,
    kind: Kind,
    #[serde(default)]
    repo_admin: bool,
}

#[derive(Default)]
struct Session {
    view: GithubSetupView,
    /// Changes whenever an attempt ends, so late work of an old one changes nothing.
    id: u64,
    /// What GitHub must send back. Taken by the first good callback, so a replay converts nothing.
    state: Option<String>,
    /// The `/start` page's one-use ticket.
    token: Option<String>,
    port: u16,
    suffix: String,
    tasks: Vec<AbortHandle>,
}

impl Session {
    fn owner(&self) -> Option<Owner> {
        let name = self.view.owner.clone()?;
        Some(match self.view.kind? {
            Kind::User => Owner::User(name),
            Kind::Org => Owner::Org(name),
        })
    }
}

enum Poll {
    Waiting,
    Found(u64, Vec<RepoView>),
    /// Waiting longer cannot help; the sentence to show.
    Stop(String),
}

pub struct GithubSetup<H: Http> {
    gh: GitHub<H>,
    pending: PathBuf,
    hub: crate::hub::Hub,
    gh_path: String,
    poll_every: Duration,
    limit: Duration,
    session: Mutex<Session>,
    wake: tokio::sync::Notify,
    /// One start at a time: two clicks must never become two apps.
    op: tokio::sync::Mutex<()>,
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut b = vec![0u8; bytes];
    getrandom::fill(&mut b).map_err(|e| format!("Could not make a random value: {e}"))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn html(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response()
}

fn notice(status: StatusCode, message: &str) -> Response {
    let message = escape(message);
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Nekko Agent</title></head><body><p>{message}</p></body></html>"
    );
    html(status, body)
}

fn not_found() -> Response {
    notice(StatusCode::NOT_FOUND, "This page is gone. Go back to Nekko Agent.")
}

impl<H: Http + 'static> GithubSetup<H> {
    pub fn new(gh: GitHub<H>, runners_dir: &Path, hub: crate::hub::Hub, gh_path: String) -> Arc<Self> {
        Self::with_timing(gh, runners_dir, hub, gh_path, POLL_EVERY, WAIT)
    }

    fn with_timing(
        gh: GitHub<H>,
        runners_dir: &Path,
        hub: crate::hub::Hub,
        gh_path: String,
        poll_every: Duration,
        limit: Duration,
    ) -> Arc<Self> {
        Arc::new(GithubSetup {
            gh,
            pending: runners_dir.join("pending-app.json"),
            hub,
            gh_path,
            poll_every,
            limit,
            session: Mutex::default(),
            wake: tokio::sync::Notify::new(),
            op: tokio::sync::Mutex::new(()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn view(&self) -> GithubSetupView {
        self.lock().view.clone()
    }

    fn publish(&self) {
        self.hub.publish(EVENT, json!(self.view()), false);
    }

    /// Ends the current attempt: its port and poll stop, and its late work changes nothing.
    fn reset(&self) {
        let mut s = self.lock();
        s.tasks.drain(..).for_each(|t| t.abort());
        *s = Session { id: s.id + 1, ..Session::default() };
    }

    fn fail(&self, id: u64, message: &str) {
        {
            let mut s = self.lock();
            if s.id != id {
                return;
            }
            s.tasks.drain(..).for_each(|t| t.abort());
            s.state = None;
            s.token = None;
            s.view.step = Step::Failed;
            s.view.error = Some(message.to_string());
        }
        self.publish();
    }

    /// The time limit. An attempt already at Confirm stays there, it just gives up its port.
    fn expire(&self, id: u64) {
        let waiting = {
            let mut s = self.lock();
            if s.id != id {
                return;
            }
            let waiting = matches!(s.view.step, Step::Create | Step::Install);
            if !waiting {
                s.tasks.drain(..).for_each(|t| t.abort());
            }
            waiting
        };
        if waiting {
            self.fail(id, WAITED);
        }
    }

    fn read_pending(&self) -> Option<PendingApp> {
        serde_json::from_slice(&std::fs::read(&self.pending).ok()?).ok()
    }

    fn has_key(&self, app_id: u64) -> bool {
        self.gh.vault().get(&key_name(app_id)).is_some()
    }

    /// The pending app, if it can still be used; without its key it never can.
    fn usable_pending(&self) -> Option<PendingApp> {
        let app = self.read_pending()?;
        if self.has_key(app.app_id) {
            return Some(app);
        }
        let _ = std::fs::remove_file(&self.pending);
        None
    }

    fn write_pending(&self, app: &PendingApp) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(dir) = self.pending.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.pending.with_extension("json.tmp");
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        file.write_all(&serde_json::to_vec(app)?)?;
        std::fs::rename(&tmp, &self.pending)
    }

    /// An app this owner already has: pending, or saved with a runner and its slug.
    fn saved_app(&self, req: &StartRequest, records: &[RunnerRecord]) -> Option<PendingApp> {
        let pending = self.usable_pending().filter(|p| p.owner.eq_ignore_ascii_case(&req.owner));
        pending
            .or_else(|| {
                records.iter().find_map(|r| {
                    let link = r.github()?;
                    let (owner, org_runner) = match &r.config.scope {
                        Scope::Repo { owner, .. } => (owner, false),
                        Scope::Org { org } => (org, true),
                    };
                    let reusable = owner.eq_ignore_ascii_case(&req.owner) && self.has_key(link.app_id);
                    reusable.then(|| PendingApp {
                        app_id: link.app_id,
                        slug: link.slug.clone().unwrap_or_default(),
                        owner: owner.clone(),
                        kind: if org_runner { Kind::Org } else { req.kind },
                        repo_admin: !org_runner && req.kind == Kind::Org,
                    })
                })
            })
            .filter(|app| !app.slug.is_empty())
    }

    /// Whether the app is installed on `owner` yet, and with which repos.
    async fn find(&self, app_id: u64, owner: &str) -> Poll {
        let jwt = match self.gh.app_jwt(app_id) {
            Ok(jwt) => jwt,
            Err(e) => return Poll::Stop(e.to_string()),
        };
        let Ok((status, list)) = self.gh.api("GET", "/app/installations?per_page=100", &jwt, None).await else {
            return Poll::Waiting;
        };
        if status == 401 {
            // shortcut: `Response` carries no error code, so a deleted app is recognized by GitHub's
            // message ("Integration not found"); any other 401 (a skewed clock) must not lose the app.
            let gone = list["message"].as_str().is_some_and(|m| m.to_ascii_lowercase().contains("not found"));
            if !gone {
                return Poll::Stop(super::github::REVOKED.to_string());
            }
            if self.read_pending().is_some_and(|p| p.app_id == app_id) {
                let _ = std::fs::remove_file(&self.pending);
                self.gh.vault().delete(&key_name(app_id));
            }
            return Poll::Stop(APP_GONE.to_string());
        }
        if !ok(status) {
            return Poll::Waiting;
        }
        let installed = list
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| i["account"]["login"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(owner)));
        let Some(installation) = installed.and_then(|i| i["id"].as_u64()) else { return Poll::Waiting };
        let token = match self.gh.token_for(app_id, installation).await {
            Ok(token) => token,
            Err(ProviderError::Auth(m)) => return Poll::Stop(m),
            Err(ProviderError::Other(_)) => return Poll::Waiting,
        };
        // shortcut: only the first 100 repos are listed; page if an install ever offers more.
        let path = "/installation/repositories?per_page=100";
        let repos = match self.gh.api("GET", path, &token, None).await {
            Ok((status, v)) if ok(status) => v,
            _ => return Poll::Waiting,
        };
        let repos = repos["repositories"].as_array().into_iter().flatten().filter_map(|r| {
            Some(RepoView { name: r["full_name"].as_str()?.to_string(), private: r["private"].as_bool()? })
        });
        Poll::Found(installation, repos.collect())
    }

    /// True when the wait is over, found or failed.
    fn settle(&self, id: u64, poll: Poll) -> bool {
        match poll {
            Poll::Waiting => false,
            Poll::Stop(message) => {
                self.fail(id, &message);
                true
            }
            Poll::Found(installation, repos) => {
                {
                    let mut s = self.lock();
                    if s.id != id {
                        return true;
                    }
                    s.view.step = Step::Confirm;
                    s.view.installation_id = Some(installation);
                    s.view.repos = repos;
                }
                self.publish();
                true
            }
        }
    }

    fn spawn_poll(self: &Arc<Self>, id: u64, app_id: u64, owner: String) {
        let me = self.clone();
        let task = tokio::spawn(async move {
            let end = tokio::time::Instant::now() + me.limit;
            loop {
                tokio::select! {
                    () = tokio::time::sleep(me.poll_every) => {}
                    () = me.wake.notified() => {}
                    () = tokio::time::sleep_until(end) => return me.expire(id),
                }
                if me.lock().id != id || me.settle(id, me.find(app_id, &owner).await) {
                    return;
                }
            }
        });
        self.lock().tasks.push(task.abort_handle());
    }

    /// Picks an app back up at Install, or at Confirm if it is already installed. The URL to open, if any.
    /// shortcut: the app's `setup_url` still names the old port, so after a restart GitHub's last
    /// redirect lands on a dead page. The poll carries on regardless; rebind that port if it bothers anyone.
    async fn resume(self: &Arc<Self>, app: PendingApp) -> Option<String> {
        self.reset();
        let url = install_url(&app.slug);
        let id = {
            let mut s = self.lock();
            s.view = GithubSetupView {
                step: Step::Install,
                owner: Some(app.owner.clone()),
                kind: Some(app.kind),
                repo_admin: app.repo_admin,
                slug: Some(app.slug),
                app_id: Some(app.app_id),
                ..GithubSetupView::default()
            };
            s.id
        };
        if self.settle(id, self.find(app.app_id, &app.owner).await) {
            return None;
        }
        self.publish();
        self.spawn_poll(id, app.app_id, app.owner);
        Some(url)
    }

    /// Serves this attempt's pages on loopback (IPv6 too when it can, since `localhost`
    /// may resolve to either) until the attempt ends or `limit` passes.
    async fn listen(self: &Arc<Self>, id: u64) -> Result<(u16, AbortHandle), String> {
        let unbound = |e: std::io::Error| format!("Could not open a local port: {e}");
        let v4 = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(unbound)?;
        let port = v4.local_addr().map_err(unbound)?.port();
        let v6 = tokio::net::TcpListener::bind(("::1", port)).await.ok();
        let me = self.clone();
        let app = axum::Router::new().fallback(move |uri: Uri| {
            let me = me.clone();
            async move { me.page(uri).await }
        });
        let me = self.clone();
        let task = tokio::spawn(async move {
            let serve = async {
                match v6 {
                    Some(v6) => {
                        let _ = tokio::join!(
                            axum::serve(v4, app.clone()).into_future(),
                            axum::serve(v6, app).into_future()
                        );
                    }
                    None => {
                        let _ = axum::serve(v4, app).await;
                    }
                }
            };
            if tokio::time::timeout(me.limit, serve).await.is_err() {
                me.expire(id);
            }
        });
        Ok((port, task.abort_handle()))
    }

    async fn create(self: &Arc<Self>, req: StartRequest) -> Result<String, String> {
        self.reset();
        let (state, token, suffix) = (random_hex(16)?, random_hex(16)?, random_hex(2)?);
        let id = self.lock().id;
        let (port, task) = self.listen(id).await?;
        {
            let mut s = self.lock();
            s.view = GithubSetupView {
                step: Step::Create,
                owner: Some(req.owner),
                kind: Some(req.kind),
                repo_admin: req.repo_admin,
                ..GithubSetupView::default()
            };
            s.state = Some(state);
            s.token = Some(token.clone());
            s.port = port;
            s.suffix = suffix;
            s.tasks.push(task);
        }
        self.publish();
        Ok(format!("http://localhost:{port}/start?t={token}"))
    }

    /// The URL of the attempt already open for this owner, if there is one.
    /// Pressing the button again carries on: it must never make a second app.
    fn current(&self, req: &StartRequest) -> Option<Option<String>> {
        let mut s = self.lock();
        if !s.view.owner.as_ref().is_some_and(|o| o.eq_ignore_ascii_case(&req.owner)) {
            return None;
        }
        match s.view.step {
            Step::Create if s.view.repo_admin == req.repo_admin => {
                let token = random_hex(16).ok()?;
                let url = format!("http://localhost:{}/start?t={token}", s.port);
                s.token = Some(token);
                Some(Some(url))
            }
            Step::Install => Some(s.view.slug.as_deref().map(install_url)),
            Step::Confirm => Some(None),
            _ => None,
        }
    }

    /// `{ url }`: the page to open, or null when there is nothing to do on GitHub.
    pub async fn start(self: &Arc<Self>, req: StartRequest, records: &[RunnerRecord]) -> Result<Value, String> {
        if !plain_name(&req.owner, 100) {
            return Err("That is not a GitHub account name.".into());
        }
        let _op = self.op.lock().await;
        if let Some(url) = self.current(&req) {
            return Ok(json!({ "url": url }));
        }
        let url = match self.saved_app(&req, records) {
            Some(app) => self.resume(app).await,
            None => Some(self.create(req).await?),
        };
        Ok(json!({ "url": url }))
    }

    /// The sheet asks this when it opens, which is what picks a pending app back up after a restart.
    pub async fn status(self: &Arc<Self>) -> GithubSetupView {
        let _op = self.op.lock().await;
        if self.view().step == Step::Idle
            && let Some(app) = self.usable_pending()
        {
            self.resume(app).await;
        }
        self.view()
    }

    /// Stops waiting. The app and its key stay, so the next start resumes at Install.
    pub fn cancel(&self) -> GithubSetupView {
        self.reset();
        self.publish();
        self.view()
    }

    /// `runner:connect` saved a runner with this app: the setup is done.
    pub fn connected(&self, app_id: u64) {
        if self.read_pending().is_some_and(|p| p.app_id == app_id) {
            let _ = std::fs::remove_file(&self.pending);
        }
        if self.view().app_id == Some(app_id) {
            self.reset();
            self.publish();
        }
    }

    /// Names the app on the record `runner:connect` is saving, so a later connect can reuse it.
    pub fn stamp(&self, rec: &mut RunnerRecord) {
        if let Link::Github(g) = &mut rec.link {
            g.slug = self.slug_for(g.app_id);
        }
    }

    fn slug_for(&self, app_id: u64) -> Option<String> {
        let v = self.view();
        if v.app_id == Some(app_id) {
            return v.slug;
        }
        self.read_pending().filter(|p| p.app_id == app_id).map(|p| p.slug)
    }

    /// One local page. Anything but these answers 404.
    async fn page(self: Arc<Self>, uri: Uri) -> Response {
        let target = uri.path_and_query().map_or("/", |p| p.as_str());
        let Ok(url) = url::Url::parse(&format!("http://localhost{target}")) else { return not_found() };
        let first = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
        match url.path() {
            "/start" => self.form(first("t").as_deref()),
            "/created" => self.created(first("code"), first("state")).await,
            "/installed" => {
                self.wake.notify_one();
                notice(StatusCode::OK, "All set on GitHub. You can close this tab and go back to Nekko Agent.")
            }
            _ => not_found(),
        }
    }

    fn form(&self, ticket: Option<&str>) -> Response {
        let mut s = self.lock();
        let good = matches!((&s.token, ticket), (Some(a), Some(b)) if constant_time_eq(a, b));
        let (true, Some(state), Some(owner)) = (good, s.state.clone(), s.owner()) else { return not_found() };
        s.token = None;
        let manifest = manifest(&owner, s.port, &s.suffix, s.view.repo_admin);
        html(StatusCode::OK, form_page(&create_url(&owner, &state), &manifest))
    }

    /// GitHub's redirect after Create. The key is stored before the browser moves on.
    async fn created(self: Arc<Self>, code: Option<String>, state: Option<String>) -> Response {
        let bad = || notice(StatusCode::BAD_REQUEST, "This link is not valid. Go back to Nekko Agent.");
        let (Some(code), Some(state)) = (code, state) else { return bad() };
        let (id, owner, kind, repo_admin) = {
            let mut s = self.lock();
            let good = s.state.as_deref().is_some_and(|want| constant_time_eq(want, &state));
            // The code goes into a URL path, and only a good state vouches for it.
            if !good || !plain_name(&code, 200) {
                return bad();
            }
            let (Some(owner), Some(kind)) = (s.view.owner.clone(), s.view.kind) else { return bad() };
            s.state = None;
            s.token = None;
            (s.id, owner, kind, s.view.repo_admin)
        };
        let path = format!("/app-manifests/{code}/conversions");
        // GitHub's messages are not repeated here: the code and key must never reach a sentence.
        let converted = match self.gh.api("POST", &path, "", None).await {
            Ok((status, v)) if ok(status) => parse_conversion(&v),
            Ok((status, _)) => Err(format!("GitHub refused the new app ({status}).")),
            Err(_) => Err("GitHub did not answer about the new app.".to_string()),
        };
        let stopped = |message: &str| {
            self.fail(id, message);
            notice(StatusCode::BAD_GATEWAY, &format!("{message} Go back to Nekko Agent."))
        };
        let c = match converted {
            Ok(c) => c,
            Err(message) => return stopped(&message),
        };
        if let Err(e) = self.gh.vault().set(&key_name(c.app_id), &c.pem) {
            return stopped(&format!("Could not save the new app's key: {e}"));
        }
        let app = PendingApp { app_id: c.app_id, slug: c.slug.clone(), owner: owner.clone(), kind, repo_admin };
        if let Err(e) = self.write_pending(&app) {
            // This run still knows the app; only a resume after a restart is lost.
            eprintln!("runner: could not write the pending app: {e}");
        }
        let current = {
            let mut s = self.lock();
            let current = s.id == id;
            if current {
                s.view.step = Step::Install;
                s.view.slug = Some(c.slug.clone());
                s.view.app_id = Some(c.app_id);
            }
            current
        };
        if current {
            self.publish();
            self.spawn_poll(id, c.app_id, owner);
        }
        (StatusCode::SEE_OTHER, [(header::LOCATION, install_url(&c.slug))]).into_response()
    }

    async fn gh_json(&self, path: &str) -> Option<Value> {
        serde_json::from_str(&output(&self.gh_path, &["api", path], GH_LIMIT).await?).ok()
    }

    /// The accounts `gh` is signed in to, orgs first. Empty with no `gh`: the sheet asks for a name.
    /// `canGroup` is null when `gh` cannot see the org's plan.
    pub async fn accounts(&self) -> Value {
        let login = self.gh_json("user").await.and_then(|v| v["login"].as_str().map(str::to_string));
        let Some(login) = login else { return json!({ "login": null, "accounts": [] }) };
        let orgs = self.gh_json("user/orgs?per_page=100").await.unwrap_or_default();
        let mut accounts = Vec::new();
        for org in orgs.as_array().into_iter().flatten().filter_map(|o| o["login"].as_str()) {
            if plain_name(org, 100) {
                let plan = self.gh_json(&format!("orgs/{org}")).await;
                let plan = plan.as_ref().and_then(|v| v["plan"]["name"].as_str());
                accounts.push(json!({ "login": org, "kind": "org", "canGroup": plan.map(|p| p != "free") }));
            }
        }
        accounts.push(json!({ "login": login, "kind": "user", "canGroup": null }));
        json!({ "login": login, "accounts": accounts })
    }
}

#[cfg(test)]
#[path = "github_setup_tests.rs"]
mod tests;
