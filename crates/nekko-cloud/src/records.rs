//! What goes inside a sealed record. Nekko Cloud sees none of this.
//!
//! - `chat` (local id = the chat's id): `{ "v": 1, "chat": <the chat> }`, or a
//!   tombstone `{ "v": 1, "deleted": true, "deletedAt": ms }`. Pictures are
//!   left out (replaced by a short note): they would dominate storage, and a
//!   chat's text is what another device needs.
//! - `account` (local id `account`): the recovery key's public half and the
//!   devices this account trusts. Sealed with the keyring, so the server can't
//!   add a device or swap the recovery key that later key epochs are sealed to.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const CHAT: &str = "chat";
pub const ACCOUNT: &str = "account";
pub const ACCOUNT_ID: &str = "account";

/// The largest plaintext a chat record may be (the server caps a sealed object at 1 MiB).
pub const MAX_CHAT_BYTES: usize = 1_000_000;
/// A string longer than this that is a `data:` URL is a picture or a file, not text.
const INLINE_DATA_MIN: usize = 1024;
pub const IMAGE_NOTE: &str = "[picture not synced]";

/// Why a chat is not synced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Incognito,
    LocalOnly,
    TooLarge,
}

/// Replace inline pictures and files with a note; returns how many.
pub fn strip_inline_data(v: &mut Value) -> usize {
    match v {
        Value::String(s) if s.len() > INLINE_DATA_MIN && s.starts_with("data:") => {
            *s = IMAGE_NOTE.to_string();
            1
        }
        Value::Array(a) => a.iter_mut().map(strip_inline_data).sum(),
        Value::Object(o) => o.values_mut().map(strip_inline_data).sum(),
        _ => 0,
    }
}

/// Whether a chat is synced at all: never incognito chats, and "Local only"
/// (offline) chats only when the user includes them.
pub fn excluded(chat: &Value, include_local_only: bool) -> Option<Skip> {
    let flag = |k: &str| chat.get(k).and_then(Value::as_bool) == Some(true);
    if flag("incognito") {
        return Some(Skip::Incognito);
    }
    if flag("offline") && !include_local_only {
        return Some(Skip::LocalOnly);
    }
    None
}

/// The plaintext of a chat's record, or why it is skipped.
pub fn chat_plaintext(chat: &Value, include_local_only: bool) -> Result<Vec<u8>, Skip> {
    if let Some(skip) = excluded(chat, include_local_only) {
        return Err(skip);
    }
    let mut c = chat.clone();
    strip_inline_data(&mut c);
    let bytes = serde_json::to_vec(&json!({ "v": 1, "chat": c })).unwrap_or_default();
    if bytes.len() > MAX_CHAT_BYTES {
        return Err(Skip::TooLarge);
    }
    Ok(bytes)
}

pub fn tombstone(deleted_at: f64) -> Vec<u8> {
    serde_json::to_vec(&json!({ "v": 1, "deleted": true, "deletedAt": deleted_at })).unwrap_or_default()
}

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// An opened chat record.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatRecord {
    Chat(Value),
    Deleted { at: f64 },
}

pub fn parse_chat(bytes: &[u8]) -> Option<ChatRecord> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("deleted").and_then(Value::as_bool) == Some(true) {
        return Some(ChatRecord::Deleted { at: v.get("deletedAt").and_then(Value::as_f64).unwrap_or(0.0) });
    }
    let chat = v.get("chat")?;
    chat.get("id").and_then(Value::as_str)?;
    Some(ChatRecord::Chat(chat.clone()))
}

pub fn updated_at(chat: &Value) -> f64 {
    chat.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0)
}

/// A device the account trusts, as the sealed account record lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct TrustedDevice {
    pub id: String,
    pub public_key: String,
    pub label: String,
}

/// The sealed account record.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountRecord {
    pub recovery_public: String,
    pub devices: Vec<TrustedDevice>,
}

impl AccountRecord {
    pub fn to_bytes(&self) -> Vec<u8> {
        let devices: Vec<Value> =
            self.devices.iter().map(|d| json!({ "id": d.id, "publicKey": d.public_key, "label": d.label })).collect();
        serde_json::to_vec(&json!({ "v": 1, "recoveryPublic": self.recovery_public, "devices": devices }))
            .unwrap_or_default()
    }

    pub fn parse(bytes: &[u8]) -> Option<AccountRecord> {
        let v: Value = serde_json::from_slice(bytes).ok()?;
        let devices = v
            .get("devices")?
            .as_array()?
            .iter()
            .filter_map(|d| {
                Some(TrustedDevice {
                    id: d.get("id")?.as_str()?.to_string(),
                    public_key: d.get("publicKey")?.as_str()?.to_string(),
                    label: d.get("label").and_then(Value::as_str).unwrap_or("").to_string(),
                })
            })
            .collect();
        Some(AccountRecord { recovery_public: v.get("recoveryPublic")?.as_str()?.to_string(), devices })
    }

    pub fn trusts(&self, id: &str) -> bool {
        self.devices.iter().any(|d| d.id == id)
    }

    pub fn add(&mut self, d: TrustedDevice) {
        self.devices.retain(|x| x.id != d.id);
        self.devices.push(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pictures_are_left_out_and_text_kept() {
        let big = format!("data:image/png;base64,{}", "A".repeat(5000));
        let chat = json!({ "id": "s_1", "messages": [{ "content": "hi", "images": [big] }], "updatedAt": 5 });
        let plain = chat_plaintext(&chat, false).unwrap();
        let ChatRecord::Chat(back) = parse_chat(&plain).unwrap() else { panic!() };
        assert_eq!(back["messages"][0]["content"], "hi");
        assert_eq!(back["messages"][0]["images"][0], IMAGE_NOTE);
        assert_eq!(updated_at(&back), 5.0);
    }

    #[test]
    fn incognito_never_syncs_and_local_only_only_when_included() {
        assert_eq!(chat_plaintext(&json!({ "id": "a", "incognito": true }), true), Err(Skip::Incognito));
        assert_eq!(chat_plaintext(&json!({ "id": "a", "offline": true }), false), Err(Skip::LocalOnly));
        assert!(chat_plaintext(&json!({ "id": "a", "offline": true }), true).is_ok());
        let huge = json!({ "id": "a", "messages": [{ "content": "x".repeat(MAX_CHAT_BYTES) }] });
        assert_eq!(chat_plaintext(&huge, false), Err(Skip::TooLarge));
    }

    #[test]
    fn tombstones_and_account_records_round_trip() {
        assert_eq!(parse_chat(&tombstone(9.0)), Some(ChatRecord::Deleted { at: 9.0 }));
        assert_eq!(parse_chat(b"{\"v\":1}"), None);
        let mut a = AccountRecord { recovery_public: "rp".into(), devices: vec![] };
        a.add(TrustedDevice { id: "d1".into(), public_key: "pk".into(), label: "Mac".into() });
        a.add(TrustedDevice { id: "d1".into(), public_key: "pk".into(), label: "Mac Studio".into() });
        let back = AccountRecord::parse(&a.to_bytes()).unwrap();
        assert_eq!(back, a);
        assert_eq!(back.devices.len(), 1);
        assert!(back.trusts("d1") && !back.trusts("d2"));
    }
}
