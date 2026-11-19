//! Library files on Nekko Cloud (#2748): what goes inside a sealed `library`
//! record. Nekko Cloud sees none of it, not even the file's name.
//!
//! One record per file per computer. The local id is the computer's device id
//! and the file's path there, so two computers never write the same record,
//! and an opened record must hash back to the object id it was filed under
//! (the server can't swap one file for another):
//!
//! - a file: `{ "v": 1, "file": { deviceId, device, path, title, kind, chat, modifiedAt, size }, "data": <base64url> }`
//! - gone from that computer: `{ "v": 1, "deleted": true, "deletedAt": ms, "deviceId", "path" }`
//!
//! A file stays synced when Library stops listing it (a chat archived, a
//! filter); only a file gone from disk is deleted from Nekko Cloud, and Nekko
//! Cloud keeps its last revision for 30 days.

use crate::state::{LibraryFile, RemoteFile};
use nekko_sync::{b64_decode, b64_encode};
use serde_json::{Value, json};

pub const LIBRARY: &str = "library";

/// The largest file synced. Base64 in the record and sealed, it stays well under
/// Nekko Cloud's 16 MiB object cap (`records::MAX_SEALED_BYTES`).
pub const MAX_FILE_BYTES: u64 = 8_000_000;

/// The kinds Library lists; anything else from the app is refused.
pub const KINDS: &[&str] = &["doc", "web", "design", "diagram", "data", "office", "image"];

/// How many files the app may report at once, and how long a path or title may be.
pub const MAX_FILES: usize = 5000;
const MAX_PATH: usize = 4096;
const MAX_TEXT: usize = 300;
/// Maximum thumbnail size (base64 characters). ~200 KB decoded keeps the sealed record well
/// under the 16 MiB cap even when added to an 8 MB file.
const MAX_THUMB: usize = 300_000;

/// The record's local id: this computer and the file's path on it.
pub fn local_id(device_id: &str, path: &str) -> String {
    format!("{device_id}\n{path}")
}

/// The folder another computer's file is copied into here: one per folder on
/// that computer, named by a digest so no path from the record reaches the disk.
pub fn folder_key(device_id: &str, path: &str) -> String {
    let parent = path.rfind(['/', '\\']).map_or("", |i| &path[..i]);
    crate::records::digest(format!("{device_id}\n{parent}").as_bytes())
}

/// The files the app reported, cleaned: a known kind, an absolute path, short text. Anything else is dropped.
pub fn files_from_app(v: &Value) -> Vec<LibraryFile> {
    let text =
        |f: &Value, k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").chars().take(MAX_TEXT).collect::<String>();
    let thumb = |f: &Value| -> String {
        // Accept only well-formed data URLs; strip down to `MAX_THUMB` characters.
        let raw = f.get("thumbnailData").and_then(Value::as_str).unwrap_or("");
        if !raw.starts_with("data:image/") { return String::new(); }
        raw.chars().take(MAX_THUMB).collect()
    };
    v.as_array()
        .map(|list| {
            list.iter()
                .take(MAX_FILES)
                .filter_map(|f| {
                    let path = f.get("path")?.as_str()?.to_string();
                    let kind = f.get("kind")?.as_str()?.to_string();
                    let absolute =
                        path.starts_with('/') || path.get(1..3) == Some(":\\") || path.get(1..3) == Some(":/");
                    if path.len() > MAX_PATH || !absolute || path.contains('\0') || !KINDS.contains(&kind.as_str()) {
                        return None;
                    }
                    Some(LibraryFile {
                        title: text(f, "title"),
                        chat: text(f, "chat"),
                        path,
                        kind,
                        thumbnail_data: thumb(f),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn file_plaintext(device_id: &str, device: &str, f: &LibraryFile, modified_at: f64, bytes: &[u8]) -> Vec<u8> {
    let mut v = json!({
        "v": 1,
        "file": {
            "deviceId": device_id, "device": device, "path": f.path, "title": f.title, "kind": f.kind,
            "chat": f.chat, "modifiedAt": modified_at, "size": bytes.len(),
        },
        "data": b64_encode(bytes),
    });
    if !f.thumbnail_data.is_empty() {
        v["thumb"] = json!(f.thumbnail_data);
    }
    serde_json::to_vec(&v).unwrap_or_default()
}

/// A plaintext record for a file that is too large to sync (#3044): carries metadata and a
/// thumbnail only. No "data" field. Applied the same way as a file record on other computers,
/// but nothing is written to disk (the copy stays empty).
pub fn thumb_plaintext(device_id: &str, device: &str, f: &LibraryFile, modified_at: f64, size: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "v": 1,
        "file": {
            "deviceId": device_id, "device": device, "path": f.path, "title": f.title, "kind": f.kind,
            "chat": f.chat, "modifiedAt": modified_at, "size": size,
        },
        "thumb": f.thumbnail_data,
    }))
    .unwrap_or_default()
}

pub fn tombstone(device_id: &str, path: &str, at: f64) -> Vec<u8> {
    serde_json::to_vec(&json!({ "v": 1, "deleted": true, "deletedAt": at, "deviceId": device_id, "path": path }))
        .unwrap_or_default()
}

/// An opened Library record. `copy` is empty until it is written to disk.
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryRecord {
    File(RemoteFile, Vec<u8>),
    Deleted { device_id: String, path: String },
}

impl LibraryRecord {
    /// The record's local id, to check against the object id it came under.
    pub fn local_id(&self) -> String {
        match self {
            LibraryRecord::File(f, _) => local_id(&f.device_id, &f.path),
            LibraryRecord::Deleted { device_id, path } => local_id(device_id, path),
        }
    }
}

pub fn parse(bytes: &[u8]) -> Option<LibraryRecord> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let s = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    if v.get("deleted").and_then(Value::as_bool) == Some(true) {
        return Some(LibraryRecord::Deleted { device_id: s(&v, "deviceId")?, path: s(&v, "path")? });
    }
    let f = v.get("file")?;
    let kind = s(f, "kind")?;
    if !KINDS.contains(&kind.as_str()) {
        return None;
    }
    // Validate and bound the thumbnail on receive, same rules as on send.
    let thumb: String = s(&v, "thumb").map(|t| {
        if !t.starts_with("data:image/") { return String::new(); }
        t.chars().take(MAX_THUMB).collect()
    }).unwrap_or_default();

    // Thumb-only record (#3044): no "data" field; the file was over 8 MB on the other computer.
    // Must have a thumbnail to be useful; without one it is ignored.
    if v.get("data").is_none() {
        if thumb.is_empty() {
            return None;
        }
        let file = RemoteFile {
            device_id: s(f, "deviceId")?,
            device: s(f, "device").unwrap_or_default(),
            path: s(f, "path")?,
            title: s(f, "title").unwrap_or_default(),
            kind,
            chat: s(f, "chat").unwrap_or_default(),
            modified_at: f.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0),
            size: f.get("size").and_then(Value::as_u64).unwrap_or(0),
            copy: String::new(),
            thumbnail_data: thumb,
            thumb_only: true,
        };
        return Some(LibraryRecord::File(file, vec![]));
    }

    let data = b64_decode(v.get("data")?.as_str()?).ok()?;
    if data.len() as u64 > MAX_FILE_BYTES {
        return None;
    }
    let file = RemoteFile {
        device_id: s(f, "deviceId")?,
        device: s(f, "device").unwrap_or_default(),
        path: s(f, "path")?,
        title: s(f, "title").unwrap_or_default(),
        kind,
        chat: s(f, "chat").unwrap_or_default(),
        modified_at: f.get("modifiedAt").and_then(Value::as_f64).unwrap_or(0.0),
        size: data.len() as u64,
        copy: String::new(),
        thumbnail_data: thumb,
        thumb_only: false,
    };
    Some(LibraryRecord::File(file, data))
}

/// A file name that is safe to write on any OS: the last part of the path,
/// with separators, reserved characters and control characters replaced, and
/// never empty, `.` or `..`.
pub fn safe_name(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String =
        last.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).take(120).collect();
    name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() || name == "." || name == ".." {
        name = "file".into();
    }
    // Windows keeps these names for devices, with any extension.
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> LibraryFile {
        LibraryFile { path: path.into(), title: "Checkout".into(), kind: "design".into(), chat: "Shop".into(), thumbnail_data: String::new() }
    }

    #[test]
    fn a_file_and_a_tombstone_round_trip() {
        let plain = file_plaintext("dev1", "Desk", &file("/u/p/nekko-designs/checkout.html"), 42.0, b"<h1>hi</h1>");
        let Some(LibraryRecord::File(f, data)) = parse(&plain) else { panic!("did not open") };
        assert_eq!(data, b"<h1>hi</h1>");
        assert_eq!((f.device_id.as_str(), f.device.as_str(), f.kind.as_str(), f.size), ("dev1", "Desk", "design", 11));
        assert_eq!(f.modified_at, 42.0);
        assert_eq!(parse(&plain).unwrap().local_id(), local_id("dev1", "/u/p/nekko-designs/checkout.html"));
        let gone = parse(&tombstone("dev1", "/u/p/a.md", 9.0)).unwrap();
        assert_eq!(gone, LibraryRecord::Deleted { device_id: "dev1".into(), path: "/u/p/a.md".into() });
        assert_eq!(gone.local_id(), local_id("dev1", "/u/p/a.md"));
    }

    #[test]
    fn a_malformed_record_is_refused() {
        for bad in [
            &b"{}"[..],
            br#"{"v":2,"deleted":true,"deviceId":"d","path":"/a"}"#,
            br#"{"v":1,"deleted":true,"path":"/a"}"#,
            br#"{"v":1,"file":{"deviceId":"d","path":"/a","kind":"virus"},"data":""}"#,
            br#"{"v":1,"file":{"deviceId":"d","path":"/a","kind":"doc"},"data":"!!"}"#,
            br#"{"v":1,"file":{"path":"/a","kind":"doc"},"data":""}"#,
            // thumb-only without a thumbnail is ignored
            br#"{"v":1,"file":{"deviceId":"d","path":"/a","kind":"doc"}}"#,
        ] {
            assert_eq!(parse(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn a_file_record_carries_a_thumbnail_through() {
        let mut f = file("/u/p/checkout.html");
        f.thumbnail_data = "data:image/png;base64,iVBORw0KGgo=".into();
        let plain = file_plaintext("dev1", "Desk", &f, 10.0, b"<h1>hi</h1>");
        let Some(LibraryRecord::File(remote, data)) = parse(&plain) else { panic!("did not open") };
        assert_eq!(data, b"<h1>hi</h1>");
        assert_eq!(remote.thumbnail_data, "data:image/png;base64,iVBORw0KGgo=");
        assert!(!remote.thumb_only);
    }

    #[test]
    fn a_thumb_only_record_round_trips() {
        let mut f = file("/u/p/large-video.mp4");
        f.kind = "image".into();
        f.thumbnail_data = "data:image/webp;base64,ZGF0YQ==".into();
        let plain = thumb_plaintext("dev2", "Laptop", &f, 999.0, 10_000_000);
        let Some(LibraryRecord::File(remote, data)) = parse(&plain) else { panic!("did not open") };
        assert!(data.is_empty());
        assert!(remote.thumb_only);
        assert_eq!(remote.thumbnail_data, "data:image/webp;base64,ZGF0YQ==");
        assert_eq!(remote.size, 10_000_000);
        assert_eq!(remote.copy, "");
        // The local id comes from LibraryRecord, not RemoteFile directly.
        let rec = LibraryRecord::File(remote, data);
        assert_eq!(rec.local_id(), local_id("dev2", "/u/p/large-video.mp4"));
    }

    #[test]
    fn thumbnails_from_app_are_stripped_to_data_url_prefix_only() {
        let got = files_from_app(&json!([
            { "path": "/a/x.md", "kind": "doc", "title": "X", "chat": "", "thumbnailData": "data:image/png;base64,abc=" },
            { "path": "/b/y.md", "kind": "doc", "title": "Y", "chat": "", "thumbnailData": "javascript:alert(1)" },
            { "path": "/c/z.md", "kind": "doc", "title": "Z", "chat": "" },
        ]));
        assert_eq!(got[0].thumbnail_data, "data:image/png;base64,abc=");
        assert_eq!(got[1].thumbnail_data, ""); // non-data-URL refused
        assert_eq!(got[2].thumbnail_data, ""); // absent -> empty
    }

    #[test]
    fn the_largest_file_fits_the_server_cap_once_sealed() {
        let big = vec![0u8; MAX_FILE_BYTES as usize];
        let plain = file_plaintext("dev1", "Desk", &file("/a/b.png"), 1.0, &big);
        assert!(crate::records::sealed_len(plain.len()) <= crate::records::MAX_SEALED_BYTES);
    }

    #[test]
    fn only_absolute_paths_and_known_kinds_come_in_from_the_app() {
        let got = files_from_app(&json!([
            { "path": "/Users/a/report.md", "kind": "doc", "title": "Report", "chat": "Q3" },
            { "path": "C:\\Users\\a\\x.html", "kind": "web" },
            { "path": "C:/Users/a/y.png", "kind": "image" },
            { "path": "relative/x.md", "kind": "doc" },
            { "path": "/a/x.exe", "kind": "program" },
            { "path": "/a/\u{0}x", "kind": "doc" },
            { "kind": "doc" },
            "nope",
        ]));
        assert_eq!(
            got.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["/Users/a/report.md", "C:\\Users\\a\\x.html", "C:/Users/a/y.png"]
        );
        assert_eq!(got[0].title, "Report");
        assert!(files_from_app(&json!("x")).is_empty());
    }

    #[test]
    fn files_from_one_folder_on_one_computer_share_a_copy_folder() {
        let k = folder_key("dev1", "/p/nekko-designs/checkout-design.html");
        assert_eq!(k, folder_key("dev1", "/p/nekko-designs/checkout-design-v2.html"));
        assert_ne!(k, folder_key("dev2", "/p/nekko-designs/checkout-design.html"));
        assert_ne!(k, folder_key("dev1", "/p/other/checkout-design.html"));
        assert_eq!(folder_key("d", "C:\\p\\a.md"), folder_key("d", "C:\\p\\b.md"));
        assert!(k.len() == 32 && k.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn names_written_to_disk_are_safe() {
        assert_eq!(safe_name("/a/b/checkout-design.html"), "checkout-design.html");
        assert_eq!(safe_name("C:\\a\\report.md"), "report.md");
        assert_eq!(safe_name("/a/b/.."), "file");
        assert_eq!(safe_name("/a/b/"), "file");
        assert_eq!(safe_name("/a/con:x?.md"), "con_x_.md");
        assert_eq!(safe_name("/a/trail. "), "trail");
        assert_eq!(safe_name("/a/con.md"), "_con.md");
        assert_eq!(safe_name("/a/COM1.txt"), "_COM1.txt");
        assert_eq!(safe_name("/a/console.md"), "console.md");
    }
}
