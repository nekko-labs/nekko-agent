//! The real `nekkod` binary end to end: the CI runner channels over a seeded
//! `runners/runners.json`. No helper is staged beside the test binary, so the
//! runner reports that VM support is unavailable and nothing starts.

use crate::common::*;

// VMs run only on macOS; elsewhere the runner channels are unknown, which the UI shows as unavailable.
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn runner_channels_are_unknown_on_windows() {
    let data = tempfile::tempdir().unwrap();
    let d = start_with(Some(data.path()));
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
        "label": "nekko-mac",
        "settings": { "enabled": true, "macosSlots": 7, "memoryPerVmMb": 0 },
        "github": { "appId": 424242, "installationId": 9, "repos": ["o/r"] },
    }]);
    std::fs::write(runners.join("runners.json"), record.to_string()).unwrap();
    let d = start_with(Some(data.path()));
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
