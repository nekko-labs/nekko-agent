//! GitHub as the runner's CI service, through a GitHub App the owner made:
//! the App's private key signs a short JWT (RS256, Security.framework), the
//! JWT buys an installation token, and the token registers just-in-time
//! runners. The key lives in the runner vault (`keychain.rs`) and is stored
//! only after GitHub accepted it and the installation passed every check.

use super::keychain::key_name;
use super::provider::{JobRef, Minted, Provider, ProviderError, RunnerStatus};
use super::store::{GithubLink, Link, RunnerRecord};
use super::vm::GITHUB_SEED;
use base64::Engine as _;
use nekko_cloud::vault::Vault;
use nekko_connectors::{Http, Request};
use nekko_runner::{RunnerConfig, RunnerSettings, Scope};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const REVOKED: &str = "GitHub refused this app key. It may have been revoked; connect again with a new key.";
const GONE: &str = "GitHub no longer has this app installation; connect again.";
const NO_KEY: &str = "No GitHub App key is stored for this runner; connect again with its private key.";
const NO_GROUPS: &str = "This org cannot create runner groups. Connect a single repo instead.";
const PKCS1: &str = "The key must be the GitHub App's private key as GitHub downloads it (BEGIN RSA PRIVATE KEY).";
/// Renew an installation token this long before it expires.
const TOKEN_MARGIN: u64 = 300;

/// RS256 over `msg` with a PKCS#1 PEM private key.
pub trait Signer: Send + Sync {
    fn rs256(&self, pem: &str, msg: &[u8]) -> Result<Vec<u8>, String>;
}

/// Security.framework's RSA, so no crypto crate is added.
pub struct SecKeySigner;

impl Signer for SecKeySigner {
    #[cfg(target_os = "macos")]
    fn rs256(&self, pem: &str, msg: &[u8]) -> Result<Vec<u8>, String> {
        use core_foundation::base::TCFType;
        use core_foundation::data::CFData;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;
        use security_framework::key::{Algorithm, SecKey};
        use security_framework_sys::item::{
            kSecAttrKeyClass, kSecAttrKeyClassPrivate, kSecAttrKeyType, kSecAttrKeyTypeRSA,
        };

        let der = pkcs1_der(pem)?;
        // SAFETY: the kSecAttr constants are static CFStrings; get-rule wrapping retains them.
        let attrs = unsafe {
            CFDictionary::from_CFType_pairs(&[
                (CFString::wrap_under_get_rule(kSecAttrKeyType), CFString::wrap_under_get_rule(kSecAttrKeyTypeRSA)),
                (
                    CFString::wrap_under_get_rule(kSecAttrKeyClass),
                    CFString::wrap_under_get_rule(kSecAttrKeyClassPrivate),
                ),
            ])
        };
        let data = CFData::from_buffer(&der);
        let mut err = std::ptr::null_mut();
        // SAFETY: valid CFData and CFDictionary; the result follows the create rule.
        let key = unsafe {
            security_framework_sys::key::SecKeyCreateWithData(
                data.as_concrete_TypeRef(),
                attrs.as_concrete_TypeRef(),
                &mut err,
            )
        };
        if key.is_null() {
            if !err.is_null() {
                // SAFETY: an error out-parameter follows the create rule.
                drop(unsafe { core_foundation::error::CFError::wrap_under_create_rule(err) });
            }
            return Err("This is not a readable RSA private key.".into());
        }
        // SAFETY: non-null, owned by us.
        let key = unsafe { SecKey::wrap_under_create_rule(key) };
        key.create_signature(Algorithm::RSASignatureMessagePKCS1v15SHA256, msg)
            .map_err(|e| format!("Signing with the app key failed: {e}"))
    }

    #[cfg(not(target_os = "macos"))]
    fn rs256(&self, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        Err("Signing GitHub App requests needs macOS.".into())
    }
}

/// The DER inside a `BEGIN RSA PRIVATE KEY` PEM; anything else is refused.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pkcs1_der(pem: &str) -> Result<Vec<u8>, String> {
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN RSA PRIVATE KEY-----")
        .and_then(|b| b.strip_suffix("-----END RSA PRIVATE KEY-----"))
        .ok_or(PKCS1)?;
    let b64: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| PKCS1.to_string())
}

/// What the connect sheet sends.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub provider: String,
    pub scope: Scope,
    pub app_id: u64,
    pub installation_id: u64,
    #[serde(default)]
    pub private_key_pem: Option<String>,
    #[serde(default)]
    pub repos: Vec<String>,
    #[serde(default)]
    pub allow_public: bool,
    #[serde(default)]
    pub label: Option<String>,
}

type Tokens = HashMap<(u64, u64), (String, u64)>;

impl std::fmt::Debug for ConnectRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectRequest")
            .field("provider", &self.provider)
            .field("scope", &self.scope)
            .field("app_id", &self.app_id)
            .field("installation_id", &self.installation_id)
            .field("private_key_pem", &self.private_key_pem.as_ref().map(|_| "(redacted)"))
            .field("repos", &self.repos)
            .field("allow_public", &self.allow_public)
            .field("label", &self.label)
            .finish()
    }
}

pub struct GitHub<H: Http> {
    http: Arc<H>,
    api: String,
    vault: Arc<dyn Vault>,
    signer: Arc<dyn Signer>,
    now: fn() -> u64,
    /// (app id, installation id) to (token, expires at).
    tokens: Arc<Mutex<Tokens>>,
}

impl<H: Http> Clone for GitHub<H> {
    fn clone(&self) -> Self {
        GitHub {
            http: self.http.clone(),
            api: self.api.clone(),
            vault: self.vault.clone(),
            signer: self.signer.clone(),
            now: self.now,
            tokens: self.tokens.clone(),
        }
    }
}

/// `[A-Za-z0-9._-]{1,max}`: a label, an owner, an org or a repo name.
pub(super) fn plain_name(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && s != ".."
        && s != "."
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn other(what: &str, status: u16, v: &Value) -> ProviderError {
    let msg = v["message"].as_str().unwrap_or("no message");
    ProviderError::Other(format!("GitHub refused {what} ({status}: {msg})"))
}

/// Exactly `<prefix><unix secs>-<n>`, so a longer host name sharing the prefix never matches.
pub(super) fn is_ours(name: &str, prefix: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    name.strip_prefix(prefix).and_then(|rest| rest.split_once('-')).is_some_and(|(a, b)| digits(a) && digits(b))
}

/// The record's GitHub link; a GitLab record never reaches here through `ByLink`.
fn link(r: &RunnerRecord) -> Result<&GithubLink, ProviderError> {
    r.github().ok_or_else(|| ProviderError::Other(format!("runner {} is not a GitHub runner", r.config.id)))
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

/// `/repos/<o>/<r>` or `/orgs/<org>`.
fn base(scope: &Scope) -> String {
    match scope {
        Scope::Repo { owner, repo } => format!("/repos/{owner}/{repo}"),
        Scope::Org { org } => format!("/orgs/{org}"),
    }
}

fn labels(r: &RunnerRecord) -> [String; 4] {
    ["self-hosted".into(), "macOS".into(), "ARM64".into(), r.config.label.clone()]
}

impl<H: Http> GitHub<H> {
    pub fn new(http: H, api: String, vault: Box<dyn Vault>, signer: Box<dyn Signer>, now: fn() -> u64) -> Self {
        GitHub {
            http: Arc::new(http),
            api: api.trim_end_matches('/').to_string(),
            vault: Arc::from(vault),
            signer: Arc::from(signer),
            now,
            tokens: Arc::default(),
        }
    }

    pub fn vault(&self) -> Arc<dyn Vault> {
        self.vault.clone()
    }

    /// The App JWT, signed with the stored key.
    pub fn app_jwt(&self, app_id: u64) -> Result<String, ProviderError> {
        let pem = self.vault.get(&key_name(app_id)).ok_or_else(|| ProviderError::Auth(NO_KEY.into()))?;
        self.jwt(app_id, &pem)
    }

    fn jwt(&self, app_id: u64, pem: &str) -> Result<String, ProviderError> {
        let now = (self.now)();
        let head = b64url(br#"{"alg":"RS256","typ":"JWT"}"#);
        let body = b64url(
            json!({ "iat": now.saturating_sub(60), "exp": now + 540, "iss": app_id.to_string() })
                .to_string()
                .as_bytes(),
        );
        let input = format!("{head}.{body}");
        let sig = self.signer.rs256(pem, input.as_bytes()).map_err(ProviderError::Auth)?;
        Ok(format!("{input}.{}", b64url(&sig)))
    }

    async fn api(
        &self,
        method: &str,
        path: &str,
        auth: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), ProviderError> {
        let url = format!("{}{path}", self.api);
        let bearer = format!("Bearer {auth}");
        let mut h = vec![
            ("Accept", "application/vnd.github+json"),
            ("X-GitHub-Api-Version", "2022-11-28"),
            ("User-Agent", "nekko-agent"),
            ("Authorization", bearer.as_str()),
        ];
        let body = body.map(|b| b.to_string());
        if body.is_some() {
            h.push(("Content-Type", "application/json"));
        }
        let req = match method {
            "POST" => Request::post(url, &h, body),
            "PATCH" => Request::patch(url, &h, body),
            "PUT" => Request::put(url, &h, body),
            "DELETE" => Request::delete(url, &h),
            _ => Request::get(url, &h),
        };
        let res = self.http.send(req).await.map_err(|e| ProviderError::Other(format!("GitHub did not answer: {e}")))?;
        Ok((res.status, serde_json::from_str(&res.body).unwrap_or(Value::Null)))
    }

    /// A fresh installation token, minted with `pem`, and when it expires.
    /// Not cached: a connect that later fails must leave nothing behind.
    async fn fetch_token(&self, app_id: u64, installation_id: u64, pem: &str) -> Result<(String, u64), ProviderError> {
        let jwt = self.jwt(app_id, pem)?;
        let path = format!("/app/installations/{installation_id}/access_tokens");
        let (status, v) = self.api("POST", &path, &jwt, None).await?;
        match status {
            // A rate limit is a 403 too, and passes. shortcut: `Response` carries no headers, so it is
            // recognized by GitHub's message ("API rate limit exceeded", "secondary rate limit").
            403 if v["message"].as_str().is_some_and(|m| m.to_ascii_lowercase().contains("rate limit")) => {
                return Err(other("an installation token", status, &v));
            }
            401 | 403 => return Err(ProviderError::Auth(REVOKED.into())),
            404 => return Err(ProviderError::Auth(GONE.into())),
            s if !ok(s) => return Err(other("an installation token", s, &v)),
            _ => {}
        }
        let token = v["token"].as_str().ok_or_else(|| other("an installation token", status, &v))?.to_string();
        // An unreadable expiry counts as a short one.
        let expires = v["expires_at"]
            .as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map_or((self.now)() + 600, |t| t.timestamp().max(0) as u64);
        Ok((token, expires))
    }

    /// The installation token, cached until `TOKEN_MARGIN` before it expires.
    pub async fn installation_token(&self, link: &GithubLink) -> Result<String, ProviderError> {
        let key = (link.app_id, link.installation_id);
        let cached = self.tokens.lock().ok().and_then(|c| c.get(&key).cloned());
        if let Some((t, exp)) = cached
            && (self.now)() + TOKEN_MARGIN < exp
        {
            return Ok(t);
        }
        let pem = self.vault.get(&key_name(link.app_id)).ok_or_else(|| ProviderError::Auth(NO_KEY.into()))?;
        let (token, expires) = self.fetch_token(link.app_id, link.installation_id, &pem).await?;
        if let Ok(mut c) = self.tokens.lock() {
            c.insert(key, (token.clone(), expires));
        }
        Ok(token)
    }

    async fn call(
        &self,
        r: &RunnerRecord,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), ProviderError> {
        let token = self.installation_token(link(r)?).await?;
        self.api(method, path, &token, body).await
    }

    /// Checks the installation, its repos and (org scope) the runner group,
    /// then stores the key. Any failure leaves nothing stored or registered.
    pub async fn connect(&self, req: ConnectRequest, network: Option<String>) -> Result<RunnerRecord, String> {
        if req.provider != "github" {
            return Err("Only GitHub runners are supported.".into());
        }
        let label = req.label.clone().unwrap_or_else(|| "nekko-cloud-mac".into());
        if !plain_name(&label, 64) {
            return Err("The label may use letters, digits, '.', '_' and '-' only (at most 64).".into());
        }
        let (owner, repos) = match &req.scope {
            Scope::Repo { owner, repo } => {
                if !plain_name(owner, 100) || !plain_name(repo, 100) {
                    return Err("That is not a GitHub owner and repo name.".into());
                }
                (owner.clone(), vec![format!("{owner}/{repo}")])
            }
            Scope::Org { org } => {
                if !plain_name(org, 100) {
                    return Err("That is not a GitHub org name.".into());
                }
                if req.repos.is_empty() {
                    return Err("Choose at least one repo for an org runner.".into());
                }
                let mut full = Vec::new();
                for r in &req.repos {
                    let name = match r.split_once('/') {
                        Some((o, n)) if o.eq_ignore_ascii_case(org) => n,
                        Some(_) => return Err(format!("{r} is not in {org}.")),
                        None => r.as_str(),
                    };
                    if !plain_name(name, 100) {
                        return Err(format!("{r} is not a repo name."));
                    }
                    full.push(format!("{org}/{name}"));
                }
                (org.clone(), full)
            }
        };
        let given = match &req.private_key_pem {
            Some(pem) => {
                let pem = pem.trim();
                if pem.len() >= 16 * 1024 || !pem.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
                    return Err(PKCS1.into());
                }
                Some(format!("{pem}\n"))
            }
            None => None,
        };
        let pem = given.clone().or_else(|| self.vault.get(&key_name(req.app_id))).ok_or(NO_KEY)?;
        let (token, _) = self.fetch_token(req.app_id, req.installation_id, &pem).await.map_err(|e| e.to_string())?;

        let jwt = self.jwt(req.app_id, &pem).map_err(|e| e.to_string())?;
        let (status, v) = self
            .api("GET", &format!("/app/installations/{}", req.installation_id), &jwt, None)
            .await
            .map_err(|e| e.to_string())?;
        if !ok(status) {
            return Err(other("the installation", status, &v).to_string());
        }
        let login = v["account"]["login"].as_str().unwrap_or_default();
        if !login.eq_ignore_ascii_case(&owner) {
            return Err(format!("This app installation belongs to {login}, not {owner}. Install the app on {owner}."));
        }

        let mut ids = Vec::new();
        for full in &repos {
            let (status, v) =
                self.api("GET", &format!("/repos/{full}"), &token, None).await.map_err(|e| e.to_string())?;
            if !ok(status) {
                return Err(format!("{full} is not reachable with this app installation."));
            }
            if v["private"].as_bool() != Some(true) && !req.allow_public {
                return Err(format!(
                    "{full} is public. Anyone can open a pull request there, and its jobs would run on this Mac; allow public repos to connect it anyway."
                ));
            }
            ids.push(v["id"].as_u64().ok_or_else(|| format!("GitHub gave no id for {full}."))?);
        }

        let group_id = match &req.scope {
            Scope::Repo { .. } => None,
            Scope::Org { org } => Some(self.ensure_group(org, &label, &ids, req.allow_public, &token).await?),
        };

        if let Some(pem) = &given {
            self.vault.set(&key_name(req.app_id), pem)?;
        }
        let mut id = [0u8; 6];
        let _ = getrandom::fill(&mut id);
        let settings =
            RunnerSettings { enabled: true, trusted_networks: network.into_iter().collect(), ..Default::default() };
        Ok(RunnerRecord {
            config: RunnerConfig {
                id: format!("gh-{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>()),
                scope: req.scope,
                label,
                settings: settings.sanitized(),
            },
            link: Link::Github(GithubLink {
                app_id: req.app_id,
                installation_id: req.installation_id,
                group_id,
                repos,
                allow_public: req.allow_public,
            }),
            image: None,
        })
    }

    /// The `nekko-<label>` runner group limited to `ids`; never the Default group.
    async fn ensure_group(
        &self,
        org: &str,
        label: &str,
        ids: &[u64],
        allow_public: bool,
        token: &str,
    ) -> Result<u64, String> {
        let name = format!("nekko-{label}");
        let groups = format!("/orgs/{org}/actions/runner-groups");
        let check = |r: Result<(u16, Value), ProviderError>| -> Result<Value, String> {
            match r.map_err(|e| e.to_string())? {
                (403 | 404, _) => Err(NO_GROUPS.into()),
                (s, v) if !ok(s) => Err(other("the runner group", s, &v).to_string()),
                (_, v) => Ok(v),
            }
        };
        // shortcut: only the first 100 groups are read; page if an org ever has more.
        let list = check(self.api("GET", &format!("{groups}?per_page=100"), token, None).await)?;
        let existing = list["runner_groups"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|g| g["name"].as_str() == Some(name.as_str()))
            .and_then(|g| Some((g["id"].as_u64()?, g)));
        if let Some((id, group)) = existing {
            // GitHub requires `name` and resets an omitted `restricted_to_workflows` to false, so the
            // owner's "Selected workflows" restriction is sent back as it was.
            let mut patch = json!({
                "name": name,
                "visibility": "selected",
                "allows_public_repositories": allow_public,
                "restricted_to_workflows": group["restricted_to_workflows"].as_bool().unwrap_or(false),
            });
            if group["selected_workflows"].is_array() {
                patch["selected_workflows"] = group["selected_workflows"].clone();
            }
            check(self.api("PATCH", &format!("{groups}/{id}"), token, Some(patch)).await)?;
            let repos = json!({ "selected_repository_ids": ids });
            check(self.api("PUT", &format!("{groups}/{id}/repositories"), token, Some(repos)).await)?;
            return Ok(id);
        }
        let body = json!({
            "name": name,
            "visibility": "selected",
            "selected_repository_ids": ids,
            "allows_public_repositories": allow_public,
        });
        let v = check(self.api("POST", &groups, token, Some(body)).await)?;
        v["id"].as_u64().ok_or_else(|| "GitHub gave no id for the runner group.".into())
    }

    /// Runs of `status` in each of the record's repos, with their latest jobs.
    async fn jobs(&self, r: &RunnerRecord, status: &str) -> Result<Vec<(String, Value, Value)>, ProviderError> {
        let mut out = Vec::new();
        for repo in &link(r)?.repos {
            let (s, v) =
                self.call(r, "GET", &format!("/repos/{repo}/actions/runs?status={status}&per_page=10"), None).await?;
            if !ok(s) {
                return Err(other("the workflow runs", s, &v));
            }
            for run in v["workflow_runs"].as_array().into_iter().flatten() {
                let Some(id) = run["id"].as_u64() else { continue };
                let path = format!("/repos/{repo}/actions/runs/{id}/jobs?filter=latest&per_page=100");
                let (s, jobs) = self.call(r, "GET", &path, None).await?;
                if !ok(s) {
                    return Err(other("the jobs", s, &jobs));
                }
                for job in jobs["jobs"].as_array().into_iter().flatten() {
                    out.push((repo.clone(), run.clone(), job.clone()));
                }
            }
        }
        Ok(out)
    }
}

impl<H: Http + 'static> Provider for GitHub<H> {
    async fn mint(&self, r: &RunnerRecord, name: &str) -> Result<Minted, ProviderError> {
        // A repo can go public after connect: check again before a job of a stranger's PR could land here.
        if let (Scope::Repo { owner, repo }, false) = (&r.config.scope, link(r)?.allow_public) {
            let full = format!("{owner}/{repo}");
            let (s, v) = self.call(r, "GET", &format!("/repos/{full}"), None).await?;
            if !ok(s) {
                return Err(other("the repo", s, &v));
            }
            if v["private"].as_bool() != Some(true) {
                return Err(ProviderError::Auth(format!(
                    "{full} is public. Anyone can open a pull request there, and its jobs would run on this Mac; allow public repos to run it anyway."
                )));
            }
        }
        let group = match (&r.config.scope, link(r)?.group_id) {
            (Scope::Repo { .. }, _) => 1,
            (Scope::Org { .. }, Some(g)) => g,
            (Scope::Org { .. }, None) => {
                return Err(ProviderError::Auth("This org runner has no runner group; connect again.".into()));
            }
        };
        let body = json!({ "name": name, "runner_group_id": group, "labels": labels(r), "work_folder": "_work" });
        let path = format!("{}/actions/runners/generate-jitconfig", base(&r.config.scope));
        let (s, v) = self.call(r, "POST", &path, Some(body)).await?;
        match (ok(s), v["runner"]["id"].as_u64(), v["encoded_jit_config"].as_str()) {
            (true, Some(runner_id), Some(jit)) => {
                Ok(Minted { runner_id, seed_file: GITHUB_SEED, jit_config: jit.to_string() })
            }
            _ => Err(other("a runner registration", s, &v)),
        }
    }

    async fn status(&self, r: &RunnerRecord, runner_id: u64) -> Result<RunnerStatus, ProviderError> {
        let path = format!("{}/actions/runners/{runner_id}", base(&r.config.scope));
        match self.call(r, "GET", &path, None).await? {
            (404, _) => Ok(RunnerStatus::Missing),
            (s, v) if !ok(s) => Err(other("the runner's status", s, &v)),
            (_, v) => Ok(match (v["status"].as_str(), v["busy"].as_bool()) {
                (Some("online"), Some(true)) => RunnerStatus::Busy,
                (Some("online"), _) => RunnerStatus::Idle,
                _ => RunnerStatus::Offline,
            }),
        }
    }

    /// `None` for a runner that has not taken a job (never, or not yet).
    async fn job(&self, r: &RunnerRecord, _runner_id: u64, runner_name: &str) -> Result<Option<JobRef>, ProviderError> {
        Ok(self.jobs(r, "in_progress").await?.into_iter().find_map(|(repo, run, job)| {
            (job["runner_name"].as_str() == Some(runner_name)).then(|| JobRef {
                repo,
                run_id: run["id"].as_u64().unwrap_or_default(),
                job_id: job["id"].as_u64().unwrap_or_default(),
                workflow: run["name"].as_str().unwrap_or_default().to_string(),
                job: job["name"].as_str().unwrap_or_default().to_string(),
            })
        }))
    }

    async fn queued(&self, r: &RunnerRecord) -> Result<u32, ProviderError> {
        let ours = labels(r);
        let n = self
            .jobs(r, "queued")
            .await?
            .iter()
            .filter(|(_, _, job)| job["status"].as_str() == Some("queued"))
            .filter(|(_, _, job)| {
                let want = job["labels"].as_array().cloned().unwrap_or_default();
                // GitHub matches labels in any case.
                !want.is_empty()
                    && want.iter().all(|l| l.as_str().is_some_and(|l| ours.iter().any(|o| o.eq_ignore_ascii_case(l))))
            })
            .count();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    async fn remove(&self, r: &RunnerRecord, runner_id: u64) -> Result<(), ProviderError> {
        let path = format!("{}/actions/runners/{runner_id}", base(&r.config.scope));
        match self.call(r, "DELETE", &path, None).await? {
            (s, _) if ok(s) || s == 404 => Ok(()),
            (s, v) => Err(other("removing the runner", s, &v)),
        }
    }

    async fn remove_stale(&self, r: &RunnerRecord, name_prefix: &str) -> Result<u32, ProviderError> {
        let runners = format!("{}/actions/runners", base(&r.config.scope));
        // shortcut: only the first 100 registrations are read; page if a scope ever has more.
        let (s, v) = self.call(r, "GET", &format!("{runners}?per_page=100"), None).await?;
        if !ok(s) {
            return Err(other("the runner list", s, &v));
        }
        let mut removed = 0;
        for x in v["runners"].as_array().into_iter().flatten() {
            let ours = x["name"].as_str().is_some_and(|n| is_ours(n, name_prefix));
            if let (true, Some("offline"), Some(id)) = (ours, x["status"].as_str(), x["id"].as_u64()) {
                self.remove(r, id).await?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    async fn rerun(&self, r: &RunnerRecord, job: &JobRef) -> Result<(), ProviderError> {
        let path = format!("/repos/{}/actions/jobs/{}/rerun", job.repo, job.job_id);
        match self.call(r, "POST", &path, None).await? {
            (s, _) if ok(s) => Ok(()),
            (s, v) => Err(other("the re-run", s, &v)),
        }
    }
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;
