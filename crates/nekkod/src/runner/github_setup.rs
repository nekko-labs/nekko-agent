//! Connecting GitHub with clicks: a one-time local page posts a GitHub App
//! manifest, GitHub hands back the new app's key, and the owner installs it.
//! No key is pasted, and nothing here starts a runner: the sheet's confirm
//! still goes through `runner:connect`.

use super::github::{pkcs1_der, plain_name};
use serde_json::{Value, json};

const GITHUB: &str = "https://github.com";
const DOCS: &str = "https://nekkoagent.com/docs/ci-runners";
/// GitHub's limit on an app's name.
const MAX_NAME: usize = 34;
const BAD_CONVERSION: &str = "GitHub's answer about the new app was not readable.";

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

#[cfg(test)]
#[path = "github_setup_tests.rs"]
mod tests;
