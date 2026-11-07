//! Capability-driven remote management of Nekko Agent only, never the OS.
use crate::routes::Ctx;
use serde_json::{Value, json};
use std::time::Duration;

pub const CHANNELS: &[&str] = &[
    "service:status",
    "service:restart",
    "service:updateState",
    "service:updateCheck",
    "service:updateDownload",
    "service:updateInstall",
];

fn capability(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({ "supported": false, "reason": reason }),
        None => json!({ "supported": true }),
    }
}

/// A missing, unreachable or older shell never implies a restart supervisor.
async fn shell(ctx: &Ctx, tool: &str) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(3), crate::native::bridge(ctx, json!({ "tool": tool })))
        .await
        .map_err(|_| "service-unavailable: desktop bridge timed out".to_string())?
}

pub(crate) async fn prepare_install(ctx: &Ctx) -> Result<(), String> {
    if shell(ctx, "servicePrepareInstall").await? == json!({ "prepared": true }) {
        Ok(())
    } else {
        Err("service-unavailable: desktop did not reserve install".into())
    }
}

fn capabilities(native: Option<&crate::native::Native>, shell: &Value) -> Value {
    let supervised = shell.get("protocolVersion") == Some(&json!(1)) && shell.get("agentRunning") == Some(&json!(true));
    let restart = capability(if native.is_some_and(|n| n.remote_install_pending()) {
        Some("install-already-requested")
    } else {
        (!supervised || shell.get("restart") != Some(&json!(true))).then_some("supervisor-unavailable")
    });
    let (state, updates, install) = match native {
        Some(native) => {
            let updates = native.remote_update_problem();
            let install = if native.remote_install_pending() {
                Some("install-already-requested")
            } else if !supervised || shell.get("updateInstall") != Some(&json!(true)) {
                Some("supervisor-unavailable")
            } else {
                updates.or_else(|| native.remote_install_problem())
            };
            (capability(None), capability(updates), capability(install))
        }
        None => (
            capability(Some("native-updater-unavailable")),
            capability(Some("native-updater-unavailable")),
            capability(Some("native-updater-unavailable")),
        ),
    };
    json!({ "restart": restart, "updateState": state, "updateCheck": updates,
        "updateDownload": updates, "updateInstall": install })
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    if !args.is_empty() {
        return Err("service-invalid: expected no arguments".into());
    }
    let settings = crate::settings::current(ctx).await;
    let enabled = settings.get("manageServiceFromPhone") == Some(&Value::Bool(true));
    if channel != "service:status" && !enabled {
        return Err("service-disabled: enable Manage service from a phone on the host".into());
    }
    let bridge = shell(ctx, "serviceStatus").await.unwrap_or(Value::Null);
    let caps = capabilities(ctx.native.as_deref(), &bridge);
    if channel == "service:status" {
        return Ok(json!({ "protocolVersion": 1, "agentRunning": true,
            "manageServiceFromPhone": enabled, "capabilities": caps }));
    }
    let key = match channel {
        "service:restart" => "restart",
        "service:updateState" => "updateState",
        "service:updateCheck" => "updateCheck",
        "service:updateDownload" => "updateDownload",
        "service:updateInstall" => "updateInstall",
        _ => return Err("service-unsupported: unknown action".into()),
    };
    if caps[key]["supported"] != json!(true) {
        return Err(format!("service-unsupported: {}", caps[key]["reason"].as_str().unwrap_or("unavailable")));
    }
    if channel == "service:restart" {
        // Electron acknowledges and owns the delayed lifecycle, not this daemon.
        let out = shell(ctx, "serviceRestart").await?;
        return if out == json!({ "restarting": true }) {
            Ok(out)
        } else {
            Err("service-unavailable: desktop did not accept restart".into())
        };
    }
    let native = ctx.native.as_ref().ok_or("service-unsupported: native-updater-unavailable")?;
    if channel == "service:updateInstall" {
        native.remote_install(ctx).await?;
        return Ok(json!({ "installing": true }));
    }
    let raw = match channel {
        "service:updateState" => "update:state",
        "service:updateCheck" => "update:check",
        _ => "update:download",
    };
    native.route(ctx, raw, &[]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::NativeConfig;

    #[test]
    fn headless_and_old_shells_do_not_advertise_unsupervised_actions() {
        let caps = capabilities(None, &Value::Null);
        for key in ["restart", "updateState", "updateCheck", "updateDownload", "updateInstall"] {
            assert_eq!(caps[key]["supported"], false);
            assert!(caps[key]["reason"].is_string());
        }
        let native = crate::native::Native::new(NativeConfig::default(), None);
        let caps = capabilities(Some(&native), &json!({ "ok": true }));
        assert_eq!(caps["restart"]["reason"], "supervisor-unavailable");
        assert_eq!(caps["updateInstall"]["reason"], "supervisor-unavailable");
        assert_eq!(caps["updateCheck"]["reason"], "app-not-packaged");
        assert_eq!(caps["updateState"]["supported"], true);
    }

    #[test]
    fn new_supervisor_can_restart_without_an_updater() {
        let caps = capabilities(
            None,
            &json!({ "protocolVersion": 1, "agentRunning": true, "restart": true, "updateInstall": true }),
        );
        assert_eq!(caps["restart"]["supported"], true);
        assert_eq!(caps["updateInstall"]["supported"], false);
    }
}
