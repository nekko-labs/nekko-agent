//! What goes inside a sealed record. Nekko Cloud sees none of this.
//!
//! - `chat` (local id = the chat's id): `{ "v": 1, "chat": <the chat> }`, or a
//!   tombstone `{ "v": 1, "deleted": true, "deletedAt": ms }`. A picture in a
//!   message (`images`, `toolResult.images`) is not in the record: it stands as
//!   `nekko-blob:<sha256>.<ext>`, the name the chat store keeps it under, and
//!   travels once as its own `picture` record (#3298). Any other inline data,
//!   and a picture over [`MAX_PICTURE_BYTES`], is replaced by a short note.
//! - `picture` (local id = the chat's computer and the picture's blob name):
//!   `{ "v": 1, "home", "name", "data": <base64url> }`, or a tombstone
//!   `{ "v": 1, "deleted": true, "home", "name" }` once no chat of that computer
//!   refers to it. An opened picture must hash to its name.
//! - `account` (local id `epoch-<n>`, one per key epoch): the epoch number,
//!   the recovery key's public half and the devices this account trusts. Only
//!   a holder of that epoch's keyring can write it, so the server can't add a
//!   device or swap the recovery key that later key epochs are sealed to. A
//!   device takes a new epoch only from a device listed in the record of the
//!   epoch it holds, and only once that new epoch's record lists it too.

use nekko_store::blobs;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

pub const CHAT: &str = "chat";
pub const ACCOUNT: &str = "account";
/// The account record's local id for a key epoch.
pub fn account_local_id(epoch: u32) -> String {
    format!("epoch-{epoch}")
}

/// The largest plaintext a chat record may be. Sealed (version, salt, Padmé frame, tag) it stays
/// under Nekko Cloud's 16 MiB object cap. Long agent sessions run to a few MB, mostly tool output.
pub const MAX_CHAT_BYTES: usize = 16_000_000;
/// Nekko Cloud's cap on one sealed object (`MAX_OBJECT_BYTES` in apps/nekko-agent-api).
pub const MAX_SEALED_BYTES: usize = 16 << 20;
/// The sealed size of a record with this much plaintext.
pub fn sealed_len(plaintext: usize) -> usize {
    // Version byte, salt, the frame (a 4-byte length, Padmé-padded, at least 256 bytes), GCM tag.
    1 + 32 + nekko_sync::padme((plaintext + 4).max(256)) + 16
}
/// A string longer than this that is a `data:` URL is a picture or a file, not text.
const INLINE_DATA_MIN: usize = 1024;
pub const IMAGE_NOTE: &str = "[picture not synced]";

/// Why a chat is not synced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Incognito,
    /// The user turned sync off for this chat (`syncOff`).
    SyncOff,
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

/// Whether a chat is synced at all: never an incognito chat, nor one the user turned sync off
/// for. Which mode a chat runs in (Local only included) doesn't matter.
pub fn excluded(chat: &Value) -> Option<Skip> {
    let flag = |k: &str| chat.get(k).and_then(Value::as_bool) == Some(true);
    if flag("incognito") {
        return Some(Skip::Incognito);
    }
    if flag("syncOff") {
        return Some(Skip::SyncOff);
    }
    None
}

/// The computer a chat belongs to: the one it was started on (#3143). A chat's record names it as
/// `home: { deviceId, device }`. On that computer the chat file carries no `home` (it is simply
/// this computer's); a copy pulled from another computer keeps it, which is how the app knows the
/// chat is read-only here and where it came from.
pub const HOME: &str = "home";

/// The id of the computer a chat (or a chat file) names as its home, if any.
pub fn home_of(chat: &Value) -> Option<&str> {
    chat.get(HOME)?.get("deviceId")?.as_str().filter(|id| !id.is_empty())
}

/// The fields a copy of another computer's chat keeps from this computer when a newer copy
/// arrives: how it is arranged here, which is this computer's business.
pub const KEPT_HERE: [&str; 3] = ["pinned", "order", "archivedAt"];

/// A chat's record as it is pushed: its plaintext and the pictures it refers to.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatPlain {
    pub bytes: Vec<u8>,
    /// The computer the chat belongs to, whose `picture` records these are.
    pub home: String,
    /// Each picture the record names (`nekko-blob:<name>`) by its blob name, with its bytes when
    /// the chat held it inline. A name without bytes was a reference already: its picture is
    /// beside the chats here, or (a copy whose picture never arrived) nowhere.
    pub pictures: BTreeMap<String, Option<Vec<u8>>>,
}

/// The plaintext of a chat's record, or why it is skipped. One of this computer's chats is stamped
/// with this computer as its home; another computer's copy (re-sealed under a newer key epoch)
/// keeps the home it names. Its pictures become references to `picture` records.
pub fn chat_plaintext(chat: &Value, device_id: &str, device: &str) -> Result<ChatPlain, Skip> {
    if let Some(skip) = excluded(chat) {
        return Err(skip);
    }
    let mut c = chat.clone();
    if home_of(&c).is_none()
        && let Some(o) = c.as_object_mut()
    {
        o.insert(HOME.into(), json!({ "deviceId": device_id, "device": device }));
    }
    let home = home_of(&c).unwrap_or(device_id).to_string();
    let pictures = RefCell::new(BTreeMap::new());
    blobs::map_pictures(&mut c, |s| {
        if let Some(name) = s.strip_prefix(blobs::REF) {
            if blobs::valid_name(name) {
                pictures.borrow_mut().entry(name.to_string()).or_insert(None);
            }
            return None;
        }
        if s.len() > MAX_PICTURE_URL {
            return None; // left to the note below
        }
        let (name, bytes) = blobs::encode(s)?;
        let reference = format!("{}{name}", blobs::REF);
        pictures.borrow_mut().insert(name, Some(bytes));
        Some(reference)
    });
    strip_inline_data(&mut c);
    let bytes = serde_json::to_vec(&json!({ "v": 1, "chat": c })).unwrap_or_default();
    if bytes.len() > MAX_CHAT_BYTES {
        return Err(Skip::TooLarge);
    }
    Ok(ChatPlain { bytes, home, pictures: pictures.into_inner() })
}

/// The blob names of the pictures a chat refers to (`nekko-blob:<name>` in its messages).
pub fn picture_refs(chat: &Value) -> BTreeSet<String> {
    let mut c = chat.clone();
    let names = RefCell::new(BTreeSet::new());
    blobs::map_pictures(&mut c, |s| {
        if let Some(name) = s.strip_prefix(blobs::REF).filter(|n| blobs::valid_name(n)) {
            names.borrow_mut().insert(name.to_string());
        }
        None
    });
    names.into_inner()
}

pub const PICTURE: &str = "picture";

/// The largest picture synced. Base64 in the record and sealed, it stays under Nekko Cloud's
/// 16 MiB object cap. A screenshot is a few hundred KB to a few MB.
pub const MAX_PICTURE_BYTES: usize = 8_000_000;
/// A data URL longer than this holds a picture over `MAX_PICTURE_BYTES`.
const MAX_PICTURE_URL: usize = MAX_PICTURE_BYTES / 3 * 4 + 64;

/// A picture record's local id: the computer whose chats refer to it, and its blob name. Two
/// computers with the same picture keep a record each, so each removes its own.
pub fn picture_local_id(home: &str, name: &str) -> String {
    format!("{home}\n{name}")
}

pub fn picture_plaintext(home: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&json!({ "v": 1, "home": home, "name": name, "data": nekko_sync::b64_encode(bytes) }))
        .unwrap_or_default()
}

pub fn picture_tombstone(home: &str, name: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "v": 1, "deleted": true, "home": home, "name": name })).unwrap_or_default()
}

/// An opened picture record.
#[derive(Debug, Clone, PartialEq)]
pub enum PictureRecord {
    Picture { home: String, name: String, bytes: Vec<u8> },
    Deleted { home: String, name: String },
}

impl PictureRecord {
    pub fn home(&self) -> &str {
        match self {
            PictureRecord::Picture { home, .. } | PictureRecord::Deleted { home, .. } => home,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            PictureRecord::Picture { name, .. } | PictureRecord::Deleted { name, .. } => name,
        }
    }

    pub fn local_id(&self) -> String {
        picture_local_id(self.home(), self.name())
    }
}

/// A picture record, refused unless its name is a blob name and (for a picture) its bytes hash to it.
pub fn parse_picture(bytes: &[u8]) -> Option<PictureRecord> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let home = v.get("home")?.as_str().filter(|h| !h.is_empty())?.to_string();
    let name = v.get("name")?.as_str().filter(|n| blobs::valid_name(n))?.to_string();
    if v.get("deleted").and_then(Value::as_bool) == Some(true) {
        return Some(PictureRecord::Deleted { home, name });
    }
    let data = nekko_sync::b64_decode(v.get("data")?.as_str()?).ok()?;
    if data.len() > MAX_PICTURE_BYTES || !blobs::matches(&name, &data) {
        return None;
    }
    Some(PictureRecord::Picture { home, name, bytes: data })
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

/// The sealed account record of one key epoch.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AccountRecord {
    pub epoch: u32,
    pub recovery_public: String,
    pub devices: Vec<TrustedDevice>,
}

impl AccountRecord {
    pub fn to_bytes(&self) -> Vec<u8> {
        let devices: Vec<Value> =
            self.devices.iter().map(|d| json!({ "id": d.id, "publicKey": d.public_key, "label": d.label })).collect();
        serde_json::to_vec(
            &json!({ "v": 2, "epoch": self.epoch, "recoveryPublic": self.recovery_public, "devices": devices }),
        )
        .unwrap_or_default()
    }

    pub fn parse(bytes: &[u8]) -> Option<AccountRecord> {
        let v: Value = serde_json::from_slice(bytes).ok()?;
        if v.get("v").and_then(Value::as_u64) != Some(2) {
            return None;
        }
        let epoch = u32::try_from(v.get("epoch")?.as_u64()?).ok().filter(|e| *e >= 1)?;
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
        Some(AccountRecord { epoch, recovery_public: v.get("recoveryPublic")?.as_str()?.to_string(), devices })
    }

    pub fn trusts(&self, id: &str) -> bool {
        self.devices.iter().any(|d| d.id == id)
    }

    /// The listed device with this id and public key.
    pub fn lists(&self, id: &str, public_key: &str) -> bool {
        self.devices.iter().any(|d| d.id == id && d.public_key == public_key)
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
    fn pictures_travel_apart_and_text_is_kept() {
        use base64::Engine;
        let bytes = vec![7u8; 3000];
        let png = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
        let (name, _) = blobs::encode(&png).unwrap();
        let other = format!("data:application/pdf;base64,{}", "A".repeat(5000));
        let kept = format!("{}{}.jpg", blobs::REF, "b".repeat(64));
        let chat = json!({ "id": "s_1", "messages": [
            { "content": "hi", "images": [png, kept] },
            { "role": "tool", "toolResult": { "output": "ok", "images": [png] } },
            { "content": "file", "attachment": other },
        ], "updatedAt": 5 });
        let plain = chat_plaintext(&chat, "dev-a", "Desk").unwrap();
        assert_eq!(plain.home, "dev-a");
        // One picture used twice travels once; a reference already made travels as itself.
        assert_eq!(plain.pictures.len(), 2);
        assert_eq!(plain.pictures[&name], Some(bytes));
        assert_eq!(plain.pictures[&format!("{}.jpg", "b".repeat(64))], None);
        let ChatRecord::Chat(back) = parse_chat(&plain.bytes).unwrap() else { panic!() };
        assert_eq!(back["messages"][0]["content"], "hi");
        let reference = format!("{}{name}", blobs::REF);
        assert_eq!(back["messages"][0]["images"][0], reference.as_str());
        assert_eq!(back["messages"][1]["toolResult"]["images"][0], reference.as_str());
        // Inline data that isn't a picture the store keeps is still left out.
        assert_eq!(back["messages"][2]["attachment"], IMAGE_NOTE);
        assert_eq!(picture_refs(&back).len(), 2);
        assert_eq!(updated_at(&back), 5.0);
        // Stamped with the computer it belongs to (#3143).
        assert_eq!(home_of(&back), Some("dev-a"));
        assert_eq!(back[HOME]["device"], "Desk");
        assert_eq!(home_of(&chat), None);
        // Another computer's copy keeps its home, and its pictures are that computer's.
        let copy = json!({ "id": "s_2", "home": { "deviceId": "dev-b", "device": "Laptop" }, "messages": [] });
        let plain = chat_plaintext(&copy, "dev-a", "Desk").unwrap();
        assert_eq!(plain.home, "dev-b");
        let ChatRecord::Chat(back) = parse_chat(&plain.bytes).unwrap() else { panic!() };
        assert_eq!(back[HOME]["device"], "Laptop");
    }

    #[test]
    fn a_picture_too_large_is_left_out() {
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_PICTURE_URL + 4));
        let chat = json!({ "id": "s_1", "messages": [{ "images": [huge] }] });
        let plain = chat_plaintext(&chat, "dev-a", "Desk").unwrap();
        assert!(plain.pictures.is_empty());
        let ChatRecord::Chat(back) = parse_chat(&plain.bytes).unwrap() else { panic!() };
        assert_eq!(back["messages"][0]["images"][0], IMAGE_NOTE);
    }

    #[test]
    fn a_picture_record_opens_only_when_its_bytes_are_its_name() {
        let bytes = b"a picture".to_vec();
        let name = format!("{:x}.png", Sha256::digest(&bytes));
        let rec = parse_picture(&picture_plaintext("dev-a", &name, &bytes)).unwrap();
        assert_eq!(rec, PictureRecord::Picture { home: "dev-a".into(), name: name.clone(), bytes: bytes.clone() });
        assert_eq!(rec.local_id(), picture_local_id("dev-a", &name));
        let gone = parse_picture(&picture_tombstone("dev-a", &name)).unwrap();
        assert_eq!(gone, PictureRecord::Deleted { home: "dev-a".into(), name: name.clone() });
        // Other bytes under its name, a name that isn't a blob name, no computer: refused.
        assert_eq!(parse_picture(&picture_plaintext("dev-a", &name, b"something else")), None);
        assert_eq!(parse_picture(&picture_plaintext("dev-a", "../x.png", &bytes)), None);
        assert_eq!(parse_picture(&picture_plaintext("", &name, &bytes)), None);
        assert_eq!(parse_picture(br#"{"v":2}"#), None);
    }

    #[test]
    fn the_largest_picture_fits_the_server_cap_once_sealed() {
        let plain = picture_plaintext("dev-a", &format!("{}.png", "a".repeat(64)), &vec![0; MAX_PICTURE_BYTES]);
        assert!(sealed_len(plain.len()) <= MAX_SEALED_BYTES);
    }

    #[test]
    fn incognito_and_sync_off_chats_never_sync_and_local_only_mode_does() {
        assert_eq!(chat_plaintext(&json!({ "id": "a", "incognito": true }), "dev-a", "Desk"), Err(Skip::Incognito));
        assert_eq!(chat_plaintext(&json!({ "id": "a", "syncOff": true }), "dev-a", "Desk"), Err(Skip::SyncOff));
        assert!(chat_plaintext(&json!({ "id": "a", "syncOff": false }), "dev-a", "Desk").is_ok());
        assert!(
            chat_plaintext(&json!({ "id": "a", "offline": true }), "dev-a", "Desk").is_ok(),
            "the Local only mode is where models run, not whether it syncs"
        );
        let huge = json!({ "id": "a", "messages": [{ "content": "x".repeat(MAX_CHAT_BYTES) }] });
        assert_eq!(chat_plaintext(&huge, "dev-a", "Desk"), Err(Skip::TooLarge));
        let big = json!({ "id": "a", "messages": [{ "content": "x".repeat(4_500_000) }] });
        assert!(chat_plaintext(&big, "dev-a", "Desk").is_ok(), "a long agent session syncs");
    }

    #[test]
    fn the_largest_chat_fits_the_server_cap_once_sealed() {
        assert!(sealed_len(MAX_CHAT_BYTES) <= MAX_SEALED_BYTES);
        use base64::Engine;
        let kr = nekko_sync::Keyring::generate();
        let oid = nekko_sync::object_id(&kr, CHAT, "a").unwrap();
        for n in [10, 300_000, 4_500_000] {
            let blob = nekko_sync::seal_record(&kr, "acct", 1, CHAT, &oid, 1, &vec![b'x'; n]).unwrap();
            let sealed = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(blob).unwrap();
            assert_eq!(sealed.len(), sealed_len(n));
        }
    }

    #[test]
    fn tombstones_and_account_records_round_trip() {
        assert_eq!(parse_chat(&tombstone(9.0)), Some(ChatRecord::Deleted { at: 9.0 }));
        assert_eq!(parse_chat(b"{\"v\":1}"), None);
        let mut a = AccountRecord { epoch: 3, recovery_public: "rp".into(), devices: vec![] };
        a.add(TrustedDevice { id: "d1".into(), public_key: "pk".into(), label: "Mac".into() });
        a.add(TrustedDevice { id: "d1".into(), public_key: "pk".into(), label: "Mac Studio".into() });
        let back = AccountRecord::parse(&a.to_bytes()).unwrap();
        assert_eq!(back, a);
        assert_eq!(back.devices.len(), 1);
        assert!(back.trusts("d1") && !back.trusts("d2"));
        assert!(back.lists("d1", "pk") && !back.lists("d1", "other"));
        // The old format, or an epoch of 0, is refused.
        assert_eq!(AccountRecord::parse(br#"{"v":1,"recoveryPublic":"rp","devices":[]}"#), None);
        assert_eq!(AccountRecord::parse(br#"{"v":2,"epoch":0,"recoveryPublic":"rp","devices":[]}"#), None);
    }
}
