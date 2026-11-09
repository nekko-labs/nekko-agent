//! Repositories a chat's environment can add (#2404): the ones the user's
//! connected GitHub or GitLab account can reach, with what a clone needs.
//! Unlike `fetch`, which feeds chat context, this keeps the clone URL, the
//! default branch and the host, and never searches issues.

use crate::connectors::gitlab_base;
use crate::http::{Http, Request};
use crate::js::{self, arr, encode_uri_component, string};
use serde_json::{Value, json};

/// The git providers repositories come from.
pub const PROVIDERS: &[&str] = &["github", "gitlab"];

/// GitHub's REST API, overridable for tests.
pub const GITHUB_API: &str = "https://api.github.com";

/// One page of each provider: enough to pick from, and the search narrows it.
const PER_PAGE: u32 = 100;

/// A connected git provider: its kind, token and settings.
pub struct Provider<'a> {
    pub kind: &'a str,
    pub token: &'a str,
    pub settings: Option<&'a Value>,
}

/// The connected git providers among `connectors` (`settings.connectors`).
pub fn connected(connectors: &[Value]) -> Vec<Provider<'_>> {
    connectors
        .iter()
        .filter(|c| nekko_js::truthy(c.get("connected")))
        .filter_map(|c| {
            let kind = c.get("kind").and_then(Value::as_str).filter(|k| PROVIDERS.contains(k))?;
            let token = c.get("token").and_then(Value::as_str).filter(|t| !t.trim().is_empty())?;
            Some(Provider { kind, token, settings: c.get("settings") })
        })
        .collect()
}

/// The origin repositories of a provider clone from, `https://github.com`
/// or the GitLab instance's.
pub fn web_origin(kind: &str, settings: Option<&Value>) -> Result<String, String> {
    match kind {
        "github" => Ok("https://github.com".into()),
        "gitlab" => gitlab_base(settings),
        other => Err(format!("{other} is not a git provider")),
    }
}

fn matches(query: &str, repo: &Value) -> bool {
    let q = query.trim().to_lowercase();
    q.is_empty()
        || ["fullName", "description"]
            .iter()
            .any(|k| repo.get(*k).and_then(Value::as_str).is_some_and(|s| s.to_lowercase().contains(&q)))
}

fn text(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => json!(s),
        _ => json!(""),
    }
}

async fn github(http: &dyn Http, api: &str, token: &str) -> Result<Vec<Value>, String> {
    let url =
        format!("{api}/user/repos?sort=updated&per_page={PER_PAGE}&affiliation=owner,collaborator,organization_member");
    let req = Request::get(
        url,
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("Accept", "application/vnd.github+json"),
            ("User-Agent", "nekko-agent"),
        ],
    );
    let res = http.send(req).await?;
    if !res.ok() {
        return Err(refused("GitHub", res.status));
    }
    let list = js::parse_json(&res.body)?;
    Ok(arr(Some(&list))
        .iter()
        .filter_map(|r| {
            let full = r.get("full_name").and_then(Value::as_str)?;
            Some(json!({
                "provider": "github",
                "id": string(r.get("id")),
                "fullName": full,
                "cloneUrl": text(r.get("clone_url")),
                "webUrl": text(r.get("html_url")),
                "defaultBranch": text(r.get("default_branch")),
                "private": nekko_js::truthy(r.get("private")),
                "description": text(r.get("description")),
                "updatedAt": text(r.get("pushed_at").filter(|v| !v.is_null()).or(r.get("updated_at"))),
            }))
        })
        .collect())
}

async fn gitlab(http: &dyn Http, token: &str, settings: Option<&Value>, query: &str) -> Result<Vec<Value>, String> {
    let base = gitlab_base(settings)?;
    let search =
        if query.trim().is_empty() { String::new() } else { format!("&search={}", encode_uri_component(query.trim())) };
    let url = format!("{base}/api/v4/projects?membership=true&order_by=last_activity_at&per_page={PER_PAGE}{search}");
    let res = http.send(Request::get(url, &[("PRIVATE-TOKEN", token)])).await?;
    if !res.ok() {
        return Err(refused("GitLab", res.status));
    }
    let list = js::parse_json(&res.body)?;
    Ok(arr(Some(&list))
        .iter()
        .filter_map(|p| {
            let full = p.get("path_with_namespace").and_then(Value::as_str)?;
            Some(json!({
                "provider": "gitlab",
                "id": string(p.get("id")),
                "fullName": full,
                "cloneUrl": text(p.get("http_url_to_repo")),
                "webUrl": text(p.get("web_url")),
                "defaultBranch": text(p.get("default_branch")),
                "private": p.get("visibility").and_then(Value::as_str) != Some("public"),
                "description": text(p.get("description")),
                "updatedAt": text(p.get("last_activity_at")),
            }))
        })
        .collect())
}

fn refused(label: &str, status: u16) -> String {
    match status {
        401 => format!("{label} didn't accept the connector's token. Reconnect {label} in Connectors."),
        403 => format!("{label} refused the request: the token may lack repository access, or the rate limit was hit."),
        _ => format!("{label} answered {status} when listing repositories."),
    }
}

/// `{ repos, providers }`: every connected provider's repositories matching
/// `query` (most recently updated first, per provider), and each provider
/// asked with its error, if any. One provider failing never hides another's.
pub async fn list(http: &dyn Http, github_api: &str, connectors: &[Value], query: &str) -> Value {
    let mut repos = Vec::new();
    let mut providers = Vec::new();
    for p in connected(connectors) {
        let found = match p.kind {
            "github" => github(http, github_api, p.token).await,
            _ => gitlab(http, p.token, p.settings, query).await,
        };
        match found {
            Ok(list) => {
                repos.extend(list.into_iter().filter(|r| matches(query, r)));
                providers.push(json!({ "kind": p.kind }));
            }
            Err(e) => providers.push(json!({ "kind": p.kind, "error": e })),
        }
    }
    json!({ "repos": repos, "providers": providers })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::{BoxFut, Response};
    use std::sync::Mutex;

    struct Script(Mutex<Vec<(Request, Response)>>, Vec<Response>);

    impl Script {
        fn new(replies: Vec<Response>) -> Self {
            Self(Mutex::new(vec![]), replies)
        }
    }

    impl Http for Script {
        fn send(&self, req: Request) -> BoxFut<'_, Result<Response, String>> {
            let mut seen = self.0.lock().unwrap();
            let reply = self.1[seen.len()].clone();
            seen.push((req, reply.clone()));
            Box::pin(async move { Ok(reply) })
        }
    }

    fn ok(body: &str) -> Response {
        Response { status: 200, body: body.into(), location: None }
    }

    #[test]
    fn only_connected_git_providers_with_a_token() {
        let list = vec![
            json!({"kind":"github","connected":true,"token":"t"}),
            json!({"kind":"gitlab","connected":false,"token":"t"}),
            json!({"kind":"slack","connected":true,"token":"t"}),
            json!({"kind":"gitlab","connected":true,"token":"  "}),
        ];
        let kinds: Vec<&str> = connected(&list).iter().map(|p| p.kind).collect();
        assert_eq!(kinds, vec!["github"]);
    }

    #[tokio::test]
    async fn github_repos_carry_clone_details_and_filter_by_query() {
        let body = r#"[{"id":1,"full_name":"me/app","clone_url":"https://github.com/me/app.git","html_url":"https://github.com/me/app","default_branch":"main","private":true,"description":"The app","pushed_at":"2026-11-01T00:00:00Z"},
                       {"id":2,"full_name":"me/site","clone_url":"https://github.com/me/site.git","html_url":"https://github.com/me/site","default_branch":"main","private":false,"description":null}]"#;
        let http = Script::new(vec![ok(body)]);
        let connectors = vec![json!({"kind":"github","connected":true,"token":"secret"})];
        let out = list(&http, GITHUB_API, &connectors, "APP").await;
        let repos = out["repos"].as_array().unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0]["fullName"], "me/app");
        assert_eq!(repos[0]["cloneUrl"], "https://github.com/me/app.git");
        assert_eq!(repos[0]["private"], true);
        assert_eq!(out["providers"], json!([{"kind":"github"}]));
        let seen = http.0.lock().unwrap();
        assert!(seen[0].0.url.starts_with("https://api.github.com/user/repos?"));
        assert!(!out.to_string().contains("secret"));
    }

    #[tokio::test]
    async fn gitlab_searches_server_side_on_its_instance() {
        let body = r#"[{"id":7,"path_with_namespace":"grp/sub/tool","http_url_to_repo":"https://gl.example.com/grp/sub/tool.git","web_url":"https://gl.example.com/grp/sub/tool","default_branch":"dev","visibility":"internal","description":"tool"}]"#;
        let http = Script::new(vec![ok(body)]);
        let connectors =
            vec![json!({"kind":"gitlab","connected":true,"token":"t","settings":{"site":"https://gl.example.com"}})];
        let out = list(&http, GITHUB_API, &connectors, "tool").await;
        assert_eq!(out["repos"][0]["fullName"], "grp/sub/tool");
        assert_eq!(out["repos"][0]["private"], true);
        let seen = http.0.lock().unwrap();
        assert!(seen[0].0.url.starts_with("https://gl.example.com/api/v4/projects?membership=true"));
        assert!(seen[0].0.url.ends_with("&search=tool"));
    }

    #[tokio::test]
    async fn one_provider_failing_keeps_the_other() {
        let http = Script::new(vec![
            Response { status: 401, body: String::new(), location: None },
            ok(r#"[{"id":1,"path_with_namespace":"a/b","http_url_to_repo":"https://gitlab.com/a/b.git"}]"#),
        ]);
        let connectors = vec![
            json!({"kind":"github","connected":true,"token":"bad"}),
            json!({"kind":"gitlab","connected":true,"token":"good"}),
        ];
        let out = list(&http, GITHUB_API, &connectors, "").await;
        assert_eq!(out["repos"].as_array().unwrap().len(), 1);
        assert!(out["providers"][0]["error"].as_str().unwrap().contains("Reconnect GitHub"));
        assert_eq!(out["providers"][1], json!({"kind":"gitlab"}));
    }

    #[test]
    fn web_origins() {
        assert_eq!(web_origin("github", None).unwrap(), "https://github.com");
        assert_eq!(
            web_origin("gitlab", Some(&json!({"site":"https://gl.example.com/"}))).unwrap(),
            "https://gl.example.com"
        );
        assert!(web_origin("gitlab", Some(&json!({"site":"http://gl.example.com"}))).is_err());
        assert!(web_origin("slack", None).is_err());
    }
}
