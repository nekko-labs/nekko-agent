//! Settings → Storage: where Nekko's disk goes (`storage:usage`, `storage:disk`).
//! Folder walks run on blocking threads and the last result is kept, so a
//! caller gets an answer at once and never waits on a walk.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

pub const CHANNELS: &[&str] = &["storage:usage", "storage:disk"];

/// Folders a build or package manager recreates; counted as build output and not walked into twice.
const BUILD_DIRS: &[&str] = &["node_modules", "target", ".next", "dist", "build", "DerivedData"];

/// The desktop app's browser caches, inside `<data>/desktop` (Electron's session folder).
pub const CACHE_DIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "Service Worker",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "GraphiteDawnCache",
    "ShaderCache",
];

/// Data-folder entries another category counts (or, for `desktop`, splits).
const COUNTED_ELSEWHERE: &[&str] = &["models", "engine", "runners", "sessions", "attachments"];

/// Every category, in the page's order; one never measured has `bytes: null`.
const CATEGORY_IDS: &[&str] = &["worktrees", "runners", "models", "history", "caches", "other"];

#[derive(Default)]
struct State {
    measured: Option<std::time::Instant>,
    measured_at: Option<f64>,
    measuring: bool,
    categories: std::collections::BTreeMap<String, Value>,
    worktrees: HashMap<String, u64>,
}

/// The last measurement and whether one is running.
#[derive(Default)]
pub struct Storage {
    state: Mutex<State>,
}

impl Storage {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether to start a walk now: none running, and the last is older than 10 minutes (or `refresh`).
    pub fn begin(&self, refresh: bool) -> bool {
        let mut s = self.lock();
        if s.measuring || (!refresh && s.measured.is_some_and(|t| t.elapsed() < FRESH)) {
            return false;
        }
        s.measuring = true;
        true
    }

    pub fn put(&self, category: Value) {
        if let Some(id) = category["id"].as_str() {
            self.lock().categories.insert(id.to_string(), category);
        }
    }

    pub fn put_worktree(&self, root: &str, bytes: u64) {
        self.lock().worktrees.insert(root.to_string(), bytes);
    }

    pub fn finish(&self) {
        let mut s = self.lock();
        s.measuring = false;
        s.measured = Some(std::time::Instant::now());
        s.measured_at = Some(nekko_js::now_ms_f64());
    }

    /// Each worktree's size from the last walk, by root.
    pub fn worktree_bytes(&self) -> HashMap<String, u64> {
        self.lock().worktrees.clone()
    }

    pub fn snapshot(&self) -> Value {
        let s = self.lock();
        let categories: Vec<Value> = CATEGORY_IDS
            .iter()
            .map(|id| s.categories.get(*id).cloned().unwrap_or_else(|| json!({ "id": id, "bytes": null })))
            .collect();
        json!({ "measuredAt": s.measured_at, "measuring": s.measuring, "categories": categories, "worktreeBytes": s.worktrees })
    }
}

/// The daemon's one measurement (a daemon serves one data folder).
fn shared() -> &'static Arc<Storage> {
    static S: OnceLock<Arc<Storage>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Each worktree's size from the last walk (for Git management's list).
pub fn worktree_bytes() -> HashMap<String, u64> {
    shared().worktree_bytes()
}

pub async fn route(ctx: &crate::routes::Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let data = ctx.workspace.data_dir().to_path_buf();
    let d = data.clone();
    let disk = tokio::task::spawn_blocking(move || nekko_machine::probe::disk_space(&d))
        .await
        .ok()
        .flatten()
        .map_or(Value::Null, |(total, free)| json!({ "total": total, "free": free }));
    if channel == "storage:disk" {
        return Ok(disk);
    }
    let refresh = args.first().is_some_and(|a| *a == Value::Bool(true) || a["refresh"] == true);
    let s = shared().clone();
    if s.begin(refresh) {
        let settings = crate::settings::current(ctx).await;
        let models = ctx.library.models_dir();
        let store = ctx.sessions.clone();
        tokio::task::spawn_blocking(move || measure(&s, &data, &models, &settings, &store));
    }
    let mut snap = shared().snapshot();
    snap["disk"] = disk;
    Ok(snap)
}

/// One walk, cheapest first, publishing each category as it finishes. Worktrees last: they hold the most files.
fn measure(s: &Storage, data: &Path, models_dir: &str, settings: &Value, store: &nekko_store::SessionStore) {
    let pictures = dir_size(&data.join("sessions").join("blobs"));
    let history = store.history_usage().0 + dir_size(&data.join("attachments"));
    s.put(json!({ "id": "history", "bytes": history, "detail": { "picturesBytes": pictures } }));
    let models = Some(Path::new(models_dir)).filter(|m| !models_dir.is_empty() && m.is_absolute());
    for c in data_categories(data, models) {
        s.put(c);
    }
    s.put(json!({ "id": "runners", "bytes": dir_size(&data.join("runners")) }));
    let roots = crate::worktrees::roots(settings);
    let sizes = crate::worktrees::parallel_map(&roots, 8, |r| worktree_size(Path::new(r)));
    let (mut total, mut build) = (0, 0);
    for (root, (t, b)) in roots.iter().zip(sizes) {
        s.put_worktree(root, t);
        total += t;
        build += b;
    }
    s.put(json!({ "id": "worktrees", "bytes": total, "detail": { "buildOutputBytes": build, "count": roots.len() } }));
    s.finish();
}

const FRESH: std::time::Duration = std::time::Duration::from_secs(600);

/// `(total, build output)` under `p`. Never follows symlinks; unreadable folders count as 0.
fn walk(p: &Path, in_build: bool) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(p) else { return (0, 0) };
    let (mut total, mut build) = (0u64, 0u64);
    for e in entries.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            let is_build = in_build || e.file_name().to_str().is_some_and(|n| BUILD_DIRS.contains(&n));
            let (t, b) = walk(&e.path(), is_build);
            total += t;
            build += b;
        } else if kind.is_file() {
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            total += len;
            if in_build {
                build += len;
            }
        }
    }
    (total, build)
}

/// Bytes of every regular file under `p`, never following symlinks; folders it cannot read count as 0.
pub fn dir_size(p: &Path) -> u64 {
    walk(p, false).0
}

/// `(total, build output)` bytes of a worktree.
pub fn worktree_size(root: &Path) -> (u64, u64) {
    walk(root, false)
}

/// The volume a path is on (unix), to tell a models folder on another disk.
fn device(p: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(p).ok().map(|m| m.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        None
    }
}

/// Bytes of each category measured from the data folder alone: models, caches, other.
pub fn data_categories(data: &Path, models_dir: Option<&Path>) -> Vec<Value> {
    let mut models = dir_size(&data.join("models")) + dir_size(&data.join("engine"));
    let mut elsewhere = false;
    if let Some(m) = models_dir.filter(|m| !m.starts_with(data)) {
        models += dir_size(m);
        elsewhere = device(m).is_some() && device(m) != device(data);
    }
    let desktop = data.join("desktop");
    let caches: u64 = CACHE_DIRS.iter().map(|n| dir_size(&desktop.join(n))).sum();
    let mut other = 0u64;
    for e in std::fs::read_dir(data).into_iter().flatten().flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if COUNTED_ELSEWHERE.contains(&name.as_ref()) {
            continue;
        }
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            other += dir_size(&e.path());
        } else if kind.is_file() {
            other += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    vec![
        json!({ "id": "models", "bytes": models, "detail": { "elsewhere": elsewhere } }),
        json!({ "id": "caches", "bytes": caches }),
        json!({ "id": "other", "bytes": other.saturating_sub(caches) }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn file(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![0u8; bytes]).unwrap();
    }

    fn bytes_of(cats: &[Value], id: &str) -> u64 {
        cats.iter().find(|c| c["id"] == id).and_then(|c| c["bytes"].as_u64()).unwrap_or(u64::MAX)
    }

    #[test]
    fn dir_size_counts_files_and_skips_symlinks() {
        let d = tempfile::tempdir().unwrap();
        file(&d.path().join("a/b.bin"), 1000);
        file(&d.path().join("c.bin"), 24);
        let outside = tempfile::tempdir().unwrap();
        file(&outside.path().join("big.bin"), 1 << 20);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("big.bin"), d.path().join("link.bin")).unwrap();
            std::os::unix::fs::symlink(outside.path(), d.path().join("linkdir")).unwrap();
        }
        assert_eq!(dir_size(d.path()), 1024);
    }

    #[cfg(unix)]
    #[test]
    fn dir_size_skips_unreadable_folders() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        file(&d.path().join("ok.bin"), 10);
        file(&d.path().join("locked/x.bin"), 99);
        fs::set_permissions(d.path().join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        let n = dir_size(d.path());
        fs::set_permissions(d.path().join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(n, 10);
    }

    #[test]
    fn worktree_build_output_counts_nested_folders_once() {
        let d = tempfile::tempdir().unwrap();
        file(&d.path().join("src/main.rs"), 100);
        file(&d.path().join("node_modules/x/index.js"), 1000);
        file(&d.path().join("node_modules/x/node_modules/y/index.js"), 500);
        file(&d.path().join("target/debug/app"), 2000);
        file(&d.path().join("apps/web/.next/cache.bin"), 300);
        assert_eq!(worktree_size(d.path()), (3900, 3800));
    }

    #[test]
    fn data_categories_do_not_double_count() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path();
        file(&data.join("models/m.gguf"), 5000);
        file(&data.join("engine/mlx/lib.so"), 700);
        file(&data.join("desktop/Cache/c"), 300);
        file(&data.join("desktop/Code Cache/c"), 30);
        file(&data.join("desktop/Preferences"), 3);
        file(&data.join("sessions/s_1.json"), 40);
        file(&data.join("attachments/s_1/a.png"), 60);
        file(&data.join("runners/images/default/disk.img"), 9000);
        file(&data.join("logs/a.log"), 7);
        file(&data.join("settings.json"), 1);
        let cats = data_categories(data, None);
        assert_eq!(bytes_of(&cats, "models"), 5700);
        assert_eq!(bytes_of(&cats, "caches"), 330);
        // settings, logs and the desktop folder's own files; never sessions, attachments or runners.
        assert_eq!(bytes_of(&cats, "other"), 11);
    }

    #[test]
    fn a_snapshot_answers_at_once_while_measuring() {
        let s = Storage::default();
        assert_eq!(s.snapshot()["measuredAt"], Value::Null);
        assert!(s.begin(false));
        assert!(!s.begin(true), "a second walk never starts while one runs");
        let snap = s.snapshot();
        assert_eq!(snap["measuring"], true);
        assert!(snap["categories"].as_array().unwrap().iter().all(|c| c["bytes"].is_null()));
        s.put(json!({ "id": "caches", "bytes": 5 }));
        assert_eq!(bytes_of(s.snapshot()["categories"].as_array().unwrap(), "caches"), 5);
        s.finish();
        let snap = s.snapshot();
        assert_eq!(snap["measuring"], false);
        assert!(snap["measuredAt"].as_f64().is_some());
        assert!(!s.begin(false), "fresh for 10 minutes");
        assert!(s.begin(true), "unless asked");
        // A refresh keeps the last figures until each is measured again.
        assert_eq!(bytes_of(s.snapshot()["categories"].as_array().unwrap(), "caches"), 5);
    }

    #[test]
    fn worktree_sizes_are_kept_for_git_management() {
        let s = Storage::default();
        s.put_worktree("/r/a", 42);
        assert_eq!(s.worktree_bytes().get("/r/a"), Some(&42));
    }

    #[test]
    fn a_models_folder_outside_the_data_folder_is_added() {
        let d = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        file(&d.path().join("models/a.gguf"), 10);
        file(&elsewhere.path().join("b.gguf"), 20);
        let cats = data_categories(d.path(), Some(elsewhere.path()));
        assert_eq!(bytes_of(&cats, "models"), 30);
    }
}
