use nekko_settings::{SettingsStore, from_text};
use serde_json::{Value, json};

#[test]
fn restoration_recovery_is_strict_opt_in_and_persists() {
    for value in [Value::Null, json!(false), json!("true"), json!(1), json!(true)] {
        let settings = from_text(&json!({"autoResumeOnInternetRestore":value}).to_string());
        assert_eq!(settings["autoResumeOnInternetRestore"], value == json!(true));
    }
    assert_ne!(from_text("{}").get("autoResumeOnInternetRestore"), Some(&json!(true)));
    let dir = std::env::temp_dir().join(format!("nekko-connectivity-settings-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = SettingsStore::new(&dir);
    assert_eq!(
        store.update(&json!({"autoResumeOnInternetRestore":true})).unwrap()["autoResumeOnInternetRestore"],
        true
    );
    assert_eq!(SettingsStore::new(&dir).get()["autoResumeOnInternetRestore"], true);
    assert_eq!(
        store.update(&json!({"autoResumeOnInternetRestore":"true"})).unwrap()["autoResumeOnInternetRestore"],
        false
    );
    assert_ne!(store.reset().unwrap().get("autoResumeOnInternetRestore"), Some(&json!(true)));
    std::fs::remove_dir_all(dir).ok();
}
