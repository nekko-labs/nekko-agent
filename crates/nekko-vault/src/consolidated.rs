//! One macOS Keychain item per profile. The daemon is the profile's single
//! writer; all its subsystem vaults share this lock and the first read's result.

use super::Vault;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

type Secrets = BTreeMap<String, BTreeMap<String, Option<String>>>;

pub(crate) trait Store: Send + Sync {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
    fn legacy(&self, service: &str, name: &str) -> Result<Option<String>, String>;
    fn remove_legacy(&self, service: &str, name: &str);
}

#[derive(Default)]
struct State {
    loaded: Option<Result<Secrets, String>>,
    legacy: BTreeMap<(String, String), Option<String>>,
    write_error: Option<String>,
    legacy_denied: bool,
}

pub(crate) struct Shared {
    store: Box<dyn Store>,
    state: Mutex<State>,
}

impl Shared {
    pub(crate) fn new(store: Box<dyn Store>) -> Self {
        Self { store, state: Mutex::new(State::default()) }
    }

    fn load<'a>(&self, state: &'a mut State) -> Result<&'a mut Secrets, String> {
        state
            .loaded
            .get_or_insert_with(|| {
                self.store.read()?.map_or_else(
                    || Ok(BTreeMap::new()),
                    |raw| {
                        serde_json::from_str(&raw).map_err(|_| "could not read Nekko Agent's saved credentials".into())
                    },
                )
            })
            .as_mut()
            .map_err(|e| e.clone())
    }

    /// Write the profile's item with `name` changed. `verify` reads it back
    /// first, for a migration only: there the old item about to be removed is
    /// the value's only other copy. Every Keychain call can be a dialog of its
    /// own (an "Allow" answers one call, not the process), so a plain change
    /// trusts the write rather than asking again to read it back (#2527).
    fn save(
        &self,
        state: &mut State,
        service: &str,
        name: &str,
        value: Option<String>,
        verify: bool,
    ) -> Result<(), String> {
        if let Some(error) = &state.write_error {
            return Err(error.clone());
        }
        let mut next = self.load(state)?.clone();
        if next.get(service).and_then(|m| m.get(name)) == Some(&value) {
            return Ok(());
        }
        next.entry(service.into()).or_default().insert(name.into(), value);
        let raw = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        let saved = self.store.write(&raw).and_then(|()| {
            // Never remove an old item until the replacement really reads back.
            if !verify || self.store.read()?.as_deref() == Some(raw.as_str()) {
                Ok(())
            } else {
                Err("could not verify Nekko Agent's saved credentials; restart to retry".into())
            }
        });
        if let Err(error) = saved {
            // A failed write/readback has an uncertain outcome. Do not overwrite
            // it from an older snapshot, or repeatedly request access this run.
            state.write_error = Some(error.clone());
            return Err(error);
        }
        state.loaded = Some(Ok(next));
        Ok(())
    }
}

pub(crate) struct ConsolidatedVault {
    pub(crate) shared: Arc<Shared>,
    pub(crate) service: String,
}

impl Vault for ConsolidatedVault {
    fn get(&self, name: &str) -> Option<String> {
        let _call = super::waits::begin();
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = self.shared.load(&mut state).ok()?.get(&self.service).and_then(|m| m.get(name)) {
            return value.clone();
        }
        let key = (self.service.clone(), name.to_string());
        if let Some(cached) = state.legacy.get(&key) {
            return cached.clone();
        }
        if state.legacy_denied {
            return None;
        }
        // An old item's approval is independent of the new item's approval.
        // A refusal is remembered for this process, never retried in a loop.
        let value = match self.shared.store.legacy(&self.service, name) {
            Ok(value) => value,
            Err(_) => {
                // Stop the whole legacy scan after a refusal, not just this key.
                state.legacy_denied = true;
                None
            }
        };
        state.legacy.insert(key, value.clone());
        let value = value?;
        if self.shared.save(&mut state, &self.service, name, Some(value.clone()), true).is_ok() {
            self.shared.store.remove_legacy(&self.service, name);
        }
        Some(value)
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let _call = super::waits::begin();
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        // Unverified: an old copy of `name` removed below is one this value replaces.
        self.shared.save(&mut state, &self.service, name, Some(value.into()), false)?;
        state.legacy.remove(&(self.service.clone(), name.into()));
        if !state.legacy_denied {
            self.shared.store.remove_legacy(&self.service, name);
        }
        Ok(())
    }

    fn delete(&self, name: &str) {
        let _call = super::waits::begin();
        let mut state = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        // Persist a tombstone: an old item that cannot be removed must not return
        // after a restart. A denied or corrupt vault is never overwritten.
        if self.shared.save(&mut state, &self.service, name, None, false).is_ok() {
            state.legacy.remove(&(self.service.clone(), name.into()));
            if !state.legacy_denied {
                self.shared.store.remove_legacy(&self.service, name);
            }
        }
    }

    fn kind(&self) -> &'static str {
        "macOS Keychain"
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn vault(dir: &std::path::Path, name: &str) -> Box<dyn Vault> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static PROFILES: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();
    let scope = super::service(dir, "credentials");
    let mut profiles = PROFILES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let shared = profiles
        .entry(scope.clone())
        .or_insert_with(|| {
            Arc::new(Shared::new(Box::new(Native {
                // Keychain's system prompt displays the service as the item's name.
                label: format!(
                    "Nekko Agent: API keys, sign-ins and encryption keys ({})",
                    scope.rsplit('.').next().unwrap()
                ),
            })))
        })
        .clone();
    Box::new(ConsolidatedVault { shared, service: super::service(dir, name) })
}

#[cfg(target_os = "macos")]
struct Native {
    label: String,
}

#[cfg(target_os = "macos")]
fn read_entry(service: &str, name: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(service, name).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Keychain access was unavailable or denied; restart Nekko Agent to retry".into()),
    }
}

#[cfg(target_os = "macos")]
impl Store for Native {
    fn read(&self) -> Result<Option<String>, String> {
        read_entry(&self.label, "Nekko Agent credentials")
    }
    fn write(&self, value: &str) -> Result<(), String> {
        keyring::Entry::new(&self.label, "Nekko Agent credentials")
            .and_then(|e| e.set_password(value))
            .map_err(|_| "could not save Nekko Agent credentials to Keychain".into())
    }
    fn legacy(&self, service: &str, name: &str) -> Result<Option<String>, String> {
        read_entry(service, name)
    }
    fn remove_legacy(&self, service: &str, name: &str) {
        // keyring's macOS delete first reads the password, which can request
        // a second approval immediately after migration. Delete by attributes.
        let _ = security_framework::passwords::delete_generic_password(service, name);
    }
}

#[cfg(test)]
#[path = "consolidated_tests.rs"]
mod tests;
