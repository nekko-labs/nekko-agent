use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct Fake {
    raw: Mutex<Option<String>>,
    old: Mutex<BTreeMap<(String, String), String>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    old_reads: AtomicUsize,
    denied: AtomicBool,
    legacy_denied: AtomicBool,
    refuse_write: AtomicBool,
    bad_readback: AtomicBool,
}

impl Store for Arc<Fake> {
    fn read(&self) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.denied.load(Ordering::SeqCst) {
            return Err("denied".into());
        }
        if self.bad_readback.load(Ordering::SeqCst) && self.writes.load(Ordering::SeqCst) > 0 {
            return Ok(None);
        }
        Ok(self.raw.lock().unwrap().clone())
    }
    fn write(&self, value: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.refuse_write.load(Ordering::SeqCst) {
            return Err("locked".into());
        }
        *self.raw.lock().unwrap() = Some(value.into());
        Ok(())
    }
    fn legacy(&self, service: &str, name: &str) -> Result<Option<String>, String> {
        self.old_reads.fetch_add(1, Ordering::SeqCst);
        if self.legacy_denied.load(Ordering::SeqCst) {
            return Err("denied".into());
        }
        Ok(self.old.lock().unwrap().get(&(service.into(), name.into())).cloned())
    }
    fn remove_legacy(&self, service: &str, name: &str) {
        self.old.lock().unwrap().remove(&(service.into(), name.into()));
    }
}

fn fixture() -> (Arc<Fake>, Arc<Shared>) {
    let fake = Arc::new(Fake::default());
    let shared = Arc::new(Shared::new(Box::new(fake.clone())));
    (fake, shared)
}

fn vault(shared: &Arc<Shared>, service: &str) -> ConsolidatedVault {
    ConsolidatedVault { shared: shared.clone(), service: service.into() }
}

#[test]
fn fifteen_secrets_across_subsystems_need_one_shared_read() {
    let (fake, shared) = fixture();
    let mut secrets = Secrets::new();
    for i in 0..15 {
        secrets.entry(format!("scope{}", i % 3)).or_default().insert(format!("key{i}"), Some(format!("value{i}")));
    }
    *fake.raw.lock().unwrap() = Some(serde_json::to_string(&secrets).unwrap());
    std::thread::scope(|s| {
        for i in 0..15 {
            let v = vault(&shared, &format!("scope{}", i % 3));
            s.spawn(move || {
                for _ in 0..3 {
                    assert_eq!(v.get(&format!("key{i}")), Some(format!("value{i}")));
                }
            });
        }
    });
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fake.old_reads.load(Ordering::SeqCst), 0);
    assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn denial_is_cached_and_never_falls_back_to_a_storm_of_legacy_prompts() {
    let (fake, shared) = fixture();
    fake.denied.store(true, Ordering::SeqCst);
    for i in 0..15 {
        let v = vault(&shared, &format!("scope{i}"));
        assert_eq!(v.get("key"), None);
        assert!(v.set("key", "replacement").is_err());
        v.delete("key");
    }
    assert_eq!(fake.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fake.old_reads.load(Ordering::SeqCst), 0);
    assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
}

#[test]
fn corrupt_bundle_is_not_treated_as_an_empty_vault() {
    let (fake, shared) = fixture();
    *fake.raw.lock().unwrap() = Some("not JSON".into());
    let v = vault(&shared, "settings");
    assert_eq!(v.get("key"), None);
    assert!(v.set("key", "new").is_err());
    v.delete("key");
    assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fake.raw.lock().unwrap().as_deref(), Some("not JSON"));
}

#[test]
fn legacy_migration_verifies_replacement_and_preserves_namespaces_and_chunks() {
    let (fake, shared) = fixture();
    let a = vault(&shared, "settings");
    let b = vault(&shared, "cloud");
    let token = "é".repeat(2400);
    for (name, value) in [("token", "é".repeat(1000)), ("token#1", "é".repeat(1000)), ("token#2", "é".repeat(400))] {
        fake.old.lock().unwrap().insert(("settings".into(), name.into()), value);
    }
    assert_eq!(crate::get(&a, "token"), Some(token));
    assert!(fake.old.lock().unwrap().is_empty());
    assert_eq!(fake.writes.load(Ordering::SeqCst), 3);
    b.set("token", "other").unwrap();
    assert_eq!(b.get("token").as_deref(), Some("other"));
    assert!(crate::put(&a, "token", "short"));
    assert_eq!(a.get("token#1"), None);
    assert_eq!(a.get("token#2"), None);
    let restarted = Arc::new(Shared::new(Box::new(fake.clone())));
    assert_eq!(crate::get(&vault(&restarted, "settings"), "token").as_deref(), Some("short"));
    assert_eq!(vault(&restarted, "cloud").get("token").as_deref(), Some("other"));
}

#[test]
fn failed_migration_keeps_original_readable_and_does_not_retry_writes() {
    for bad_readback in [false, true] {
        let (fake, shared) = fixture();
        fake.old.lock().unwrap().insert(("settings".into(), "key".into()), "original".into());
        fake.bad_readback.store(bad_readback, Ordering::SeqCst);
        fake.refuse_write.store(!bad_readback, Ordering::SeqCst);
        let v = vault(&shared, "settings");
        for _ in 0..3 {
            assert_eq!(v.get("key").as_deref(), Some("original"));
        }
        assert!(v.set("other", "new").is_err());
        assert_eq!(fake.writes.load(Ordering::SeqCst), 1);
        assert_eq!(fake.old_reads.load(Ordering::SeqCst), 1);
        assert_eq!(fake.old.lock().unwrap().len(), 1);
    }
}

#[test]
fn deletion_tombstone_prevents_legacy_resurrection_after_restart() {
    let (fake, shared) = fixture();
    let v = vault(&shared, "settings");
    v.set("key", "secret").unwrap();
    v.delete("key");
    // Simulate an old item whose deletion failed, or an older copy reappearing.
    fake.old.lock().unwrap().insert(("settings".into(), "key".into()), "old".into());
    let restarted = Arc::new(Shared::new(Box::new(fake.clone())));
    assert_eq!(vault(&restarted, "settings").get("key"), None);
    assert_eq!(fake.old_reads.load(Ordering::SeqCst), 0);
}

#[test]
fn unchanged_saves_do_not_touch_keychain_and_profiles_do_not_share() {
    let (fake, shared) = fixture();
    let v = vault(&shared, "settings");
    v.set("key", "value").unwrap();
    let reads = fake.reads.load(Ordering::SeqCst);
    let writes = fake.writes.load(Ordering::SeqCst);
    v.set("key", "value").unwrap();
    assert_eq!(fake.reads.load(Ordering::SeqCst), reads);
    assert_eq!(fake.writes.load(Ordering::SeqCst), writes);
    let (_, other) = fixture();
    assert_eq!(vault(&other, "settings").get("key"), None);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "native test uses disposable Keychain items with system interaction disabled"]
fn native_keychain_round_trip_without_prompts() {
    // Only this opt-in test process is affected. Never allow a system consent
    // dialog during verification or change the user's default keychain/profile.
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
    }
    assert_eq!(unsafe { SecKeychainSetUserInteractionAllowed(0) }, 0);
    let id = format!(
        "nekko-vault-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    );
    let native = Native { label: format!("Nekko Agent: API keys, sign-ins and encryption keys ({id})") };
    let old_service = format!("{id}.old");
    let old = keyring::Entry::new(&old_service, "token").unwrap();
    struct Cleanup(Vec<keyring::Entry>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for entry in &self.0 {
                let _ = entry.delete_credential();
            }
        }
    }
    let _cleanup = Cleanup(vec![keyring::Entry::new(&native.label, "Nekko Agent credentials").unwrap(), old]);
    _cleanup.0[1].set_password("synthetic legacy token").unwrap();
    let shared = Arc::new(Shared::new(Box::new(native)));
    let a = vault(&shared, &old_service);
    assert_eq!(a.get("token").as_deref(), Some("synthetic legacy token"));
    assert!(matches!(_cleanup.0[1].get_password(), Err(keyring::Error::NoEntry)));
    let b = vault(&shared, "cloud");
    assert!(crate::put(&b, "long", &"x".repeat(5000)));
    let bundle = _cleanup.0[0].get_password().unwrap();
    let map: Secrets = serde_json::from_str(&bundle).unwrap();
    assert_eq!(map[&old_service]["token"].as_deref(), Some("synthetic legacy token"));
    assert_eq!(map["cloud"].len(), 5);
    crate::delete(&b, "long");
    assert_eq!(crate::get(&b, "long"), None);
}

#[test]
fn denying_one_legacy_item_stops_the_rest_of_the_startup_scan() {
    let (fake, shared) = fixture();
    fake.legacy_denied.store(true, Ordering::SeqCst);
    fake.old.lock().unwrap().insert(("settings".into(), "key".into()), "original".into());
    for i in 0..15 {
        assert_eq!(vault(&shared, &format!("scope{i}")).get("key"), None);
    }
    assert_eq!(fake.old_reads.load(Ordering::SeqCst), 1);
    assert_eq!(fake.writes.load(Ordering::SeqCst), 0);
    assert_eq!(fake.old.lock().unwrap().len(), 1);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "native test uses disposable Keychain items with system interaction disabled"]
fn native_keychain_public_handles_share_one_profile_item() {
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
    }
    assert_eq!(unsafe { SecKeychainSetUserInteractionAllowed(0) }, 0);
    let dir = tempfile::tempdir().unwrap();
    let a = super::vault(dir.path(), "settings");
    let b = super::vault(dir.path(), "cloud");
    let scope = crate::service(dir.path(), "credentials");
    let label = format!("Nekko Agent: API keys, sign-ins and encryption keys ({})", scope.rsplit('.').next().unwrap());
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = security_framework::passwords::delete_generic_password(&self.0, "Nekko Agent credentials");
        }
    }
    let cleanup = Cleanup(label.clone());
    a.set("token", "synthetic settings token").unwrap();
    b.set("token", "synthetic cloud token").unwrap();
    let entry = keyring::Entry::new(&label, "Nekko Agent credentials").unwrap();
    let map: Secrets = serde_json::from_str(&entry.get_password().unwrap()).unwrap();
    assert_eq!(map[&crate::service(dir.path(), "settings")]["token"].as_deref(), Some("synthetic settings token"));
    assert_eq!(map[&crate::service(dir.path(), "cloud")]["token"].as_deref(), Some("synthetic cloud token"));
    // Removing the test item externally proves subsequent public handles really
    // share the process cache, rather than re-reading the system keychain.
    drop(cleanup);
    assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    let again = super::vault(dir.path(), "settings");
    assert_eq!(again.get("token").as_deref(), Some("synthetic settings token"));
}

/// A store that records whether each call it gets is counted as waiting.
#[derive(Default)]
struct Watched {
    uncounted: AtomicUsize,
    calls: AtomicUsize,
}

impl Watched {
    fn note(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if crate::waits::longest().is_none() {
            self.uncounted.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl Store for Arc<Watched> {
    fn read(&self) -> Result<Option<String>, String> {
        self.note();
        Ok(None)
    }
    fn write(&self, _: &str) -> Result<(), String> {
        self.note();
        Ok(())
    }
    fn legacy(&self, _: &str, _: &str) -> Result<Option<String>, String> {
        self.note();
        Ok(None)
    }
    fn remove_legacy(&self, _: &str, _: &str) {
        self.note();
    }
}

/// nekkod tells the app it is waiting on a Keychain dialog only from these
/// counts. Uncounted, the app kills the daemon at its ready timeout and the
/// next start shows the same dialog again.
#[test]
fn every_keychain_call_counts_as_a_wait() {
    let watched = Arc::new(Watched::default());
    let v = ConsolidatedVault { shared: Arc::new(Shared::new(Box::new(watched.clone()))), service: "svc".into() };
    assert_eq!(v.get("missing"), None);
    let _ = v.set("name", "value");
    v.delete("name");
    assert!(watched.calls.load(Ordering::SeqCst) >= 4);
    assert_eq!(watched.uncounted.load(Ordering::SeqCst), 0);
}
