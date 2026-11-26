//! Settings → Storage end to end: `storage:usage` answers at once and fills in
//! as the walk finishes; `storage:disk` reads the volume.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn measures_each_category_in_the_background() {
    let data = std::env::temp_dir().join(format!("nekkod-storage-{}", std::process::id()));
    std::fs::create_dir_all(data.join("desktop/Cache")).unwrap();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(data.join("desktop/Cache/data_1"), vec![0u8; 4096]).unwrap();
    std::fs::write(data.join("sessions/s_a.json"), br#"{"id":"s_a","messages":[]}"#).unwrap();
    let d = start_with(&data);

    let (status, first) = post(d.port, "storage:usage", json!([{ "refresh": true }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{first}");
    assert!(first["categories"].as_array().is_some_and(|c| c.len() == 6), "{first}");
    assert!(first["disk"]["total"].as_f64().is_some_and(|t| t > 0.0), "{first}");

    let mut usage = first;
    for _ in 0..100 {
        if usage["measuring"] == false && usage["measuredAt"].is_number() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        usage = post(d.port, "storage:usage", json!([]), Some(TOKEN)).await.1;
    }
    let bytes = |id: &str| {
        usage["categories"].as_array().unwrap().iter().find(|c| c["id"] == id).map(|c| c["bytes"].clone()).unwrap()
    };
    assert_eq!(bytes("caches"), json!(4096), "{usage}");
    assert_eq!(bytes("history"), json!(26), "{usage}");
    assert_eq!(bytes("worktrees"), json!(0), "{usage}");

    let (status, disk) = post(d.port, "storage:disk", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert!(disk["free"].as_f64().is_some_and(|f| f > 0.0), "{disk}");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
