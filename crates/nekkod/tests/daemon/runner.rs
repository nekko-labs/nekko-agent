//! The real `nekkod` binary end to end: the CI runner channels over a seeded
//! `runners/runners.json`. No helper is staged beside the test binary, so the
//! runner reports that VM support is unavailable and nothing starts.

use crate::common::*;

/// With no helper the job still answers, and Check would say why it cannot run.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn image_channels_answer_with_nothing_built() {
    let data = tempfile::tempdir().unwrap();
    let d = start_with(data.path());
    let (status, view) = post(d.port, "runner:imageStatus", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!((view["state"].as_str(), view["canResume"].as_bool()), (Some("none"), Some(false)), "{view}");

    let (status, err) = post(d.port, "runner:imageResume", json!([]), Some(TOKEN)).await;
    assert!(status >= 400, "{err}");
    assert_eq!(err["error"], "There is no setup to resume.");

    let (status, err) = post(d.port, "runner:imageBuild", json!([{ "kind": "windows" }]), Some(TOKEN)).await;
    assert!(status >= 400, "{err}");

    let (status, view) = post(d.port, "runner:imageCancel", json!([]), Some(TOKEN)).await;
    assert_eq!((status, view["state"].as_str()), (200, Some("none")), "{view}");
}

// VMs run only on macOS; elsewhere the runner channels are unknown, which the UI shows as unavailable.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn runner_channels_are_unknown_on_windows() {
    let data = tempfile::tempdir().unwrap();
    let d = start_with(data.path());
    let (status, body) = post(d.port, "runner:list", json!([]), Some(TOKEN)).await;
    assert!(status >= 400, "{status}");
    assert_eq!(body["error"], "unknown channel runner:list");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn runner_channels_round_trip() {
    let data = tempfile::tempdir().unwrap();
    let runners = data.path().join("runners");
    std::fs::create_dir_all(&runners).unwrap();
    let record = json!([{
        "id": "r1",
        "scope": { "kind": "repo", "owner": "o", "repo": "r" },
        "label": "nekko-cloud-mac",
        "settings": { "enabled": true, "macosSlots": 7, "memoryPerVmMb": 0 },
        "github": { "appId": 424242, "installationId": 9, "repos": ["o/r"] },
    }]);
    std::fs::write(runners.join("runners.json"), record.to_string()).unwrap();
    let d = start_with(data.path());
    let events = record_channel(d.port, "runner:changed");

    let (status, list) = post(d.port, "runner:list", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{list}");
    let views = list.as_array().unwrap();
    assert_eq!(views.len(), 1);
    let v = &views[0];
    assert_eq!(
        (v["config"]["settings"]["macosSlots"].as_u64(), v["config"]["settings"]["memoryPerVmMb"].as_u64()),
        (Some(2), Some(8192))
    );
    assert_eq!(v["state"], "error");
    // No VM support here, so the loop never runs and no Mac sample is taken: `host` is the
    // all-zero view. A positive `ramMb` is covered by `views_carry_host_facts` in the supervisor tests.
    assert_eq!((v["host"]["ramMb"].as_u64(), v["host"]["networkTrusted"].as_bool()), (Some(0), Some(false)), "{v}");
    assert_eq!(v["recent"], json!([]));
    assert!(v["error"].as_str().is_some_and(|e| e.contains("VM support unavailable")), "{v}");

    let (_, updated) = post(d.port, "runner:update", json!(["r1", { "maxJobMinutes": 5 }]), Some(TOKEN)).await;
    assert_eq!(updated["config"]["settings"]["maxJobMinutes"], 10, "{updated}");
    assert_eq!(updated["config"]["settings"]["enabled"], true, "a patch keeps the other settings");
    until("a runner:changed event", Duration::from_secs(10), || {
        let got = events.lock().unwrap().iter().any(|e| e[0]["config"]["settings"]["maxJobMinutes"] == 10);
        async move { got.then_some(()) }
    })
    .await;

    let (_, off) = post(d.port, "runner:setEnabled", json!(["r1", false]), Some(TOKEN)).await;
    assert_eq!(off["state"], "off", "{off}");

    let (status, gone) = post(d.port, "runner:remove", json!(["r1"]), Some(TOKEN)).await;
    assert_eq!((status, gone), (200, Value::Null));
    let (_, list) = post(d.port, "runner:list", json!([]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(runners.join("runners.json")).unwrap()).unwrap();
    assert_eq!(saved, json!([]));

    let (status, err) = post(d.port, "runner:update", json!(["nope", {}]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(err.to_string().contains("No runner with that id."), "{err}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn gitlab_connect_rejects_unknown_provider() {
    let data = tempfile::tempdir().unwrap();
    let d = start_with(data.path());
    let (status, err) = post(d.port, "runner:connect", json!([{ "provider": "buildkite" }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(err.to_string().contains("Unknown CI provider."), "{err}");
    let (status, err) =
        post(d.port, "runner:connect", json!([{ "provider": "gitlab", "accessToken": "glpat-secret" }]), Some(TOKEN))
            .await;
    assert_ne!(status, 200);
    assert!(
        err.to_string().contains("not a valid connect request") && !err.to_string().contains("glpat-secret"),
        "{err}"
    );
}

// Stops at the local page: past Create, a key would reach the login keychain, which tests never write.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn github_setup_channels_serve_the_local_page() {
    let data = tempfile::tempdir().unwrap();
    let d = start_with_env(data.path(), json!({}), &[("NEKKO_GH_PATH", Some("/nonexistent/gh"))]);
    let events = record_channel(d.port, "runner:githubChanged");

    let (status, accounts) = post(d.port, "runner:githubAccounts", json!([]), Some(TOKEN)).await;
    assert_eq!((status, accounts), (200, json!({ "login": null, "accounts": [] })));
    let (_, idle) = post(d.port, "runner:githubStatus", json!([]), Some(TOKEN)).await;
    assert_eq!(idle["step"], "idle", "{idle}");

    let bad = json!([{ "owner": "a/b", "kind": "user" }]);
    let (status, err) = post(d.port, "runner:githubStart", bad, Some(TOKEN)).await;
    assert!(status >= 400 && err.to_string().contains("not a GitHub account name"), "{status} {err}");

    let start = json!([{ "owner": "acme", "kind": "org" }]);
    let (status, started) = post(d.port, "runner:githubStart", start, Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    let url = started["url"].as_str().unwrap();
    assert!(url.starts_with("http://localhost:") && url.contains("/start?t="), "{url}");
    let page = reqwest::get(url.replace("localhost", "127.0.0.1")).await.unwrap().text().await.unwrap();
    assert!(page.contains("https://github.com/organizations/acme/settings/apps/new?state="), "{page}");
    let (_, status_now) = post(d.port, "runner:githubStatus", json!([]), Some(TOKEN)).await;
    assert_eq!((status_now["step"].as_str(), status_now["owner"].as_str()), (Some("create"), Some("acme")));
    until("a runner:githubChanged event", Duration::from_secs(10), || {
        let got = events.lock().unwrap().iter().any(|e| e["step"] == "create");
        async move { got.then_some(()) }
    })
    .await;

    let (_, cancelled) = post(d.port, "runner:githubCancel", json!([]), Some(TOKEN)).await;
    assert_eq!(cancelled["step"], "idle", "{cancelled}");
    let page = url.replace("localhost", "127.0.0.1");
    until("the port to close", Duration::from_secs(10), || {
        let page = page.clone();
        async move { reqwest::get(page).await.is_err().then_some(()) }
    })
    .await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fork_approval_set_through_gh_releases_a_held_runner() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let runners = data.path().join("runners");
    std::fs::create_dir_all(&runners).unwrap();
    let record = json!([{
        "id": "r1",
        "scope": { "kind": "org", "org": "acme" },
        "label": "nekko-cloud-mac",
        "settings": { "enabled": false },
        "github": { "appId": 424242, "installationId": 9, "groupId": 3, "repos": ["acme/a"], "allowPublic": true, "forkApprovalOpen": true },
    }]);
    std::fs::write(runners.join("runners.json"), record.to_string()).unwrap();
    let gh = data.path().join("fake-gh");
    std::fs::write(&gh, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let d = start_with_env(data.path(), json!({}), &[("NEKKO_GH_PATH", gh.to_str())]);

    let (status, _) = post(d.port, "runner:setEnabled", json!(["r1", true]), Some(TOKEN)).await;
    assert!(status >= 400, "held until approval is settled");
    let (status, approval) = post(d.port, "runner:setForkApproval", json!([{ "runnerId": "r1" }]), Some(TOKEN)).await;
    assert_eq!((status, approval["done"].as_bool()), (200, Some(true)), "{approval}");
    let (status, on) = post(d.port, "runner:setEnabled", json!(["r1", true]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{on}");
    assert_eq!(on["config"]["settings"]["enabled"], true);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn gitlab_record_lists_and_removes() {
    let data = tempfile::tempdir().unwrap();
    let runners = data.path().join("runners");
    std::fs::create_dir_all(&runners).unwrap();
    let record = json!([{
        "id": "gl-42",
        "scope": { "kind": "org", "org": "g" },
        "label": "nekko-cloud-mac",
        "settings": { "enabled": true },
        "gitlab": { "baseUrl": "https://gitlab.com", "namespaceId": 42, "projects": ["g/a"] },
    }]);
    std::fs::write(runners.join("runners.json"), record.to_string()).unwrap();
    // The runner vault is a file only where there is no OS keystore; tests never write the login keychain.
    let file_vault = !cfg!(any(target_os = "macos", windows));
    use nekko_cloud::vault::Vault;
    let vault = nekko_cloud::vault::FileVault::new(runners.join("secrets.json"));
    if file_vault {
        vault.set("gitlab-token-gl-42", "glpat-x").unwrap();
    }
    let d = start_with(data.path());
    let (status, list) = post(d.port, "runner:list", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!((list[0]["config"]["id"].as_str(), list[0]["state"].as_str()), (Some("gl-42"), Some("error")), "{list}");
    let (_, off) = post(d.port, "runner:setEnabled", json!(["gl-42", false]), Some(TOKEN)).await;
    assert_eq!(off["state"], "off", "{off}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(runners.join("runners.json")).unwrap()).unwrap();
    assert_eq!(saved[0]["settings"]["enabled"], false);
    assert_eq!(saved[0]["gitlab"]["namespaceId"], 42, "saved back with its gitlab key: {saved}");
    assert!(saved[0].get("github").is_none());
    let (status, gone) = post(d.port, "runner:remove", json!(["gl-42"]), Some(TOKEN)).await;
    assert_eq!((status, gone), (200, Value::Null));
    let (_, list) = post(d.port, "runner:list", json!([]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    if file_vault {
        assert_eq!(vault.get("gitlab-token-gl-42"), None, "the token goes with the record");
    }
}
