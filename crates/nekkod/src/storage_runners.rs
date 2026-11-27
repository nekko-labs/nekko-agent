//! Settings → Storage, CI runner images: what `<data>/runners` holds and which
//! leftover images can go (`storage:runnerImages`, `storage:removeRunnerImage`).

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const CHANNELS: &[&str] = &["storage:runnerImages", "storage:removeRunnerImage"];

/// Folders under `images/` runners use or a build can resume from: never offered.
const KEPT: &[&str] = &["default", "linux", "cache", "linux-cache", "default.new", "linux.new"];

fn kind(name: &str) -> &'static str {
    match name.strip_prefix("images/").unwrap_or("") {
        "default" => "macos",
        "linux" => "linux",
        "cache" | "linux-cache" => "cache",
        n if n.ends_with(".new") => "unfinished",
        "linux.old" => "previous",
        _ => "other",
    }
}

/// Real folders (never symlinks) directly under `dir`.
fn folders(dir: &Path) -> impl Iterator<Item = (String, PathBuf)> + use<> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
}

/// Every image folder in `runners`, with whether something uses it.
pub fn list(runners: &Path, in_use: &[PathBuf]) -> Vec<Value> {
    let named: Vec<PathBuf> = in_use.iter().filter_map(|p| std::fs::canonicalize(p).ok()).collect();
    let top = folders(runners).filter(|(_, p)| p.join("disk.img").is_file());
    let images_dir = runners.join("images");
    let images = folders(&images_dir).map(|(n, p)| (format!("images/{n}"), p));
    top.chain(images)
        .map(|(name, path)| {
            let kept = name.strip_prefix("images/").is_some_and(|n| KEPT.contains(&n));
            let used = std::fs::canonicalize(&path).is_ok_and(|c| named.contains(&c));
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_millis() as f64);
            json!({
                "name": name,
                "bytes": crate::storage::dir_size(&path),
                "modifiedAt": modified,
                "inUse": kept || used,
                "kind": kind(&name),
            })
        })
        .collect()
}

/// Remove one leftover image; its bytes freed. Only a name `list` offers, checked again now.
pub fn remove(runners: &Path, name: &str, in_use: &[PathBuf]) -> Result<u64, String> {
    let offered = list(runners, in_use).into_iter().find(|i| i["name"] == name);
    let Some(item) = offered.filter(|i| i["inUse"] == false) else {
        return Err("That image is in use or is not a leftover runner image.".into());
    };
    let (root, path) = (std::fs::canonicalize(runners), std::fs::canonicalize(runners.join(name)));
    match (root, path) {
        (Ok(root), Ok(path)) if path.starts_with(&root) && path != root => {
            std::fs::remove_dir_all(&path).map_err(|e| format!("Could not remove {name}: {e}"))?;
            Ok(item["bytes"].as_u64().unwrap_or(0))
        }
        _ => Err("That image is in use or is not a leftover runner image.".into()),
    }
}

/// The images runner records name (`runners.json`); `None` when that file cannot be read.
#[cfg(unix)]
fn named_images(runners: &Path) -> Option<Vec<PathBuf>> {
    let store = crate::runner::store::Store::new(runners);
    let records = store.load();
    (!store.is_unreadable()).then(|| records.into_iter().filter_map(|r| r.image).collect())
}

#[cfg(not(unix))]
fn named_images(_runners: &Path) -> Option<Vec<PathBuf>> {
    Some(Vec::new())
}

pub async fn route(ctx: &crate::routes::Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let dir = ctx.workspace.data_dir().join("runners");
    let name = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    let removing = channel == "storage:removeRunnerImage";
    tokio::task::spawn_blocking(move || {
        let named = named_images(&dir);
        if !removing {
            return Ok(Value::Array(list(&dir, named.as_deref().unwrap_or_default())));
        }
        let named = named.ok_or("The runner list can't be read, so no image is removed.")?;
        remove(&dir, &name, &named).map(|freed| json!({ "freed": freed }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn bundle(p: &Path, bytes: usize) {
        fs::create_dir_all(p).unwrap();
        fs::write(p.join("disk.img"), vec![0u8; bytes]).unwrap();
    }

    fn runners() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        bundle(&r.join("images/default"), 50);
        bundle(&r.join("images/linux"), 20);
        fs::create_dir_all(r.join("images/cache")).unwrap();
        fs::write(r.join("images/cache/restore.ipsw"), vec![0u8; 30]).unwrap();
        fs::create_dir_all(r.join("images/linux-cache")).unwrap();
        bundle(&r.join("images/default.new"), 7);
        bundle(&r.join("images/linux.old"), 9);
        bundle(&r.join("old-image-tart-2026-10-29"), 76);
        fs::create_dir_all(r.join("vms/nekko-a")).unwrap();
        fs::create_dir_all(r.join("logs")).unwrap();
        d
    }

    fn by_name<'a>(l: &'a [Value], n: &str) -> &'a Value {
        l.iter().find(|i| i["name"] == n).unwrap_or_else(|| panic!("{n} not in {l:?}"))
    }

    #[test]
    fn images_runners_use_and_unfinished_builds_are_never_removable() {
        let d = runners();
        let l = list(d.path(), &[]);
        for n in ["images/default", "images/linux", "images/cache", "images/linux-cache", "images/default.new"] {
            assert_eq!(by_name(&l, n)["inUse"], true, "{n}");
        }
        assert_eq!(by_name(&l, "images/default")["kind"], "macos");
        assert_eq!(by_name(&l, "images/default.new")["kind"], "unfinished");
        assert!(l.iter().all(|i| i["name"] != "vms" && i["name"] != "logs"), "{l:?}");
    }

    #[test]
    fn leftovers_are_offered_with_their_size() {
        let d = runners();
        let l = list(d.path(), &[]);
        let old = by_name(&l, "old-image-tart-2026-10-29");
        assert_eq!(
            (old["inUse"].clone(), old["bytes"].clone(), old["kind"].clone()),
            (json!(false), json!(76), json!("other"))
        );
        assert_eq!(by_name(&l, "images/linux.old")["kind"], "previous");
        assert_eq!(remove(d.path(), "old-image-tart-2026-10-29", &[]), Ok(76));
        assert!(!d.path().join("old-image-tart-2026-10-29").exists());
    }

    #[test]
    fn an_image_a_runner_names_is_in_use() {
        let d = runners();
        let named = d.path().join("old-image-tart-2026-10-29");
        assert_eq!(by_name(&list(d.path(), std::slice::from_ref(&named)), "old-image-tart-2026-10-29")["inUse"], true);
        assert!(remove(d.path(), "old-image-tart-2026-10-29", &[named]).is_err());
        assert!(d.path().join("old-image-tart-2026-10-29").exists());
    }

    #[test]
    fn remove_refuses_anything_outside_or_protected() {
        let d = runners();
        let outside = tempfile::tempdir().unwrap();
        bundle(&outside.path().join("victim"), 5);
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path().join("victim"), d.path().join("sneaky")).unwrap();
        for name in ["../models", "", "/etc", "images/default", "images/default.new", "sneaky", "logs", "vms/nekko-a"] {
            assert!(remove(d.path(), name, &[]).is_err(), "{name}");
        }
        assert!(outside.path().join("victim/disk.img").exists());
        assert!(d.path().join("images/default/disk.img").exists());
    }
}
