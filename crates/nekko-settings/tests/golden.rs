//! The Rust settings store against the TS one.
//!
//! `golden/expected.json` is written by the real `getSettings`,
//! `saveSettings` and `resetSettings` (packages/host/src/settings.golden.test.ts,
//! which also fails if it goes stale) for every case in `golden/cases.json`.
//! Every returned value must match as text (key order and number format
//! included) and so must the bytes left in settings.json.

use nekko_settings::SettingsStore;
use serde_json::Value;
use std::path::Path;

fn golden() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

fn read(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(golden().join(name)).unwrap()).unwrap()
}

#[test]
fn every_case_matches_the_ts_store() {
    let cases = read("cases.json");
    let expected = read("expected.json");
    let (cases, expected) = (cases.as_array().unwrap(), expected.as_array().unwrap());
    assert_eq!(cases.len(), expected.len(), "expected.json is stale; rerun the TS golden test with UPDATE_GOLDEN=1");
    for (i, (case, want)) in cases.iter().zip(expected).enumerate() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(want["name"], case["name"]);
        let dir = std::env::temp_dir().join(format!("nekko-settings-golden-{}-{i}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(text) = case["file"].as_str() {
            std::fs::write(dir.join("settings.json"), text).unwrap();
        }
        let store = SettingsStore::new(&dir);
        for (j, op) in case["ops"].as_array().unwrap().iter().enumerate() {
            let got = match op["op"].as_str().unwrap() {
                "get" => Ok(store.get()),
                "reset" => store.reset(),
                _ => store.update(op.get("patch").unwrap_or(&Value::Null)),
            };
            let got = match got {
                Ok(v) => serde_json::json!({ "value": nekko_js::stringify(&v) }),
                Err(_) => serde_json::json!({ "error": true }),
            };
            assert_eq!(got, want["results"][j], "{name}: op {j}");
        }
        let file = std::fs::read_to_string(dir.join("settings.json")).ok();
        assert_eq!(file.as_deref(), want["file"].as_str(), "{name}: settings.json differs");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
