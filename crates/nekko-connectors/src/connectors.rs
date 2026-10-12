//! The connectors (`packages/core/src/connectors/index.ts`): `fetch` lists or
//! searches a service's resources for context, `poll` reads its new events
//! since a cursor for workflow listeners. Requests and results match the TS
//! code exactly (held to it by the golden set).

use crate::http::{Http, Request, Response};
use crate::js::{
    self, arr, at, date_ms, encode_uri_component, iso_string, max_of, num, obj, or_empty, setting, string,
};
use base64::Engine;
use serde_json::{Value, json};

fn lower(s: &str) -> String {
    s.to_lowercase()
}

async fn send(http: &dyn Http, req: Request) -> Result<Response, String> {
    http.send(req).await
}

/// `throw new Error('<Label> <status>')` unless the response is OK.
fn ok_or(res: &Response, label: &str) -> Result<(), String> {
    if res.ok() { Ok(()) } else { Err(format!("{label} {}", res.status)) }
}

/// The poll result: the events and the cursor after them.
fn poll_result(events: Vec<Value>, cursor: f64) -> Value {
    let next = if events.is_empty() {
        cursor
    } else {
        max_of(events.iter().map(|e| e.get("cursor").and_then(Value::as_f64).unwrap_or(f64::NAN)))
    };
    json!({ "events": events, "nextCursor": num(next) })
}

/// `connector.fetch(token, query, settings)` for a kind.
pub async fn fetch(
    http: &dyn Http,
    kind: &str,
    token: &str,
    query: Option<&str>,
    settings: Option<&Value>,
) -> Result<Value, String> {
    let query = query.filter(|q| !q.is_empty());
    match kind {
        "github" => github_fetch(http, token, query).await,
        "linear" => linear_fetch(http, token, query).await,
        "slack" => slack_fetch(http, token, query).await,
        "discord" => {
            let auth = format!("Bot {token}");
            let res =
                send(http, Request::get("https://discord.com/api/v10/users/@me/guilds", &[("Authorization", &auth)]))
                    .await?;
            ok_or(&res, "Discord")?;
            let guilds = js::parse_json(&res.body)?;
            Ok(Value::Array(
                arr(Some(&guilds))
                    .iter()
                    .map(|g| {
                        obj(vec![
                            ("id", g.get("id").cloned()),
                            ("title", g.get("name").cloned()),
                            ("subtitle", Some(json!("Discord server"))),
                            ("body", Some(json!(""))),
                        ])
                    })
                    .collect(),
            ))
        }
        "gitlab" => gitlab_fetch(http, token, query, settings).await,
        "jira" => jira_fetch(http, token, query, settings).await,
        "teams" => teams_fetch(http, token, query, settings).await,
        "gmail" => {
            let url = format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20{}",
                query.map(|q| format!("&q={}", encode_uri_component(q))).unwrap_or_default()
            );
            let auth = format!("Bearer {token}");
            let res = send(http, Request::get(url, &[("Authorization", &auth)])).await?;
            if !res.ok() {
                return Err(format!("Gmail {}, connect via OAuth", res.status));
            }
            let json = js::parse_json(&res.body)?;
            Ok(Value::Array(
                arr(json.get("messages"))
                    .iter()
                    .map(|m| {
                        obj(vec![
                            ("id", m.get("id").cloned()),
                            ("title", Some(json!(format!("Message {}", string(m.get("id")))))),
                            ("subtitle", Some(json!("Gmail"))),
                            ("body", Some(json!(""))),
                        ])
                    })
                    .collect(),
            ))
        }
        "gdrive" => {
            let url = format!(
                "https://www.googleapis.com/drive/v3/files?pageSize=20{}",
                query
                    .map(|q| format!("&q={}", encode_uri_component(&format!("name contains '{q}'"))))
                    .unwrap_or_default()
            );
            let auth = format!("Bearer {token}");
            let res = send(http, Request::get(url, &[("Authorization", &auth)])).await?;
            if !res.ok() {
                return Err(format!("Drive {}, connect via OAuth", res.status));
            }
            let json = js::parse_json(&res.body)?;
            Ok(Value::Array(
                arr(json.get("files"))
                    .iter()
                    .map(|f| {
                        obj(vec![
                            ("id", f.get("id").cloned()),
                            ("title", f.get("name").cloned()),
                            ("subtitle", f.get("mimeType").cloned()),
                            ("body", Some(json!(""))),
                        ])
                    })
                    .collect(),
            ))
        }
        other => Err(format!("Cannot read properties of undefined (reading 'fetch') [{other}]")),
    }
}

/// `connector.poll(token, settings, cursor)`, for the kinds that have one.
pub async fn poll(http: &dyn Http, kind: &str, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    match kind {
        "github" => github_poll(http, token, settings, cursor).await,
        "linear" => linear_poll(http, token, cursor).await,
        "slack" => slack_poll(http, token, settings, cursor).await,
        "gitlab" => gitlab_poll(http, token, settings, cursor).await,
        "jira" => jira_poll(http, token, settings, cursor).await,
        other => Err(format!("The {other} connector has no poll")),
    }
}

/// Whether a kind can be polled.
pub fn can_poll(kind: &str) -> bool {
    matches!(kind, "github" | "linear" | "slack" | "gitlab" | "jira")
}

fn github_headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("Accept".into(), "application/vnd.github+json".into()),
        ("User-Agent".into(), "nekko-agent".into()),
    ]
}

fn with_headers(mut req: Request, headers: Vec<(String, String)>) -> Request {
    req.headers = headers;
    req
}

async fn github_fetch(http: &dyn Http, token: &str, query: Option<&str>) -> Result<Value, String> {
    if let Some(q) = query {
        let url = format!("https://api.github.com/search/issues?q={}&per_page=20", encode_uri_component(q));
        let res = send(http, with_headers(Request::get(url, &[]), github_headers(token))).await?;
        ok_or(&res, "GitHub")?;
        let json = js::parse_json(&res.body)?;
        return Ok(Value::Array(
            arr(json.get("items"))
                .iter()
                .map(|it| {
                    let repo = it
                        .get("repository_url")
                        .and_then(Value::as_str)
                        .map(|u| {
                            let parts: Vec<&str> = u.split('/').collect();
                            parts[parts.len().saturating_sub(2)..].join("/")
                        })
                        .unwrap_or_default();
                    let kind = if nekko_js::truthy(it.get("pull_request")) { "PR" } else { "Issue" };
                    obj(vec![
                        ("id", Some(json!(string(it.get("id"))))),
                        ("title", it.get("title").cloned()),
                        ("subtitle", Some(json!(format!("{kind} {repo} #{}", string(it.get("number")))))),
                        ("url", it.get("html_url").cloned()),
                        ("body", Some(it.get("body").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")))),
                    ])
                })
                .collect(),
        ));
    }
    let res = send(
        http,
        with_headers(
            Request::get("https://api.github.com/user/repos?sort=updated&per_page=25", &[]),
            github_headers(token),
        ),
    )
    .await?;
    ok_or(&res, "GitHub")?;
    let repos = js::parse_json(&res.body)?;
    Ok(Value::Array(
        arr(Some(&repos))
            .iter()
            .map(|r| {
                obj(vec![
                    ("id", Some(json!(string(r.get("id"))))),
                    ("title", r.get("full_name").cloned()),
                    ("subtitle", Some(json!(if nekko_js::truthy(r.get("private")) { "private repo" } else { "repo" }))),
                    ("url", r.get("html_url").cloned()),
                    ("body", Some(r.get("description").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")))),
                ])
            })
            .collect(),
    ))
}

async fn github_poll(http: &dyn Http, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    let repo = setting(Some(settings), "repo");
    iso_string(cursor).ok_or("Invalid time value")?;
    let url = if repo.is_empty() {
        "https://api.github.com/events?per_page=25".to_string()
    } else {
        format!("https://api.github.com/repos/{}/events?per_page=25", encode_uri_component(&repo))
    };
    let res = send(http, with_headers(Request::get(url, &[]), github_headers(token))).await?;
    ok_or(&res, "GitHub")?;
    let data = js::parse_json(&res.body)?;
    let want = lower(&or_empty(settings.get("event")));
    let filter = lower(&or_empty(settings.get("filter")));
    let mut events = Vec::new();
    for ev in arr(Some(&data)) {
        let created = date_ms(ev.get("created_at"));
        if created <= cursor {
            continue;
        }
        let event_type = lower(&or_empty(ev.get("type")));
        if !want.is_empty() && !event_type.contains(&want) {
            continue;
        }
        let payload = ev.get("payload");
        let number = payload.and_then(|p| p.get("number")).filter(|n| nekko_js::truthy(Some(n)));
        let action = payload.and_then(|p| p.get("action")).filter(|a| nekko_js::truthy(Some(a)));
        let text = format!(
            "{}{}{}",
            ev.get("type").filter(|t| !t.is_null()).map_or("event".into(), nekko_js::display),
            number.map(|n| format!(" #{}", nekko_js::display(n))).unwrap_or_default(),
            action.map(|a| format!(" {}", nekko_js::display(a))).unwrap_or_default()
        );
        let text = nekko_js::trim(&text).to_string();
        let payload_json = nekko_js::stringify(payload.filter(|p| !p.is_null()).unwrap_or(&json!({})));
        if !filter.is_empty() && !lower(&text).contains(&filter) && !lower(&payload_json).contains(&filter) {
            continue;
        }
        let source = at(&ev, &["repo", "name"]).filter(|n| !n.is_null()).cloned().unwrap_or(json!(repo));
        events.push(obj(vec![
            ("id", Some(json!(string(ev.get("id"))))),
            ("cursor", Some(num(created))),
            ("event", Some(ev.get("type").filter(|t| !t.is_null()).cloned().unwrap_or(json!("event")))),
            ("text", Some(json!(text))),
            ("source", Some(source)),
            ("payload", Some(payload.filter(|p| !p.is_null()).cloned().unwrap_or(json!({})))),
        ]));
    }
    Ok(poll_result(events, cursor))
}

fn linear_request(token: &str, body: String) -> Request {
    Request::post(
        "https://api.linear.app/graphql",
        &[("Content-Type", "application/json"), ("Authorization", token)],
        Some(body),
    )
}

async fn linear_fetch(http: &dyn Http, token: &str, query: Option<&str>) -> Result<Value, String> {
    let gql = match query {
        Some(q) => {
            json!({ "query": "query($q:String!){ searchIssues(term:$q){ nodes{ id identifier title url description } } }", "variables": { "q": q } })
        }
        None => {
            json!({ "query": "{ issues(first:25, orderBy:updatedAt){ nodes{ id identifier title url description } } }" })
        }
    };
    let res = send(http, linear_request(token, nekko_js::stringify(&gql))).await?;
    ok_or(&res, "Linear")?;
    let json = js::parse_json(&res.body)?;
    let nodes = at(&json, &["data", "issues", "nodes"])
        .filter(|n| !n.is_null())
        .or_else(|| at(&json, &["data", "searchIssues", "nodes"]).filter(|n| !n.is_null()));
    Ok(Value::Array(
        arr(nodes)
            .iter()
            .map(|n| {
                obj(vec![
                    ("id", n.get("id").cloned()),
                    ("title", Some(json!(format!("{} {}", string(n.get("identifier")), string(n.get("title")))))),
                    ("subtitle", Some(json!("Linear issue"))),
                    ("url", n.get("url").cloned()),
                    ("body", Some(n.get("description").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")))),
                ])
            })
            .collect(),
    ))
}

async fn linear_poll(http: &dyn Http, token: &str, cursor: f64) -> Result<Value, String> {
    let since = iso_string(cursor).ok_or("Invalid time value")?;
    let filter = format!("{{ updatedAt: {{ gt: \"{since}\" }} }}");
    let query = format!(
        "{{ issues(first: 25, filter: {filter}, orderBy: updatedAt) {{ nodes {{ id identifier title url description updatedAt state {{ name }} }} }} }}"
    );
    let res = send(http, linear_request(token, nekko_js::stringify(&json!({ "query": query })))).await?;
    ok_or(&res, "Linear")?;
    let json = js::parse_json(&res.body)?;
    let mut events = Vec::new();
    for n in arr(at(&json, &["data", "issues", "nodes"])) {
        let updated = date_ms(n.get("updatedAt"));
        if updated <= cursor {
            continue;
        }
        events.push(obj(vec![
            ("id", Some(json!(format!("{}:{}", string(n.get("id")), string(n.get("updatedAt")))))),
            ("cursor", Some(num(updated))),
            ("event", Some(json!("issue"))),
            (
                "text",
                Some(json!(
                    nekko_js::trim(&format!("{} {}", string(n.get("identifier")), string(n.get("title")))).to_string()
                )),
            ),
            ("payload", Some(js::spread_with(Some(&n), vec![("updatedAt", num(updated))]))),
        ]));
    }
    Ok(poll_result(events, cursor))
}

async fn slack_get(http: &dyn Http, token: &str, url: String) -> Result<Value, String> {
    let auth = format!("Bearer {token}");
    let res = send(http, Request::get(url, &[("Authorization", &auth)])).await?;
    js::parse_json(&res.body)
}

fn slack_error(json: &Value) -> String {
    format!("Slack: {}", json.get("error").filter(|e| !e.is_null()).map_or("error".into(), nekko_js::display))
}

async fn slack_fetch(http: &dyn Http, token: &str, query: Option<&str>) -> Result<Value, String> {
    let url = match query {
        Some(q) => format!("https://slack.com/api/search.messages?query={}&count=20", encode_uri_component(q)),
        None => "https://slack.com/api/conversations.list?limit=50&exclude_archived=true".to_string(),
    };
    let json = slack_get(http, token, url).await?;
    if !nekko_js::truthy(json.get("ok")) {
        return Err(slack_error(&json));
    }
    if query.is_some() {
        return Ok(Value::Array(
            arr(at(&json, &["messages", "matches"]))
                .iter()
                .map(|m| {
                    let id = m.get("iid").filter(|v| !v.is_null()).or_else(|| m.get("ts")).cloned();
                    let text = m.get("text").and_then(Value::as_str);
                    obj(vec![
                        ("id", id),
                        (
                            "title",
                            Some(json!(text.map_or("(message)".to_string(), |t| js::slice16(t, 80).to_string()))),
                        ),
                        ("subtitle", Some(json!(format!("#{}", or_empty(at(m, &["channel", "name"])))))),
                        ("url", m.get("permalink").cloned()),
                        ("body", Some(m.get("text").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")))),
                    ])
                })
                .collect(),
        ));
    }
    Ok(Value::Array(
        arr(json.get("channels"))
            .iter()
            .map(|c| {
                obj(vec![
                    ("id", c.get("id").cloned()),
                    ("title", Some(json!(format!("#{}", string(c.get("name")))))),
                    (
                        "subtitle",
                        Some(json!(if nekko_js::truthy(c.get("is_private")) { "private channel" } else { "channel" })),
                    ),
                    ("body", Some(at(c, &["purpose", "value"]).filter(|v| !v.is_null()).cloned().unwrap_or(json!("")))),
                ])
            })
            .collect(),
    ))
}

async fn slack_poll(http: &dyn Http, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    let want = setting(Some(settings), "channel");
    if want.is_empty() {
        return Err("Slack poll needs a channel id or #channel name in the trigger.".into());
    }
    let mut channel_id = want.strip_prefix('#').unwrap_or(&want).to_string();
    if want.starts_with('#') {
        let list = slack_get(
            http,
            token,
            "https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel".into(),
        )
        .await?;
        if !nekko_js::truthy(list.get("ok")) {
            return Err(slack_error(&list));
        }
        let found =
            arr(list.get("channels")).into_iter().find(|c| c.get("name").and_then(Value::as_str) == Some(&channel_id));
        let Some(found) = found else { return Err(format!("Slack channel \"{want}\" not found.")) };
        channel_id = string(found.get("id"));
    }
    let mut pairs = vec![("channel", channel_id.clone()), ("limit", "50".to_string())];
    if cursor > 0.0 {
        pairs.push(("oldest", nekko_js::number_to_string(cursor / 1000.0)));
    }
    let qs = js::search_params(&pairs.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>());
    let json = slack_get(http, token, format!("https://slack.com/api/conversations.history?{qs}")).await?;
    if !nekko_js::truthy(json.get("ok")) {
        return Err(slack_error(&json));
    }
    let filter = lower(&or_empty(settings.get("filter")));
    let mut events = Vec::new();
    for m in arr(json.get("messages")).into_iter().filter(|m| !nekko_js::truthy(m.get("subtype"))) {
        let text = or_empty(m.get("text"));
        if !filter.is_empty() && !lower(&text).contains(&filter) {
            continue;
        }
        let ts = nekko_js::to_number(m.get("ts"));
        let ts_ms = (ts * 1000.0 + 0.5).floor();
        if ts_ms <= cursor {
            continue;
        }
        events.push(obj(vec![
            ("id", Some(json!(format!("{channel_id}:{}", string(m.get("ts")))))),
            ("cursor", Some(num(ts_ms))),
            ("event", Some(json!("message"))),
            ("text", Some(json!(js::slice16(&text, 140)))),
            ("source", Some(json!(want))),
            ("payload", Some(js::spread_with(Some(&m), vec![("channel", json!(channel_id))]))),
        ]));
    }
    let next = poll_result(Vec::new(), cursor);
    let next_cursor = if events.is_empty() {
        next["nextCursor"].clone()
    } else {
        num(max_of(events.iter().map(|e| e.get("cursor").and_then(Value::as_f64).unwrap_or(f64::NAN))))
    };
    events.reverse();
    Ok(json!({ "events": events, "nextCursor": next_cursor }))
}

/// `gitlabBase(settings)`: the instance origin, gitlab.com by default.
pub fn gitlab_base(settings: Option<&Value>) -> Result<String, String> {
    let raw = setting(settings, "site");
    let site = raw.trim_end_matches('/');
    let site = if site.is_empty() { "https://gitlab.com" } else { site };
    let u = js::parse_url(site).ok_or_else(|| format!("GitLab site \"{site}\" isn't a valid URL."))?;
    if u.protocol != "https:" {
        return Err("The GitLab instance URL must be https.".into());
    }
    if !u.pathname.trim_end_matches('/').is_empty() {
        return Err(format!(
            "The GitLab instance URL should be the instance origin (e.g. https://gitlab.example.com), not \"{site}\"."
        ));
    }
    Ok(u.origin)
}

async fn gitlab_fetch(
    http: &dyn Http,
    token: &str,
    query: Option<&str>,
    settings: Option<&Value>,
) -> Result<Value, String> {
    let base = gitlab_base(settings)?;
    let qs = format!(
        "membership=true&order_by=updated_at&per_page=25{}",
        query.map(|q| format!("&search={}", encode_uri_component(q))).unwrap_or_default()
    );
    let res = send(http, Request::get(format!("{base}/api/v4/projects?{qs}"), &[("PRIVATE-TOKEN", token)])).await?;
    ok_or(&res, "GitLab")?;
    let projects = js::parse_json(&res.body)?;
    Ok(Value::Array(
        arr(Some(&projects))
            .iter()
            .map(|p| {
                obj(vec![
                    ("id", Some(json!(string(p.get("id"))))),
                    ("title", p.get("path_with_namespace").cloned()),
                    ("subtitle", Some(json!("GitLab project"))),
                    ("url", p.get("web_url").cloned()),
                    ("body", Some(p.get("description").filter(|b| !b.is_null()).cloned().unwrap_or(json!("")))),
                ])
            })
            .collect(),
    ))
}

async fn gitlab_poll(http: &dyn Http, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    let base = gitlab_base(Some(settings))?;
    let project = {
        let r = settings.get("repo").filter(|v| !v.is_null()).or_else(|| settings.get("project"));
        nekko_js::trim(&or_empty(r)).to_string()
    };
    let after = iso_string(cursor).ok_or("Invalid time value")?[..10].to_string();
    let url = if project.is_empty() {
        format!("{base}/api/v4/events?per_page=25&after={after}")
    } else {
        format!("{base}/api/v4/projects/{}/events?per_page=25&after={after}", encode_uri_component(&project))
    };
    let res = send(http, Request::get(url, &[("PRIVATE-TOKEN", token)])).await?;
    ok_or(&res, "GitLab")?;
    let data = js::parse_json(&res.body)?;
    let want = lower(&or_empty(settings.get("event")));
    let filter = lower(&or_empty(settings.get("filter")));
    let first = |ev: &Value, keys: &[&str]| keys.iter().find_map(|k| ev.get(*k).filter(|v| !v.is_null()).cloned());
    let mut events = Vec::new();
    for ev in arr(Some(&data)) {
        let created = date_ms(ev.get("created_at"));
        if created <= cursor {
            continue;
        }
        let event_type =
            lower(&first(&ev, &["action_name", "target_type"]).map_or("event".into(), |v| nekko_js::display(&v)));
        if !want.is_empty() && !event_type.contains(&want) {
            continue;
        }
        let title = first(&ev, &["target_title", "title"]).map_or(event_type.clone(), |v| nekko_js::display(&v));
        let iid = ev.get("target_iid").filter(|v| nekko_js::truthy(Some(v)));
        let text = nekko_js::trim(&format!(
            "{title}{}",
            iid.map(|i| format!(" #{}", nekko_js::display(i))).unwrap_or_default()
        ))
        .to_string();
        let json_text = nekko_js::stringify(&ev);
        if !filter.is_empty() && !lower(&text).contains(&filter) && !lower(&json_text).contains(&filter) {
            continue;
        }
        let id_part = first(&ev, &["project_id", "id"]).map_or("undefined".into(), |v| nekko_js::display(&v));
        let source = match ev.get("project_id").filter(|v| nekko_js::truthy(Some(v))) {
            Some(p) => json!(nekko_js::display(p)),
            None => json!(project),
        };
        events.push(obj(vec![
            ("id", Some(json!(format!("{id_part}:{}", string(ev.get("created_at")))))),
            ("cursor", Some(num(created))),
            ("event", Some(first(&ev, &["action_name", "target_type"]).unwrap_or(json!("event")))),
            ("text", Some(json!(text))),
            ("source", Some(source)),
            ("payload", Some(ev.clone())),
        ]));
    }
    Ok(poll_result(events, cursor))
}

/// Jira's site and Basic auth header from the connector settings.
fn jira_site(settings: Option<&Value>, need: &str) -> Result<(String, String), String> {
    let site = setting(settings, "site").trim_end_matches('/').to_string();
    let email = setting(settings, "email");
    if site.is_empty() || email.is_empty() {
        return Err(need.into());
    }
    Ok((site, email))
}

fn basic(email: &str, token: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{email}:{token}")))
}

/// GET the JQL search, falling back to the legacy path on 404/410.
async fn jira_search(http: &dyn Http, site: &str, qs: &str, auth: &str) -> Result<Response, String> {
    let headers = [("Authorization", auth), ("Accept", "application/json")];
    let res = send(http, Request::get(format!("{site}/rest/api/3/search/jql?{qs}"), &headers)).await?;
    if res.status == 404 || res.status == 410 {
        return send(http, Request::get(format!("{site}/rest/api/3/search?{qs}"), &headers)).await;
    }
    Ok(res)
}

/// JQL reserves punctuation that cannot appear in a quoted phrase, so the
/// term is folded to plain words (never a query-language injection point).
fn jql_term(q: &str) -> String {
    let folded: String = q.chars().map(|c| if "\"\\+-=&|><!(){}[]^~*?:/".contains(c) { ' ' } else { c }).collect();
    let mut out = String::new();
    let mut space = false;
    for c in folded.chars() {
        if nekko_js::is_js_space(c) || nekko_js::is_line_terminator(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

async fn jira_fetch(
    http: &dyn Http,
    token: &str,
    query: Option<&str>,
    settings: Option<&Value>,
) -> Result<Value, String> {
    let (site, email) = jira_site(settings, "Jira needs a site URL and the account email.")?;
    let u = js::parse_url(&site).ok_or_else(|| format!("Jira site \"{site}\" isn't a valid URL."))?;
    if u.protocol != "https:" {
        return Err("Jira site URL must be https.".into());
    }
    let auth = basic(&email, token);
    let term = jql_term(query.unwrap_or(""));
    let jql = if term.is_empty() {
        "order by updated desc".to_string()
    } else {
        format!("text ~ \"{term}\" order by updated desc")
    };
    let qs = format!("jql={}&maxResults=25&fields=summary,status,issuetype,description", encode_uri_component(&jql));
    let res = jira_search(http, &site, &qs, &auth).await?;
    ok_or(&res, "Jira")?;
    let json = js::parse_json(&res.body)?;
    Ok(Value::Array(
        arr(json.get("issues"))
            .iter()
            .map(|issue| {
                let f = issue.get("fields");
                let field = |p: &[&str]| f.and_then(|f| at(f, p)).filter(|v| !v.is_null());
                let parts: Vec<String> = [field(&["issuetype", "name"]), field(&["status", "name"])]
                    .into_iter()
                    .flatten()
                    .filter(|v| nekko_js::truthy(Some(v)))
                    .map(nekko_js::display)
                    .collect();
                let subtitle = if parts.is_empty() { "Jira issue".to_string() } else { parts.join(" \u{b7} ") };
                let id = issue.get("id").filter(|v| !v.is_null()).or_else(|| issue.get("key"));
                obj(vec![
                    ("id", Some(json!(string(id)))),
                    (
                        "title",
                        Some(json!(
                            nekko_js::trim(&format!("{} {}", string(issue.get("key")), or_empty(field(&["summary"]))))
                                .to_string()
                        )),
                    ),
                    ("subtitle", Some(json!(subtitle))),
                    ("url", Some(json!(format!("{site}/browse/{}", string(issue.get("key")))))),
                    ("body", Some(json!(field(&["description"]).and_then(Value::as_str).unwrap_or("")))),
                ])
            })
            .collect(),
    ))
}

async fn jira_poll(http: &dyn Http, token: &str, settings: &Value, cursor: f64) -> Result<Value, String> {
    let (site, email) = jira_site(Some(settings), "Jira needs a site URL and the account email.")?;
    let iso = iso_string(cursor).ok_or("Invalid time value")?;
    let jql_date = js::slice16(&iso.replacen('T', " ", 1), 16).to_string();
    let jql = format!("updated >= \"{jql_date}\" order by updated desc");
    let qs =
        format!("jql={}&maxResults=25&fields=summary,status,issuetype,description,updated", encode_uri_component(&jql));
    let auth = basic(&email, token);
    let res = jira_search(http, &site, &qs, &auth).await?;
    ok_or(&res, "Jira")?;
    let json = js::parse_json(&res.body)?;
    let filter = lower(&or_empty(settings.get("filter")));
    let mut events = Vec::new();
    for issue in arr(json.get("issues")) {
        let fields = issue.get("fields");
        let updated_raw = fields.and_then(|f| f.get("updated"));
        let updated = date_ms(updated_raw);
        if !nekko_js::truthy_number(updated) || updated <= cursor {
            continue;
        }
        let text = nekko_js::trim(&format!(
            "{} {}",
            string(issue.get("key")),
            or_empty(fields.and_then(|f| f.get("summary")))
        ))
        .to_string();
        let description = or_empty(fields.and_then(|f| f.get("description")));
        if !filter.is_empty() && !lower(&text).contains(&filter) && !lower(&description).contains(&filter) {
            continue;
        }
        let mut payload = fields.and_then(Value::as_object).cloned().unwrap_or_default();
        payload.insert("key".into(), issue.get("key").cloned().unwrap_or(Value::Null));
        payload.insert("updated".into(), num(updated));
        if issue.get("key").is_none() {
            payload.shift_remove("key");
        }
        events.push(obj(vec![
            ("id", Some(json!(format!("{}:{}", string(issue.get("key")), string(updated_raw))))),
            ("cursor", Some(num(updated))),
            ("event", Some(json!("issue"))),
            ("text", Some(json!(text))),
            ("payload", Some(Value::Object(payload))),
        ]));
    }
    Ok(poll_result(events, cursor))
}

/// A Teams incoming webhook: https on `*.webhook.office.com`.
pub fn teams_webhook_ok(u: &js::JsUrl) -> bool {
    let host = u.hostname.to_lowercase();
    u.protocol == "https:" && (host == "webhook.office.com" || host.ends_with(".webhook.office.com"))
}

async fn teams_fetch(
    http: &dyn Http,
    token: &str,
    query: Option<&str>,
    settings: Option<&Value>,
) -> Result<Value, String> {
    if !token.is_empty() {
        let auth = format!("Bearer {token}");
        let res =
            send(http, Request::get("https://graph.microsoft.com/v1.0/me/joinedTeams", &[("Authorization", &auth)]))
                .await?;
        ok_or(&res, "Graph")?;
        let json = js::parse_json(&res.body)?;
        let mut teams: Vec<Value> = arr(json.get("value"))
            .iter()
            .map(|t| {
                obj(vec![
                    ("id", t.get("id").cloned()),
                    ("title", Some(t.get("displayName").filter(|v| !v.is_null()).cloned().unwrap_or(json!("Team")))),
                    ("subtitle", Some(json!("Microsoft Teams"))),
                    ("body", Some(t.get("description").filter(|v| !v.is_null()).cloned().unwrap_or(json!("")))),
                ])
            })
            .collect();
        if let Some(q) = query {
            let q = lower(q);
            teams.retain(|t| lower(&or_empty(t.get("title"))).contains(&q));
        }
        return Ok(Value::Array(teams));
    }
    let webhook = setting(settings, "webhookUrl");
    if !webhook.is_empty() {
        let u = js::parse_url(&webhook).ok_or("The Teams webhook URL isn't a valid https URL.")?;
        if !teams_webhook_ok(&u) {
            return Err("The Teams webhook URL must be an https URL on *.webhook.office.com (the Incoming Webhook URL from the Teams channel).".into());
        }
        return Ok(json!([{
            "id": "webhook",
            "title": "Incoming webhook",
            "subtitle": u.hostname.to_lowercase(),
            "body": "Nekko Agent can post messages to this channel. Add a Graph token to read teams.",
        }]));
    }
    Err("Teams needs an incoming webhook URL or a Microsoft Graph token.".into())
}

/// `collectConnectorSnippets(query)`: up to five resources from every
/// connected connector with a token, as context snippets. A connector that
/// fails adds nothing; if they all take longer than `timeout`, none are used.
pub async fn snippets(
    http: &dyn Http,
    connectors: &[Value],
    query: Option<&str>,
    timeout: std::time::Duration,
) -> Vec<Value> {
    let live: Vec<&Value> = connectors
        .iter()
        .filter(|c| nekko_js::truthy(c.get("connected")) && nekko_js::truthy(c.get("token")))
        .collect();
    if live.is_empty() {
        return Vec::new();
    }
    let fetches = live.iter().map(|c| async move {
        let kind = c.get("kind").and_then(Value::as_str).unwrap_or("");
        let token = c.get("token").map(nekko_js::display).unwrap_or_default();
        match fetch(http, kind, &token, query, c.get("settings")).await {
            Ok(Value::Array(resources)) => resources
                .iter()
                .take(5)
                .map(|r| {
                    let parts: Vec<String> = [r.get("subtitle"), r.get("body")]
                        .into_iter()
                        .filter(|v| nekko_js::truthy(*v))
                        .map(|v| nekko_js::display(v.unwrap_or(&Value::Null)))
                        .collect();
                    let body = if parts.is_empty() {
                        r.get("title").cloned().unwrap_or(Value::Null)
                    } else {
                        json!(parts.join(", "))
                    };
                    obj(vec![("label", r.get("title").cloned()), ("origin", Some(json!(kind))), ("body", Some(body))])
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        }
    });
    match tokio::time::timeout(timeout, futures_util::future::join_all(fetches)).await {
        Ok(all) => all.into_iter().flatten().collect(),
        Err(_) => Vec::new(),
    }
}
