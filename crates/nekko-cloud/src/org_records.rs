//! What goes inside the sealed records of an organization. Nekko Cloud sees
//! none of this.
//!
//! - `org-key` (an ordinary account record, local id `<orgId>:<orgKeyId>`):
//!   `{ "v": 1, "orgId", "orgKeyId", "orgName", "keyring": base64url(64 bytes) }`,
//!   sealed with the account keyring like a chat. It is how the org keyring
//!   reaches the other devices of the same account.
//! - the fleet descriptor (sealed under the org keyring, see
//!   `nekko_sync::seal_descriptor`): what a computer shares with the members of
//!   an org. Never a local URL, port, path, token or room secret, and never a
//!   cloud provider's model.

use nekko_sync::{Keyring, b64_decode, b64_encode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

pub const ORG_KEY: &str = "org-key";

/// The `org-key` record's local id.
pub fn org_key_local_id(org_id: &str, key_id: u32) -> String {
    format!("{org_id}:{key_id}")
}

/// An org id as the API issues it (a uuid): refused otherwise, since it is put in record ids and paths.
pub fn valid_org_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// An id that is put into a URL path (a uuid again).
pub fn valid_uuid(id: &str) -> bool {
    valid_org_id(id)
}

#[derive(Debug)]
pub struct OrgKeyRecord {
    pub org_id: String,
    pub key_id: u32,
    pub name: String,
    pub keyring: Keyring,
}

impl OrgKeyRecord {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut raw = self.keyring.to_bytes();
        let out = serde_json::to_vec(&json!({
            "v": 1,
            "orgId": self.org_id,
            "orgKeyId": self.key_id,
            "orgName": self.name,
            "keyring": b64_encode(&raw),
        }))
        .unwrap_or_default();
        raw.zeroize();
        out
    }

    pub fn parse(plain: &[u8]) -> Option<OrgKeyRecord> {
        let v: Value = serde_json::from_slice(plain).ok()?;
        if v["v"].as_u64() != Some(1) {
            return None;
        }
        let org_id = v["orgId"].as_str().filter(|s| valid_org_id(s))?.to_string();
        let key_id = u32::try_from(v["orgKeyId"].as_u64()?).ok().filter(|k| *k >= 1)?;
        let mut raw = b64_decode(v["keyring"].as_str()?).ok()?;
        let keyring = Keyring::from_bytes(&raw).ok();
        raw.zeroize();
        Some(OrgKeyRecord {
            org_id,
            key_id,
            name: v["orgName"].as_str().unwrap_or("").chars().take(80).collect(),
            keyring: keyring?,
        })
    }
}

/// A model this computer can serve right now.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalModel {
    pub id: String,
    pub label: String,
    pub runtime: String,
    pub size_bytes: Option<u64>,
}

/// At most this many models go in a descriptor (it must stay well under the API's 16 KiB).
pub const MAX_MODELS: usize = 40;

/// A descriptor's plaintext stays under this, so the sealed blob (padded by up to 12%) fits the API's 16 KiB.
const MAX_PLAINTEXT: usize = 12_000;

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

/// Everything a descriptor says about this computer, apart from when it was made.
#[derive(Debug, Clone, PartialEq)]
pub struct HostFacts {
    pub device_id: String,
    pub account_id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub models: Vec<LocalModel>,
    /// base64url of this device's P-256 public key.
    pub host_key: String,
}

impl HostFacts {
    fn body(&self, published_at: Option<&str>) -> Value {
        let mut models: Vec<&LocalModel> = self.models.iter().collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        let models: Vec<Value> = models
            .into_iter()
            .take(MAX_MODELS)
            .map(|m| {
                let mut o =
                    json!({ "id": clip(&m.id, 120), "label": clip(&m.label, 80), "runtime": clip(&m.runtime, 16) });
                if let Some(s) = m.size_bytes {
                    o["sizeBytes"] = json!(s);
                }
                o
            })
            .collect();
        let mut v = json!({
            "v": 1,
            "deviceId": self.device_id,
            "accountId": self.account_id,
            "name": clip(&self.name, 80),
            "os": self.os,
            "arch": clip(&self.arch, 16),
            "appVersion": clip(&self.app_version, 32),
            "models": models,
            "hostKey": self.host_key,
        });
        if let Some(at) = published_at {
            v["publishedAt"] = json!(at);
        }
        // Fewer models rather than a descriptor the API would refuse.
        while serde_json::to_vec(&v).map_or(0, |b| b.len()) > MAX_PLAINTEXT {
            match v["models"].as_array_mut() {
                Some(m) if !m.is_empty() => {
                    m.pop();
                }
                _ => break,
            }
        }
        v
    }

    /// The descriptor's plaintext JSON.
    pub fn plaintext(&self, published_at: &str) -> Vec<u8> {
        serde_json::to_vec(&self.body(Some(published_at))).unwrap_or_default()
    }

    /// A digest of everything but the time: it changes when the name, the
    /// models, the app version or the key does, and only then.
    pub fn digest(&self) -> String {
        let h = Sha256::digest(serde_json::to_vec(&self.body(None)).unwrap_or_default());
        b64_encode(&h)
    }
}

/// This machine's OS in the descriptor's vocabulary.
pub fn this_os() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

/// A descriptor as read from a sealed blob, checked for shape and bounded.
#[derive(Debug, Clone, PartialEq)]
pub struct Descriptor {
    pub device_id: String,
    pub account_id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub models: Vec<LocalModel>,
    pub host_key: String,
    pub published_at: String,
}

impl Descriptor {
    /// None for anything that isn't a v1 descriptor in the right shape.
    pub fn parse(plain: &[u8]) -> Option<Descriptor> {
        let v: Value = serde_json::from_slice(plain).ok()?;
        if v["v"].as_u64() != Some(1) {
            return None;
        }
        let s = |k: &str, max: usize| v[k].as_str().map(|t| clip(t, max));
        let os = v["os"].as_str().filter(|o| ["windows", "macos", "linux"].contains(o))?.to_string();
        let host_key = v["hostKey"].as_str()?.to_string();
        // A P-256 point, uncompressed or compressed, in base64url.
        if host_key.len() > 200 || b64_decode(&host_key).is_err() {
            return None;
        }
        let device_id = v["deviceId"].as_str().filter(|d| valid_uuid(d))?.to_string();
        let models = v["models"]
            .as_array()?
            .iter()
            .take(MAX_MODELS)
            .filter_map(|m| {
                Some(LocalModel {
                    id: clip(m["id"].as_str()?, 120),
                    label: clip(m["label"].as_str().unwrap_or(m["id"].as_str()?), 80),
                    runtime: clip(m["runtime"].as_str().unwrap_or(""), 16),
                    size_bytes: m["sizeBytes"].as_u64(),
                })
            })
            .filter(|m| !m.id.is_empty())
            .collect();
        Some(Descriptor {
            device_id,
            account_id: s("accountId", 64)?,
            name: s("name", 80).filter(|n| !n.is_empty())?,
            os,
            arch: s("arch", 16).unwrap_or_default(),
            app_version: s("appVersion", 32).unwrap_or_default(),
            models,
            host_key,
            published_at: s("publishedAt", 40).unwrap_or_default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "0b7c2d4e-6f1a-4c3b-9d8e-5a4f3e2d1c0b";
    const DEV: &str = "7e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b";

    fn facts() -> HostFacts {
        HostFacts {
            device_id: DEV.into(),
            account_id: "acct-1".into(),
            name: "Desk".into(),
            os: "windows".into(),
            arch: "x86_64".into(),
            app_version: "0.9.8".into(),
            models: vec![
                LocalModel { id: "b".into(), label: "Beta".into(), runtime: "llamacpp".into(), size_bytes: Some(10) },
                LocalModel { id: "a".into(), label: "Alpha".into(), runtime: "mlx".into(), size_bytes: None },
            ],
            host_key: b64_encode(&[4u8; 65]),
        }
    }

    #[test]
    fn the_org_key_record_round_trips() {
        let k = Keyring::generate();
        let rec = OrgKeyRecord { org_id: ORG.into(), key_id: 2, name: "Nekko Labs".into(), keyring: k.clone() };
        let back = OrgKeyRecord::parse(&rec.to_bytes()).unwrap();
        assert_eq!((back.org_id.as_str(), back.key_id, back.name.as_str()), (ORG, 2, "Nekko Labs"));
        assert_eq!(back.keyring.to_bytes(), k.to_bytes());
        assert_eq!(org_key_local_id(ORG, 2), format!("{ORG}:2"));
    }

    #[test]
    fn the_org_key_record_refuses_bad_shapes() {
        let good = OrgKeyRecord { org_id: ORG.into(), key_id: 1, name: "x".into(), keyring: Keyring::generate() };
        let mut v: Value = serde_json::from_slice(&good.to_bytes()).unwrap();
        for (k, bad) in [
            ("v", json!(2)),
            ("orgId", json!("not-a-uuid")),
            ("orgKeyId", json!(0)),
            ("keyring", json!("AAAA")),
            ("keyring", json!(5)),
        ] {
            let old = v[k].clone();
            v[k] = bad;
            assert!(OrgKeyRecord::parse(&serde_json::to_vec(&v).unwrap()).is_none(), "{k}");
            v[k] = old;
        }
        assert!(OrgKeyRecord::parse(b"nope").is_none());
    }

    #[test]
    fn a_descriptor_round_trips_with_models_sorted_and_no_secrets_shape() {
        let f = facts();
        let plain = f.plaintext("2026-11-11T10:00:00Z");
        let d = Descriptor::parse(&plain).unwrap();
        assert_eq!((d.name.as_str(), d.os.as_str(), d.account_id.as_str()), ("Desk", "windows", "acct-1"));
        assert_eq!(d.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(d.models[1].size_bytes, Some(10));
        assert_eq!(d.published_at, "2026-11-11T10:00:00Z");
        assert_eq!(d.host_key, f.host_key);
        let text = String::from_utf8(plain).unwrap();
        assert!(!text.contains("http") && !text.contains("path") && !text.contains("token"));
    }

    #[test]
    fn the_digest_ignores_the_time_and_follows_the_content() {
        let mut f = facts();
        let d = f.digest();
        assert_eq!(d, facts().digest());
        f.models.reverse();
        assert_eq!(f.digest(), d, "model order doesn't matter");
        f.models.pop();
        assert_ne!(f.digest(), d, "a model change does");
        let mut g = facts();
        g.name = "Desk 2".into();
        assert_ne!(g.digest(), d, "a name change does");
    }

    #[test]
    fn a_descriptor_is_bounded() {
        let mut f = facts();
        f.name = format!("{}\nbad", "n".repeat(500));
        f.models = (0..500)
            .map(|i| LocalModel { id: format!("m{i}"), label: "l".repeat(900), runtime: "x".into(), size_bytes: None })
            .collect();
        let plain = f.plaintext("2026-11-11T10:00:00Z");
        assert!(plain.len() <= MAX_PLAINTEXT, "{} bytes", plain.len());
        let d = Descriptor::parse(&plain).unwrap();
        assert_eq!(d.name.chars().count(), 80);
        assert!(!d.name.contains('\n'));
        assert_eq!(d.models.len(), MAX_MODELS);
    }

    #[test]
    fn a_descriptor_refuses_bad_shapes() {
        let good: Value = serde_json::from_slice(&facts().plaintext("t")).unwrap();
        for (k, bad) in [
            ("v", json!(2)),
            ("os", json!("plan9")),
            ("deviceId", json!("../../x")),
            ("name", json!("")),
            ("models", json!("many")),
            ("hostKey", json!("!!!")),
        ] {
            let mut v = good.clone();
            v[k] = bad;
            assert!(Descriptor::parse(&serde_json::to_vec(&v).unwrap()).is_none(), "{k}");
        }
        assert!(Descriptor::parse(b"[]").is_none());
    }
}
