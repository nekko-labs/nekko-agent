//! The desktop-only features the TS desktop backend used to serve (PF14
//! step 5 prep, part 6):
//!
//! - the local API server for the CLI, MCP clients and integrations
//!   (`api_server.rs`, `apiServer:*`), with the CLI's link file and the MCP
//!   entries this app wrote kept pointing at it (`refreshLocalAccess`);
//! - the `nekko-agent` launcher on PATH (`cli_install.rs`, `cli:*`);
//! - the MCP target an entry is written with (`integrations:target`);
//! - the workflow webhook listener (`webhook_listener.rs`);
//! - the relay on this computer (`local_relay.rs`, `localRelay:*`) and
//!   "Visible on this network" (`mdns.rs`, `networkVisibility:*`).
//!
//! A port of `apps/desktop/src/backend/{index,channels}.ts` and
//! `main/local-access.ts`. Served for the desktop app only (`config.native`)
//! with the data directory.

use crate::api_server::{self, ApiServer};
use crate::cli_install::{self, AppPaths};
use crate::config::NativeConfig;
use crate::local_relay::LocalRelay;
use crate::mdns::NetworkVisibility;
use crate::routes::Ctx;
use crate::webhook_listener::WebhookListener;
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::Arc;

pub const CHANNELS: &[&str] = &[
    "apiServer:status",
    "apiServer:save",
    "apiServer:newToken",
    "cli:installStatus",
    "cli:install",
    // Internal: how an MCP entry written now should reach this app (small_services.rs).
    "integrations:target",
    "localRelay:status",
    "localRelay:start",
    "localRelay:stop",
    "localRelay:setLan",
    "networkVisibility:status",
    "networkVisibility:start",
    "networkVisibility:stop",
];

pub struct Desktop {
    app: AppPaths,
    api: ApiServer,
    relay: Arc<LocalRelay>,
    visibility: Arc<NetworkVisibility>,
    webhooks: Arc<WebhookListener>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// The saved server settings with the defaults filled in.
async fn api_settings(ctx: &Ctx) -> Value {
    api_server::with_defaults(crate::settings::current(ctx).await.get("apiServer"))
}

async fn save_api(ctx: &Ctx, next: Value) -> Result<(), String> {
    crate::settings::update(ctx, json!({ "apiServer": next })).await.map(|_| ())
}

impl Desktop {
    pub fn new(native: &NativeConfig, data_dir: &Path) -> Arc<Self> {
        let app = AppPaths {
            is_packaged: native.is_packaged,
            exe: native.exe_path.clone(),
            resources: native.resources_path.clone(),
            app_path: native.app_path.clone(),
            user_data: native.user_data.clone().unwrap_or_else(|| data_dir.to_string_lossy().into_owned()),
        };
        let relay_command = native.relay_entry.clone().filter(|_| !app.exe.is_empty()).map(|e| (app.exe.clone(), e));
        let relay = LocalRelay::new(data_dir.join("local-relay.json"), relay_command);
        // Mentions the local relay while it runs.
        let visibility = {
            let relay = Arc::downgrade(&relay);
            NetworkVisibility::new(
                data_dir.join("network-visibility.json"),
                Arc::new(move || relay.upgrade().and_then(|r| r.running_at())),
            )
        };
        Arc::new(Self { app, api: ApiServer::default(), relay, visibility, webhooks: Arc::default() })
    }

    /// Startup, in the old desktop backend's order: the webhook listener; the local API
    /// server with a token, the launcher linked (packaged builds only: a
    /// development run would otherwise put a checkout's CLI on the real
    /// PATH) and everything pointed at it refreshed; then the relay and the
    /// network listing, back on if they were switched on.
    pub async fn start(self: &Arc<Self>, ctx: &Ctx) {
        self.webhooks.manage(ctx.clone());
        // "Start Server on Nekko Launch" off: the server stays down for this
        // launch, written as `enabled: false` so every reader agrees.
        let s = api_settings(ctx).await;
        if s.get("startOnLaunch") == Some(&Value::Bool(false)) && nekko_js::truthy(s.get("enabled")) {
            let mut next = s.clone();
            next["enabled"] = json!(false);
            let _ = save_api(ctx, next).await;
        }
        // On by default, and a fresh install has no token yet: minted here so
        // on-by-default actually serves.
        let s = api_settings(ctx).await;
        if nekko_js::truthy(s.get("enabled")) && nekko_js::trim(s["token"].as_str().unwrap_or("")).is_empty() {
            let mut next = s.clone();
            next["token"] = json!(api_server::new_token());
            let _ = save_api(ctx, next).await;
        }
        self.api.sync(ctx, &api_settings(ctx).await).await;
        if self.app.is_packaged {
            let app = self.app.clone();
            let _ = blocking(move || cli_install::install(&app)).await;
        }
        self.refresh_local_access(ctx).await;
        self.relay.resume();
        self.visibility.resume();
    }

    /// Quit: the servers down, and the CLI told the app is no longer serving,
    /// so a terminal falls back to the data directory instead of dialling a
    /// port that just closed. (A crash skips this; the pid in the link covers it.)
    pub async fn shutdown(&self, ctx: &Ctx) {
        self.webhooks.close();
        self.api.stop().await;
        let s = api_settings(ctx).await;
        let link = json!({
            "url": api_server::client_url(&s, &lan()),
            "token": s["token"],
            "enabled": false,
            "updatedAt": nekko_js::now_ms(),
        });
        cli_install::write_cli_link(&cli_install::cli_link_dir(), &link);
        self.relay.close().await;
        self.visibility.close();
    }

    fn status_of(&self, settings: &Value) -> Value {
        self.api.status(settings)
    }

    /// How an MCP entry written now should reach this app (`subagentTarget`):
    /// the address clients are told to use, the token, and the launcher the
    /// app installed. Empty when the server is off, so an entry falls back to
    /// the portable `npx` form.
    pub async fn target(&self, ctx: &Ctx) -> Value {
        let s = api_settings(ctx).await;
        if !nekko_js::truthy(s.get("enabled")) {
            return json!({});
        }
        let app = self.app.clone();
        let cli = blocking(move || cli_install::install_status(&app)).await.unwrap_or(Value::Null);
        let mut out = Map::new();
        out.insert("url".into(), json!(api_server::client_url(&s, &lan())));
        out.insert("token".into(), s["token"].clone());
        if cli["installed"] == true
            && let Some(bin) = cli.get("binPath")
        {
            out.insert("command".into(), bin.clone());
        }
        Value::Object(out)
    }

    /// Bring the CLI's link file and the MCP entries this app wrote in line
    /// with the server settings (`refreshLocalAccess`).
    async fn refresh_local_access(&self, ctx: &Ctx) {
        let s = api_settings(ctx).await;
        let link = json!({
            "url": api_server::client_url(&s, &lan()),
            "token": s["token"],
            "enabled": s["enabled"],
            "updatedAt": nekko_js::now_ms(),
            "pid": std::process::id(),
        });
        let dir = cli_install::cli_link_dir();
        let _ = blocking(move || cli_install::write_cli_link(&dir, &link)).await;
        let target = self.target(ctx).await;
        // Only tools that already carry an entry, and of those only the ones
        // this app wrote (`integrations:refresh`, small_services.rs).
        tokio::task::spawn_blocking(move || {
            let _ = crate::small_services::refresh_all(&nekko_js::home_dir_string(), &target);
        });
    }

    pub async fn route(self: &Arc<Self>, ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "apiServer:status" => Ok(self.status_of(&api_settings(ctx).await)),
            "apiServer:save" => {
                let mut next = api_settings(ctx).await;
                if let (Some(obj), Some(Value::Object(patch))) = (next.as_object_mut(), args.first()) {
                    for (k, v) in patch {
                        obj.insert(k.clone(), v.clone());
                    }
                }
                // Switching it on without a token would be switching on an
                // unauthenticated agent endpoint, so the first "on" mints one.
                if nekko_js::truthy(next.get("enabled")) && !nekko_js::truthy(next.get("token")) {
                    next["token"] = json!(api_server::new_token());
                }
                save_api(ctx, next).await?;
                self.after_change(ctx).await
            }
            "apiServer:newToken" => {
                let mut next = api_settings(ctx).await;
                next["token"] = json!(api_server::new_token());
                save_api(ctx, next).await?;
                self.after_change(ctx).await
            }
            "cli:installStatus" => {
                let app = self.app.clone();
                blocking(move || cli_install::install_status(&app)).await
            }
            "cli:install" => {
                let app = self.app.clone();
                let status = blocking(move || cli_install::install(&app)).await?;
                // Entries written before the launcher existed used npx; now they can name it.
                self.refresh_local_access(ctx).await;
                Ok(status)
            }
            "integrations:target" => Ok(self.target(ctx).await),
            "localRelay:status" => Ok(self.relay.status_learning_name()),
            "localRelay:start" => Ok(self.relay.start().await),
            "localRelay:stop" => Ok(self.relay.stop().await),
            // `on !== false`: anything but an explicit false keeps the LAN on.
            "localRelay:setLan" => Ok(self.relay.set_lan(args.first() != Some(&Value::Bool(false))).await),
            "networkVisibility:status" => Ok(self.visibility.status()),
            "networkVisibility:start" => Ok(self.visibility.start().await),
            "networkVisibility:stop" => Ok(self.visibility.stop().await),
            other => Err(format!("{other} is not a desktop channel")),
        }
    }

    /// Settings > Connections changed: every listener here follows at once.
    pub async fn connections_changed(&self, ctx: &Ctx) {
        self.api.sync(ctx, &api_settings(ctx).await).await;
        self.relay.recheck().await;
        self.visibility.recheck().await;
    }

    /// A new port, address or token reaches the server, the CLI's link file
    /// and the MCP entries this app wrote, or they keep dialling the old one.
    async fn after_change(&self, ctx: &Ctx) -> Result<Value, String> {
        self.api.sync(ctx, &api_settings(ctx).await).await;
        self.refresh_local_access(ctx).await;
        Ok(self.status_of(&api_settings(ctx).await))
    }
}

/// The address a LAN bind is quoted as (`lanAddress()`, else loopback).
fn lan() -> String {
    api_server::lan_address().unwrap_or_else(|| "127.0.0.1".into())
}
