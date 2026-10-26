//! GitLab (gitlab.com or self-managed) as the runner's CI service, through a
//! personal, project or group access token the owner pasted at connect. Each
//! VM gets its own locked, tagged runner (`POST /user/runners`); its `glrt-`
//! token reaches the guest only inside `gitlab-runner.toml` on the seed.

use super::github::is_ours;
use super::keychain::token_key;
use super::provider::{JobRef, Minted, Provider, ProviderError, RunnerStatus};
use super::store::{GitlabLink, RunnerRecord};
use super::vm::GITLAB_SEED;
use nekko_cloud::vault::Vault;
use nekko_connectors::js::encode_uri_component as enc;
use nekko_connectors::{Http, Request};
use nekko_runner::Scope;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;

const NO_TOKEN: &str = "The GitLab access token is missing; connect again.";
pub const REFUSED: &str =
    "GitLab refused this access token. It may have expired or been revoked; connect again with a new token.";
const NO_CREATE: &str = "GitLab would not create a runner here. The token needs the create_runner and manage_runner scopes and you need the Owner role.";
const NO_MANAGE: &str = "GitLab would not pause, list or remove this runner. The token needs the manage_runner scope; connect again with one that has it.";
/// How long a branch's or tag's protected answer is trusted.
const BRANCH_TTL: u64 = 600;
const PAGE: usize = 100;
const MAX_PAGES: u32 = 10;

/// (project path, `branches/<ref>` or `tags/<ref>`) to (protected, checked at).
type Branches = HashMap<(String, String), (bool, u64)>;

pub struct GitLab<H: Http> {
    http: H,
    vault: Box<dyn Vault>,
    now: fn() -> u64,
    branches: Mutex<Branches>,
}

/// A TOML basic string.
fn toml_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The guest's `config.toml`: one shell runner with this runner's token.
pub fn runner_toml(base_url: &str, glrt: &str) -> String {
    format!(
        "concurrent = 1\n\n[[runners]]\n  name = \"nekko\"\n  url = {}\n  token = {}\n  executor = \"shell\"\n  shell = \"bash\"\n  builds_dir = \"/Users/runner/builds\"\n  cache_dir = \"/Users/runner/cache\"\n",
        toml_str(base_url),
        toml_str(glrt)
    )
}

pub fn tag_list(label: &str) -> String {
    format!("{label},macos,arm64")
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

/// 401 is always the token; anything else not 2xx is passed on by status only.
fn refused(status: u16) -> ProviderError {
    if status == 401 {
        ProviderError::Auth(REFUSED.into())
    } else {
        ProviderError::Other(format!("GitLab answered {status}"))
    }
}

/// For the calls that need manage_runner: 403 means the token lacks it.
fn unmanaged(status: u16) -> ProviderError {
    if status == 403 { ProviderError::Auth(NO_MANAGE.into()) } else { refused(status) }
}

fn link(r: &RunnerRecord) -> Result<&GitlabLink, ProviderError> {
    r.gitlab().ok_or_else(|| ProviderError::Other(format!("runner {} is not a GitLab runner", r.config.id)))
}

/// The project paths whose pending jobs this record can take.
fn projects(r: &RunnerRecord, l: &GitlabLink) -> Vec<String> {
    match &r.config.scope {
        Scope::Repo { owner, repo } => vec![format!("{owner}/{repo}")],
        Scope::Org { .. } => l.projects.clone(),
    }
}

impl<H: Http> GitLab<H> {
    pub fn new(http: H, vault: Box<dyn Vault>, now: fn() -> u64) -> Self {
        GitLab { http, vault, now, branches: Mutex::default() }
    }

    /// `<base>/api/v4<path>` with the record's access token.
    async fn call(
        &self,
        r: &RunnerRecord,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), ProviderError> {
        let base = link(r)?.base_url.trim_end_matches('/');
        let token = self.vault.get(&token_key(&r.config.id)).ok_or_else(|| ProviderError::Auth(NO_TOKEN.into()))?;
        let url = format!("{base}/api/v4{path}");
        let mut h = vec![("PRIVATE-TOKEN", token.as_str()), ("User-Agent", "nekko-agent")];
        let body = body.map(|b| b.to_string());
        if body.is_some() {
            h.push(("Content-Type", "application/json"));
        }
        let req = match method {
            "POST" => Request::post(url, &h, body),
            "PUT" => Request::put(url, &h, body),
            "DELETE" => Request::delete(url, &h),
            _ => Request::get(url, &h),
        };
        let res = self.http.send(req).await.map_err(|e| ProviderError::Other(format!("GitLab did not answer: {e}")))?;
        Ok((res.status, serde_json::from_str(&res.body).unwrap_or(Value::Null)))
    }

    /// Like `call`, but anything not 2xx is an error.
    async fn get(&self, r: &RunnerRecord, path: &str) -> Result<Value, ProviderError> {
        match self.call(r, "GET", path, None).await? {
            (s, v) if ok(s) => Ok(v),
            (s, _) => Err(refused(s)),
        }
    }

    async fn running(&self, r: &RunnerRecord, runner_id: u64) -> Result<Option<Value>, ProviderError> {
        let v = self.get(r, &format!("/runners/{runner_id}/jobs?status=running&per_page=1")).await?;
        Ok(v.as_array().and_then(|a| a.first()).cloned())
    }

    /// Whether runner `id` belongs to group `group_id` itself. A group's list
    /// also holds its ancestors' runners, which are never ours to delete;
    /// any doubt answers no.
    async fn in_group(&self, r: &RunnerRecord, id: u64, group_id: u64) -> bool {
        match self.call(r, "GET", &format!("/runners/{id}"), None).await {
            Ok((s, v)) if ok(s) => {
                v["groups"].as_array().into_iter().flatten().any(|g| g["id"].as_u64() == Some(group_id))
            }
            _ => false,
        }
    }

    /// Whether `git_ref` is a protected branch (or tag) of `project`, cached for `BRANCH_TTL`.
    // shortcut: the protected-branch cache is per process and 10 min old at worst, a newly protected branch may wait that long
    async fn protected(
        &self,
        r: &RunnerRecord,
        project: &str,
        git_ref: &str,
        tag: bool,
    ) -> Result<bool, ProviderError> {
        let kind = if tag { "tags" } else { "branches" };
        let key = (project.to_string(), format!("{kind}/{git_ref}"));
        let now = (self.now)();
        let cached = self.branches.lock().ok().and_then(|mut c| {
            c.retain(|_, (_, at)| now < *at + BRANCH_TTL);
            c.get(&key).copied()
        });
        if let Some((p, _)) = cached {
            return Ok(p);
        }
        let path = format!("/projects/{}/repository/{kind}/{}", enc(project), enc(git_ref));
        let p = match self.call(r, "GET", &path, None).await? {
            (404, _) => false,
            (s, v) if ok(s) => v["protected"].as_bool() == Some(true),
            (s, _) => return Err(refused(s)),
        };
        if let Ok(mut c) = self.branches.lock() {
            c.insert(key, (p, now));
        }
        Ok(p)
    }
}

#[cfg(test)]
impl<H: Http> GitLab<H> {
    fn refs_cached(&self) -> usize {
        self.branches.lock().map_or(0, |c| c.len())
    }
}

impl<H: Http + 'static> Provider for GitLab<H> {
    async fn mint(&self, r: &RunnerRecord, name: &str) -> Result<Minted, ProviderError> {
        let l = link(r)?;
        let mut body = match &r.config.scope {
            Scope::Repo { .. } => json!({ "runner_type": "project_type", "project_id": l.namespace_id }),
            Scope::Org { .. } => json!({ "runner_type": "group_type", "group_id": l.namespace_id }),
        };
        let fields = json!({
            "description": name,
            "paused": false,
            "locked": true,
            "run_untagged": false,
            "tag_list": tag_list(&r.config.label),
            "access_level": if l.protected_only { "ref_protected" } else { "not_protected" },
            "maximum_timeout": u64::from(r.config.settings.max_job_minutes) * 60,
        });
        if let (Some(b), Some(f)) = (body.as_object_mut(), fields.as_object()) {
            b.extend(f.clone());
        }
        let (s, v) = self.call(r, "POST", "/user/runners", Some(body)).await?;
        if s == 403 {
            return Err(ProviderError::Auth(NO_CREATE.into()));
        }
        if !ok(s) {
            return Err(refused(s));
        }
        let id = v["id"].as_u64().ok_or_else(|| ProviderError::Other("GitLab gave no runner id".into()))?;
        match v["token"].as_str() {
            Some(t) if t.starts_with("glrt-") => {
                Ok(Minted { runner_id: id, seed_file: GITLAB_SEED, jit_config: runner_toml(&l.base_url, t) })
            }
            // Never echo what came back: it may still be a credential.
            _ => {
                let _ = self.remove(r, id).await;
                Err(ProviderError::Other("GitLab gave a runner token in an unknown format".into()))
            }
        }
    }

    async fn status(&self, r: &RunnerRecord, runner_id: u64) -> Result<RunnerStatus, ProviderError> {
        let v = match self.call(r, "GET", &format!("/runners/{runner_id}"), None).await? {
            (404, _) => return Ok(RunnerStatus::Missing),
            (s, v) if ok(s) => v,
            (s, _) => return Err(refused(s)),
        };
        // A runner we paused reports "paused" while its job still runs.
        if !matches!(v["status"].as_str(), Some("online" | "paused")) {
            return Ok(RunnerStatus::Offline);
        }
        if self.running(r, runner_id).await?.is_none() {
            return Ok(RunnerStatus::Idle);
        }
        // Paused once busy, so a token read out of the guest takes no second job.
        if v["paused"].as_bool() != Some(true) {
            match self.call(r, "PUT", &format!("/runners/{runner_id}"), Some(json!({ "paused": true }))).await? {
                (s, _) if ok(s) => {}
                (s, _) => return Err(unmanaged(s)),
            }
        }
        Ok(RunnerStatus::Busy)
    }

    async fn job(&self, r: &RunnerRecord, runner_id: u64, _runner_name: &str) -> Result<Option<JobRef>, ProviderError> {
        // No id, no job: a re-run of job 0 would only fail.
        Ok(self.running(r, runner_id).await?.and_then(|j| {
            Some(JobRef {
                repo: j["project"]["path_with_namespace"].as_str().unwrap_or_default().to_string(),
                run_id: j["pipeline"]["id"].as_u64().unwrap_or_default(),
                job_id: j["id"].as_u64()?,
                workflow: j["ref"].as_str().unwrap_or_default().to_string(),
                job: j["name"].as_str().unwrap_or_default().to_string(),
            })
        }))
    }

    async fn queued(&self, r: &RunnerRecord) -> Result<u32, ProviderError> {
        let l = link(r)?;
        let tags = tag_list(&r.config.label);
        let ours: Vec<&str> = tags.split(',').collect();
        let mut n = 0u32;
        let group = matches!(r.config.scope, Scope::Org { .. });
        let list = projects(r, l);
        let mut unread = 0;
        let mut last = 0;
        for project in &list {
            let project = project.as_str();
            let path = format!("/projects/{}/jobs?scope[]=pending&per_page=100", enc(project));
            let v = match self.call(r, "GET", &path, None).await? {
                (s, v) if ok(s) => v,
                // One project of a group gone or hidden: the others still count.
                (s @ (403 | 404), _) if group => {
                    eprintln!("runner {}: cannot read the jobs of {project} (GitLab answered {s})", r.config.id);
                    (unread, last) = (unread + 1, s);
                    continue;
                }
                (s, _) => return Err(refused(s)),
            };
            for job in v.as_array().into_iter().flatten() {
                let want = job["tag_list"].as_array().cloned().unwrap_or_default();
                let covered = !want.is_empty() && want.iter().all(|t| t.as_str().is_some_and(|t| ours.contains(&t)));
                if !covered {
                    continue;
                }
                // A ref_protected runner never takes a job of an unprotected branch or tag.
                if l.protected_only {
                    let git_ref = job["ref"].as_str().unwrap_or_default();
                    let tag = job["tag"].as_bool() == Some(true);
                    if git_ref.is_empty()
                        || git_ref.starts_with("refs/merge-requests/")
                        || !self.protected(r, project, git_ref, tag).await?
                    {
                        continue;
                    }
                }
                n = n.saturating_add(1);
            }
        }
        // Not one project readable: an error, not an empty queue.
        if unread > 0 && unread == list.len() {
            return Err(refused(last));
        }
        Ok(n)
    }

    async fn remove(&self, r: &RunnerRecord, runner_id: u64) -> Result<(), ProviderError> {
        match self.call(r, "DELETE", &format!("/runners/{runner_id}"), None).await? {
            (s, _) if ok(s) || s == 404 => Ok(()),
            (s, _) => Err(unmanaged(s)),
        }
    }

    /// Every runner of ours in the scope, whatever its status: `start()` already reaped every VM.
    async fn remove_stale(&self, r: &RunnerRecord, name_prefix: &str) -> Result<u32, ProviderError> {
        let l = link(r)?;
        let list = match &r.config.scope {
            Scope::Repo { .. } => format!("/projects/{}/runners?type=project_type", l.namespace_id),
            Scope::Org { .. } => format!("/groups/{}/runners?type=group_type", l.namespace_id),
        };
        let group = matches!(r.config.scope, Scope::Org { .. });
        let mut removed = 0;
        for page in 1..=MAX_PAGES {
            let v = match self.call(r, "GET", &format!("{list}&per_page={PAGE}&page={page}"), None).await? {
                (s, v) if ok(s) => v,
                (s, _) => return Err(unmanaged(s)),
            };
            let runners = v.as_array().cloned().unwrap_or_default();
            for x in &runners {
                let ours = x["description"].as_str().is_some_and(|d| is_ours(d, name_prefix));
                if let (true, Some(id)) = (ours, x["id"].as_u64()) {
                    if group && !self.in_group(r, id, l.namespace_id).await {
                        continue;
                    }
                    self.remove(r, id).await?;
                    removed += 1;
                }
            }
            if runners.len() < PAGE {
                break;
            }
        }
        Ok(removed)
    }

    async fn rerun(&self, r: &RunnerRecord, job: &JobRef) -> Result<(), ProviderError> {
        let path = format!("/projects/{}/jobs/{}/retry", enc(&job.repo), job.job_id);
        match self.call(r, "POST", &path, None).await? {
            (s, _) if ok(s) => Ok(()),
            (s, _) => Err(refused(s)),
        }
    }
}

#[cfg(test)]
#[path = "gitlab_tests.rs"]
mod tests;
