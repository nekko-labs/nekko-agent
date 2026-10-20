//! Workflow action steps (`packages/core/src/connectors/actions.ts`): the
//! templates step fields interpolate, and the runners that post to Slack,
//! Linear, Jira, GitHub, GitLab, Discord, Teams and plain webhooks with the
//! stored connector config (credentials never live on the step).

use crate::connectors::{gitlab_base, teams_webhook_ok};
use crate::http::{Http, Request, Response};
use crate::js::{self, decode_uri_component, encode_uri_component, parse_url, slice16};
use base64::Engine;
use serde_json::{Map, Value, json};

/// A finished action: text for the run log, and whether it failed.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub output: String,
    pub is_error: bool,
}

impl Outcome {
    pub(crate) fn ok(output: impl Into<String>) -> Self {
        Self { output: output.into(), is_error: false }
    }
    pub(crate) fn fail(output: impl Into<String>) -> Self {
        Self { output: output.into(), is_error: true }
    }
    /// As the TS object prints (`{ output }` or `{ output, isError: true }`).
    pub fn value(&self) -> Value {
        if self.is_error { json!({ "output": self.output, "isError": true }) } else { json!({ "output": self.output }) }
    }
}

/// The ops with a runner (`WORKFLOW_ACTIONS` with code behind it).
pub const OPS: &[&str] = &[
    "slack.postMessage",
    "linear.createIssue",
    "linear.commentIssue",
    "jira.createIssue",
    "jira.commentIssue",
    "github.commentPR",
    "github.setCommitStatus",
    "github.runFailureLogs",
    "github.upsertPRComment",
    "gitlab.setCommitStatus",
    "gitlab.commentMR",
    "discord.postMessage",
    "teams.postMessage",
    "webhook.post",
];

/// The connector an op needs (`spec.connector`), if any.
pub fn op_connector(op: &str) -> Option<&'static str> {
    match op.split('.').next() {
        Some("slack") => Some("slack"),
        Some("linear") => Some("linear"),
        Some("jira") => Some("jira"),
        Some("github") => Some("github"),
        Some("gitlab") => Some("gitlab"),
        Some("discord") => Some("discord"),
        Some("teams") => Some("teams"),
        _ => None,
    }
}

/* ---------------------------- templates ---------------------------- */

/// `templateContext({ event, outputs, run })`.
pub fn template_context(event: Option<&Value>, outputs: &[(String, String)], run: Option<&Value>) -> Value {
    let mut ctx = Map::new();
    if let Some(e) = event {
        // Fixed keys first (absent ones hold their place), then the payload
        // spread over them, as the object literal builds it.
        let mut slots: Vec<(String, Option<Value>)> =
            ["kind", "provider", "event", "repo", "branch", "command", "channel", "text"]
                .iter()
                .map(|k| ((*k).to_string(), e.get(*k).cloned()))
                .collect();
        if let Some(p) = e.get("payload").and_then(Value::as_object) {
            for (k, v) in p {
                match slots.iter_mut().find(|(sk, _)| sk == k) {
                    Some(slot) => slot.1 = Some(v.clone()),
                    None => slots.push((k.clone(), Some(v.clone()))),
                }
            }
        }
        let mut trigger = Map::new();
        for (k, v) in slots {
            if let Some(v) = v {
                trigger.insert(k, v);
            }
        }
        ctx.insert("trigger".into(), Value::Object(trigger));
    }
    let mut steps = Map::new();
    for (id, output) in outputs {
        steps.insert(id.clone(), json!({ "output": output }));
    }
    ctx.insert("steps".into(), Value::Object(steps));
    if let Some(r) = run {
        ctx.insert("run".into(), r.clone());
    }
    Value::Object(ctx)
}

fn template_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

fn is_ws(c: char) -> bool {
    nekko_js::is_js_space(c) || nekko_js::is_line_terminator(c)
}

/// `renderTemplate(template, ctx)`: `{{trigger.*}}`, `{{steps.<id>.output}}`
/// and `{{run.*}}`; a missing leaf is empty, an unknown root is left alone.
pub fn render_template(template: &str, ctx: &Value) -> String {
    if !template.contains("{{") {
        return template.to_string();
    }
    let chars: Vec<(usize, char)> = template.char_indices().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if let Some((end, path)) = match_at(&chars, i) {
            let start = chars[i].0;
            let stop = chars.get(end).map_or(template.len(), |c| c.0);
            out.push_str(&resolve(&template[start..stop], &path, ctx));
            i = end;
        } else {
            out.push(chars[i].1);
            i += 1;
        }
    }
    out
}

/// `/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/` anchored at `i`: the index after it and the path.
fn match_at(chars: &[(usize, char)], i: usize) -> Option<(usize, String)> {
    let c = |j: usize| chars.get(j).map(|x| x.1);
    if c(i) != Some('{') || c(i + 1) != Some('{') {
        return None;
    }
    let mut j = i + 2;
    while c(j).is_some_and(is_ws) {
        j += 1;
    }
    let start = j;
    while c(j).is_some_and(template_char) {
        j += 1;
    }
    if j == start {
        return None;
    }
    let path: String = chars[start..j].iter().map(|x| x.1).collect();
    while c(j).is_some_and(is_ws) {
        j += 1;
    }
    if c(j) == Some('}') && c(j + 1) == Some('}') { Some((j + 2, path)) } else { None }
}

fn resolve(matched: &str, path: &str, ctx: &Value) -> String {
    let mut parts = path.split('.');
    let root = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let source = match root {
        "trigger" | "steps" | "run" => ctx.get(root),
        _ => None,
    };
    let Some(source) = source.filter(|s| s.is_object() || s.is_array()) else { return matched.to_string() };
    if rest.is_empty() {
        return matched.to_string();
    }
    let mut cur = Some(source);
    for seg in rest {
        match cur {
            Some(v @ (Value::Object(_) | Value::Array(_))) => cur = member(v, seg),
            _ => return String::new(),
        }
    }
    match cur {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v @ (Value::Object(_) | Value::Array(_))) => nekko_js::stringify(v),
        Some(v) => nekko_js::display(v),
    }
}

/// `obj[seg]` for a JSON object or array (an array's `length` included).
fn member<'a>(v: &'a Value, seg: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) => m.get(seg),
        Value::Array(a) => {
            if seg == "length" {
                // Not borrowable; callers only read it as a number.
                return None.or_else(|| LENGTHS.get(a.len()));
            }
            seg.parse::<usize>().ok().filter(|_| seg == "0" || !seg.starts_with('0')).and_then(|i| a.get(i))
        }
        _ => None,
    }
}

/// `[].length` values for `member` to hand out by reference.
static LENGTHS: std::sync::LazyLock<Vec<Value>> = std::sync::LazyLock::new(|| (0..4096).map(|n| json!(n)).collect());

/* ------------------------------ helpers ----------------------------- */

/// `str(v)`: `String(v ?? '').trim()`.
fn str_of(v: Option<&Value>) -> String {
    nekko_js::trim(&js::or_empty(v)).to_string()
}

/// `dig(obj, path)`: a dotted path to a scalar, as a trimmed string.
fn dig(obj: Option<&Value>, path: &str) -> String {
    let mut cur = obj;
    for seg in path.split('.') {
        match cur {
            Some(v @ (Value::Object(_) | Value::Array(_))) => cur = member(v, seg),
            _ => return String::new(),
        }
    }
    match cur {
        None | Some(Value::Null) | Some(Value::Object(_)) | Some(Value::Array(_)) => String::new(),
        Some(v) => str_of(Some(v)),
    }
}

/// The step's param, else the event's field, else the payload's.
fn pick(params: &Value, key: &str, event: Option<&Value>, event_keys: &[&str]) -> String {
    let own = str_of(params.get(key));
    if !own.is_empty() {
        return own;
    }
    for k in event_keys {
        let top = dig(event, k);
        if !top.is_empty() {
            return top;
        }
        let payload = dig(event.and_then(|e| e.get("payload")), k);
        if !payload.is_empty() {
            return payload;
        }
    }
    String::new()
}

fn required(value: String, label: &str) -> Result<String, String> {
    if value.is_empty() { Err(format!("{label} is required.")) } else { Ok(value) }
}

fn need_token(config: Option<&Value>, name: &str) -> Result<String, String> {
    let t = config.and_then(|c| c.get("token")).and_then(Value::as_str).map(nekko_js::trim).unwrap_or("");
    if t.is_empty() {
        return Err(format!("The {name} connector has no token saved. Reconnect it under Connectors."));
    }
    Ok(t.to_string())
}

fn settings_of(config: Option<&Value>) -> Option<&Value> {
    config.and_then(|c| c.get("settings"))
}

/// A short error out of a failed response.
pub(crate) fn http_error(res: &Response, label: &str) -> Outcome {
    let mut folded = String::new();
    let mut space = false;
    for c in res.body.chars() {
        if is_ws(c) {
            space = true;
        } else {
            if space {
                folded.push(' ');
            }
            space = false;
            folded.push(c);
        }
    }
    if space {
        folded.push(' ');
    }
    let body = slice16(nekko_js::trim(&folded), 300).to_string();
    Outcome::fail(format!(
        "{label} failed: {}{}",
        res.status,
        if body.is_empty() { String::new() } else { format!(": {body}") }
    ))
}

/// `res.json().catch(() => null)`.
fn json_or_null(res: &Response) -> Value {
    serde_json::from_str(&res.body).unwrap_or(Value::Null)
}

async fn linear_gql(http: &dyn Http, tok: &str, query: &str, variables: Option<Value>) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert("query".into(), json!(query));
    if let Some(v) = variables {
        body.insert("variables".into(), v);
    }
    let res = http
        .send(Request::post(
            "https://api.linear.app/graphql",
            &[("Content-Type", "application/json"), ("Authorization", tok)],
            Some(nekko_js::stringify(&Value::Object(body))),
        ))
        .await?;
    let json = json_or_null(&res);
    if !res.ok() {
        return Err(format!("Linear {}", res.status));
    }
    if let Some(first) = json.get("errors").and_then(Value::as_array).and_then(|e| e.first()) {
        let msg = first.get("message").filter(|m| !m.is_null()).map_or("GraphQL error".into(), nekko_js::display);
        return Err(format!("Linear: {msg}"));
    }
    Ok(json.get("data").cloned().unwrap_or(Value::Null))
}

fn jira_auth(config: Option<&Value>) -> Result<(String, Vec<(String, String)>), String> {
    let s = settings_of(config);
    let site = js::setting(s, "site").trim_end_matches('/').to_string();
    let email = js::setting(s, "email");
    let tok = need_token(config, "Jira")?;
    if site.is_empty() || email.is_empty() {
        return Err("Jira needs a site URL and the account email (set on the connector).".into());
    }
    let u = parse_url(&site).ok_or_else(|| format!("Jira site \"{site}\" isn't a valid URL."))?;
    if u.protocol != "https:" {
        return Err("The Jira site URL must be https.".into());
    }
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{email}:{tok}")));
    Ok((
        site,
        vec![
            ("Authorization".into(), auth),
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), "application/json".into()),
        ],
    ))
}

fn adf_doc(text: &str) -> Value {
    let content = if text.is_empty() { json!([]) } else { json!([{ "type": "text", "text": text }]) };
    json!({ "version": 1, "type": "doc", "content": [{ "type": "paragraph", "content": content }] })
}

fn github_headers(tok: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".into(), format!("Bearer {tok}")),
        ("Accept".into(), "application/vnd.github+json".into()),
        ("User-Agent".into(), "nekko-agent".into()),
        ("Content-Type".into(), "application/json".into()),
    ]
}

/// `owner/name`, or the TS error.
pub(crate) fn repo_path(value: &str) -> Result<String, String> {
    let repo = nekko_js::trim(value).to_string();
    let part =
        |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-');
    match repo.split_once('/') {
        Some((a, b)) if part(a) && part(b) => Ok(repo),
        _ => Err(format!("Repo \"{repo}\" should look like owner/name.")),
    }
}

fn post(url: String, headers: Vec<(String, String)>, body: Option<String>) -> Request {
    let mut r = Request::post(url, &[], body);
    r.headers = headers;
    r
}

/// `slugify(name)` from shared/workflows.ts.
pub fn slugify(name: &str) -> String {
    let lower = name.to_lowercase();
    let parts: Vec<&str> =
        lower.split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|p| !p.is_empty()).collect();
    let joined = parts.join("-");
    let slug = slice16(&joined, 48);
    let slug = slug.strip_suffix('-').unwrap_or(slug);
    if slug.is_empty() { "workflow".into() } else { slug.to_string() }
}

/* ------------------------------ runners ----------------------------- */

/// `runWorkflowAction(op, config, params, ctx)`: every failure folded into
/// an error outcome. `ctx` is `{ event?, run? }`.
pub async fn run_action(http: &dyn Http, op: &str, config: Option<&Value>, params: &Value, ctx: &Value) -> Outcome {
    if !OPS.contains(&op) {
        return Outcome::fail(format!("Unknown action \"{op}\". Pick one from the action list."));
    }
    match run(http, op, config, params, ctx).await {
        Ok(o) => o,
        Err(e) => Outcome::fail(e),
    }
}

async fn run(http: &dyn Http, op: &str, config: Option<&Value>, p: &Value, ctx: &Value) -> Result<Outcome, String> {
    let event = ctx.get("event");
    let s = |k: &str| str_of(p.get(k));
    let workflow_name = ctx
        .get("run")
        .and_then(|r| r.get("workflowName"))
        .filter(|v| !v.is_null())
        .map_or("workflow".into(), nekko_js::display);
    match op {
        "slack.postMessage" => {
            let auth = format!("Bearer {}", need_token(config, "Slack")?);
            let channel = required(s("channel"), "Channel")?;
            let channel = channel.strip_prefix('#').unwrap_or(&channel).to_string();
            let body = json!({ "channel": channel, "text": required(s("text"), "Message")? });
            let res = http
                .send(post(
                    "https://slack.com/api/chat.postMessage".into(),
                    vec![("Authorization".into(), auth), ("Content-Type".into(), "application/json".into())],
                    Some(nekko_js::stringify(&body)),
                ))
                .await?;
            let json = json_or_null(&res);
            if !res.ok() || !nekko_js::truthy(json.get("ok")) {
                let why = json
                    .get("error")
                    .filter(|e| !e.is_null())
                    .map_or(format!("HTTP {}", res.status), nekko_js::display);
                return Ok(Outcome::fail(format!("Slack postMessage failed: {why}")));
            }
            let channel = json.get("channel").filter(|v| !v.is_null()).map_or("channel".into(), nekko_js::display);
            let ts = js::or_empty(json.get("ts"));
            Ok(Outcome::ok(nekko_js::trim(&format!("Posted to Slack ({channel}, ts {ts})")).to_string()))
        }
        "linear.createIssue" => {
            let tok = need_token(config, "Linear")?;
            let want = required(s("team"), "Team")?.to_lowercase();
            let teams = linear_gql(http, &tok, "{ teams(first: 100) { nodes { id key name } } }", None).await?;
            let nodes = js::arr(js::at(&teams, &["teams", "nodes"]));
            let team = nodes.iter().find(|t| {
                t.get("id").and_then(Value::as_str) == Some(&want)
                    || str_of(t.get("key")).to_lowercase() == want
                    || str_of(t.get("name")).to_lowercase() == want
            });
            let Some(team) = team else {
                return Err(format!("No Linear team matches \"{}\".", js::string(p.get("team"))));
            };
            let mut input = Map::new();
            input.insert("teamId".into(), team.get("id").cloned().unwrap_or(Value::Null));
            input.insert("title".into(), json!(required(s("title"), "Title")?));
            if !s("description").is_empty() {
                input.insert("description".into(), json!(s("description")));
            }
            let data = linear_gql(
                http,
                &tok,
                "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
                Some(json!({ "input": input })),
            )
            .await?;
            let issue = js::at(&data, &["issueCreate", "issue"]).filter(|i| nekko_js::truthy(Some(i)));
            match issue {
                Some(issue) if nekko_js::truthy(js::at(&data, &["issueCreate", "success"])) => {
                    let url = issue
                        .get("url")
                        .filter(|u| nekko_js::truthy(Some(u)))
                        .map(|u| format!(" {}", nekko_js::display(u)));
                    Ok(Outcome::ok(format!(
                        "Created {}{}",
                        js::string(issue.get("identifier")),
                        url.unwrap_or_default()
                    )))
                }
                _ => Ok(Outcome::fail("Linear issueCreate did not succeed.")),
            }
        }
        "linear.commentIssue" => {
            let tok = need_token(config, "Linear")?;
            let want = required(s("issue"), "Issue")?;
            let data = linear_gql(
                http,
                &tok,
                "query($id: String!) { issue(id: $id) { id identifier } }",
                Some(json!({ "id": want })),
            )
            .await?;
            let Some(id) = js::at(&data, &["issue", "id"]).filter(|v| nekko_js::truthy(Some(v))).cloned() else {
                return Err(format!("No Linear issue matches \"{want}\"."));
            };
            let body = required(s("body"), "Comment")?;
            let res = linear_gql(
                http,
                &tok,
                "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
                Some(json!({ "input": { "issueId": id, "body": body } })),
            )
            .await?;
            if !nekko_js::truthy(js::at(&res, &["commentCreate", "success"])) {
                return Ok(Outcome::fail("Linear commentCreate did not succeed."));
            }
            Ok(Outcome::ok(format!("Commented on {}", js::string(js::at(&data, &["issue", "identifier"])))))
        }
        "jira.createIssue" => {
            let (site, headers) = jira_auth(config)?;
            let issue_type = if s("issueType").is_empty() { "Task".to_string() } else { s("issueType") };
            let body = json!({ "fields": {
                "project": { "key": required(s("project"), "Project")? },
                "summary": required(s("summary"), "Summary")?,
                "issuetype": { "name": issue_type },
                "description": adf_doc(&s("description")),
            } });
            let res =
                http.send(post(format!("{site}/rest/api/3/issue"), headers, Some(nekko_js::stringify(&body)))).await?;
            if !res.ok() {
                return Ok(http_error(&res, "Jira createIssue"));
            }
            let json = json_or_null(&res);
            let key = json.get("key").filter(|k| nekko_js::truthy(Some(k)));
            Ok(Outcome::ok(format!(
                "Created {}{}",
                key.map_or("issue".into(), nekko_js::display),
                key.map(|k| format!(" {site}/browse/{}", nekko_js::display(k))).unwrap_or_default()
            )))
        }
        "jira.commentIssue" => {
            let (site, headers) = jira_auth(config)?;
            let key = required(s("issue"), "Issue key")?;
            let body = json!({ "body": adf_doc(&required(s("body"), "Comment")?) });
            let url = format!("{site}/rest/api/3/issue/{}/comment", encode_uri_component(&key));
            let res = http.send(post(url, headers, Some(nekko_js::stringify(&body)))).await?;
            if !res.ok() {
                return Ok(http_error(&res, &format!("Jira comment on {key}")));
            }
            Ok(Outcome::ok(format!("Commented on {key}")))
        }
        "github.commentPR" => {
            let repo = repo_path(&required(pick(p, "repo", event, &["repo", "repository.full_name"]), "Repo")?)?;
            let number = required(
                pick(
                    p,
                    "number",
                    event,
                    &["number", "pull_number", "issue_number", "pull_request.number", "issue.number"],
                ),
                "PR number",
            )?;
            let number = number.strip_prefix('#').unwrap_or(&number).to_string();
            let headers = github_headers(&need_token(config, "GitHub")?);
            let body = json!({ "body": required(s("body"), "Comment")? });
            let url = format!("https://api.github.com/repos/{repo}/issues/{}/comments", encode_uri_component(&number));
            let res = http.send(post(url, headers, Some(nekko_js::stringify(&body)))).await?;
            if !res.ok() {
                return Ok(http_error(&res, &format!("GitHub comment on {repo}#{number}")));
            }
            let json = json_or_null(&res);
            let link = json
                .get("html_url")
                .filter(|u| nekko_js::truthy(Some(u)))
                .map(|u| format!(" {}", nekko_js::display(u)));
            Ok(Outcome::ok(format!("Commented on {repo}#{number}{}", link.unwrap_or_default())))
        }
        "github.setCommitStatus" => {
            let repo = repo_path(&required(pick(p, "repo", event, &["repo", "repository.full_name"]), "Repo")?)?;
            let sha = required(
                pick(
                    p,
                    "sha",
                    event,
                    &[
                        "sha",
                        "after",
                        "head_sha",
                        "checkout_sha",
                        "head",
                        "head_commit.id",
                        "pull_request.head.sha",
                        "object_attributes.last_commit.id",
                    ],
                ),
                "Commit SHA",
            )?;
            let raw = required(s("state"), "State")?.to_lowercase();
            let state = if raw == "failed" { "failure".to_string() } else { raw.clone() };
            if !["error", "failure", "pending", "success"].contains(&state.as_str()) {
                return Err(format!("GitHub commit state \"{raw}\" must be success, failure, error, or pending."));
            }
            let headers = github_headers(&need_token(config, "GitHub")?);
            let mut body = Map::new();
            body.insert("state".into(), json!(state));
            let context =
                if s("context").is_empty() { format!("nekko-agent/{}", slugify(&workflow_name)) } else { s("context") };
            body.insert("context".into(), json!(context));
            if !s("description").is_empty() {
                body.insert("description".into(), json!(slice16(&s("description"), 140)));
            }
            if !s("targetUrl").is_empty() {
                body.insert("target_url".into(), json!(s("targetUrl")));
            }
            let url = format!("https://api.github.com/repos/{repo}/statuses/{}", encode_uri_component(&sha));
            let res = http.send(post(url, headers, Some(nekko_js::stringify(&Value::Object(body))))).await?;
            let short = slice16(&sha, 8);
            if !res.ok() {
                return Ok(http_error(&res, &format!("GitHub commit status on {repo}@{short}")));
            }
            Ok(Outcome::ok(format!("Set {repo}@{short} \u{2192} {state}")))
        }
        "github.runFailureLogs" => {
            let repo = repo_path(&required(pick(p, "repo", event, &["repo", "repository.full_name"]), "Repo")?)?;
            let run_id = required(pick(p, "run_id", event, &["run_id", "workflow_run.id"]), "Run id")?;
            let tok = need_token(config, "GitHub")?;
            Ok(crate::github::run_failure_logs(http, &tok, &repo, &run_id, p).await)
        }
        "github.upsertPRComment" => {
            let number = pick(p, "number", event, &["number", "pull_number", "issue_number", "pull_request.number"]);
            let number = number.strip_prefix('#').unwrap_or(&number).to_string();
            // A failed push with no PR: the step ends cleanly so the run can too.
            if number.is_empty() {
                return Ok(Outcome::ok("No PR, skipped."));
            }
            let repo = repo_path(&required(pick(p, "repo", event, &["repo", "repository.full_name"]), "Repo")?)?;
            let body = required(s("body"), "Comment")?;
            let marker =
                if s("marker").is_empty() { crate::github::default_marker(&workflow_name) } else { s("marker") };
            let tok = need_token(config, "GitHub")?;
            crate::github::upsert_pr_comment(http, &tok, &repo, &number, &body, &marker).await
        }
        "gitlab.setCommitStatus" => {
            let base = gitlab_base(settings_of(config))?;
            let project = encode_uri_component(&required(
                pick(p, "project", event, &["repo", "project", "project.path_with_namespace", "project_id"]),
                "Project",
            )?);
            let sha = required(
                pick(
                    p,
                    "sha",
                    event,
                    &["sha", "after", "checkout_sha", "head_commit.id", "object_attributes.last_commit.id"],
                ),
                "Commit SHA",
            )?;
            let raw = required(s("state"), "State")?.to_lowercase();
            let state = if raw == "failure" { "failed".to_string() } else { raw.clone() };
            if !["pending", "running", "success", "failed", "canceled"].contains(&state.as_str()) {
                return Err(format!(
                    "GitLab commit state \"{raw}\" must be success, failed, running, pending, or canceled."
                ));
            }
            let name =
                if s("name").is_empty() { format!("nekko-agent/{}", slugify(&workflow_name)) } else { s("name") };
            let mut pairs = vec![("state", state.clone()), ("name", name)];
            if !s("description").is_empty() {
                pairs.push(("description", s("description")));
            }
            if !s("targetUrl").is_empty() {
                pairs.push(("target_url", s("targetUrl")));
            }
            let qs = js::search_params(&pairs.iter().map(|(k, v)| (*k, v.as_str())).collect::<Vec<_>>());
            let tok = need_token(config, "GitLab")?;
            let url = format!("{base}/api/v4/projects/{project}/statuses/{}?{qs}", encode_uri_component(&sha));
            let res = http.send(post(url, vec![("PRIVATE-TOKEN".into(), tok)], None)).await?;
            let shown = decode_uri_component(&project);
            let short = slice16(&sha, 8);
            if !res.ok() {
                return Ok(http_error(&res, &format!("GitLab commit status on {shown}@{short}")));
            }
            Ok(Outcome::ok(format!("Set {shown}@{short} \u{2192} {state}")))
        }
        "gitlab.commentMR" => {
            let base = gitlab_base(settings_of(config))?;
            let project = encode_uri_component(&required(
                pick(p, "project", event, &["repo", "project", "project.path_with_namespace", "project_id"]),
                "Project",
            )?);
            let iid = required(pick(p, "mr", event, &["iid", "number", "object_attributes.iid"]), "MR number")?;
            let iid = iid.strip_prefix('!').unwrap_or(&iid).to_string();
            let tok = need_token(config, "GitLab")?;
            let body = json!({ "body": required(s("body"), "Comment")? });
            let url = format!("{base}/api/v4/projects/{project}/merge_requests/{}/notes", encode_uri_component(&iid));
            let res = http
                .send(post(
                    url,
                    vec![("PRIVATE-TOKEN".into(), tok), ("Content-Type".into(), "application/json".into())],
                    Some(nekko_js::stringify(&body)),
                ))
                .await?;
            let shown = decode_uri_component(&project);
            if !res.ok() {
                return Ok(http_error(&res, &format!("GitLab comment on {shown}!{iid}")));
            }
            Ok(Outcome::ok(format!("Commented on {shown}!{iid}")))
        }
        "discord.postMessage" => {
            let channel = required(s("channel"), "Channel id")?;
            let auth = format!("Bot {}", need_token(config, "Discord")?);
            let body = json!({ "content": required(s("text"), "Message")? });
            let url = format!("https://discord.com/api/v10/channels/{}/messages", encode_uri_component(&channel));
            let res = http
                .send(post(
                    url,
                    vec![("Authorization".into(), auth), ("Content-Type".into(), "application/json".into())],
                    Some(nekko_js::stringify(&body)),
                ))
                .await?;
            if !res.ok() {
                return Ok(http_error(&res, "Discord postMessage"));
            }
            Ok(Outcome::ok(format!("Posted to Discord channel {channel}")))
        }
        "teams.postMessage" => {
            let webhook = js::setting(settings_of(config), "webhookUrl");
            if webhook.is_empty() {
                return Err("The Teams connector has no incoming webhook URL saved.".into());
            }
            let u = parse_url(&webhook).ok_or("The saved Teams webhook URL isn't valid.")?;
            if !teams_webhook_ok(&u) {
                return Err("The Teams webhook URL must be an https URL on *.webhook.office.com.".into());
            }
            let body = json!({ "text": required(s("text"), "Message")? });
            let res = http
                .send(post(
                    webhook,
                    vec![("Content-Type".into(), "application/json".into())],
                    Some(nekko_js::stringify(&body)),
                ))
                .await?;
            if !res.ok() {
                return Ok(http_error(&res, "Teams postMessage"));
            }
            Ok(Outcome::ok("Posted to the Teams channel."))
        }
        "webhook.post" => {
            let raw = required(s("url"), "URL")?;
            let u = parse_url(&raw).ok_or_else(|| format!("\"{raw}\" isn't a valid URL."))?;
            // Unattended: plain https only (http would leak the body).
            if u.protocol != "https:" {
                return Err("webhook.post only sends to https URLs.".into());
            }
            let content_type =
                if s("contentType").is_empty() { "application/json".to_string() } else { s("contentType") };
            let mut req = post(
                raw.clone(),
                vec![("Content-Type".into(), content_type), ("User-Agent".into(), "nekko-agent-workflow".into())],
                Some(required(s("body"), "Body")?),
            );
            // Never follow a redirect: it could hand the body to another host.
            req.no_redirect = true;
            let res = http.send(req).await?;
            if !res.ok() {
                return Ok(http_error(&res, &format!("POST {}", u.host)));
            }
            let path = if u.pathname == "/" { String::new() } else { u.pathname.clone() };
            Ok(Outcome::ok(format!("POST {}{path} \u{2192} {}", u.host, res.status)))
        }
        other => Ok(Outcome::fail(format!("Unknown action \"{other}\". Pick one from the action list."))),
    }
}
