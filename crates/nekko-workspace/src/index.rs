//! The workspace index, ported from `packages/host/src/workspace.ts`:
//! `workspace:index`, `workspace:indexStatus`, `workspace:files`,
//! `workspace:search`, and the chat's index snippets (`collectIndexSnippets`
//! in chat.ts, served as `workspace:snippets`).
//!
//! Same walk, same caps and the same results as the TS index, in memory like
//! it. Two differences that change only the cost: a re-index reuses the
//! outline of every file whose size and modification time are unchanged
//! (a re-index of an untouched tree reads no file contents), and it all runs
//! off the daemon's async threads instead of blocking the host's event loop.

use crate::outline::{IGNORED_DIRS, Symbol, detect_language, extract_outline, is_indexable};
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use crate::now_ms;

/// The walk stops at this many files.
const MAX_FILES: usize = 5000;
/// Larger files are left out of the index.
const MAX_SIZE: u64 = 1_000_000;
/// A search returns at most this many hits.
const MAX_HITS: usize = 100;

/// One `IndexedFile`.
#[derive(Clone, Debug)]
pub struct IndexedFile {
    pub path: String,
    pub rel_path: String,
    pub size: u64,
    pub language: Option<&'static str>,
    pub symbols: Arc<Vec<Symbol>>,
}

impl IndexedFile {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("path".into(), json!(self.path));
        m.insert("relPath".into(), json!(self.rel_path));
        m.insert("sizeBytes".into(), json!(self.size));
        if let Some(l) = self.language {
            m.insert("language".into(), json!(l));
        }
        m.insert(
            "symbols".into(),
            Value::Array(
                self.symbols.iter().map(|s| json!({ "name": s.name, "kind": s.kind, "line": s.line })).collect(),
            ),
        );
        Value::Object(m)
    }
}

/// What the last read of a file's outline saw, to skip unchanged files.
struct Outline {
    size: u64,
    modified: Option<SystemTime>,
    symbols: Arc<Vec<Symbol>>,
}

#[derive(Default)]
struct State {
    files: HashMap<String, Arc<Vec<IndexedFile>>>,
    status: HashMap<String, Value>,
    /// Per workspace, per absolute path.
    outlines: HashMap<String, HashMap<String, Outline>>,
}

/// Every workspace's index. One per daemon.
#[derive(Default)]
pub struct Index {
    state: Mutex<State>,
}

fn status(workspace_id: &str, files: usize, symbols: usize, progress: u8, state: &str) -> Value {
    json!({
        "workspaceId": workspace_id,
        "fileCount": files,
        "symbolCount": symbols,
        "progress": progress,
        "state": state,
        "updatedAt": now_ms(),
    })
}

impl Index {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `getIndexStatus(id)`: null before the first index.
    pub fn status(&self, workspace_id: &str) -> Value {
        self.lock().status.get(workspace_id).cloned().unwrap_or(Value::Null)
    }

    /// `listIndexedFiles(id)`.
    pub fn files(&self, workspace_id: &str) -> Arc<Vec<IndexedFile>> {
        self.lock().files.get(workspace_id).cloned().unwrap_or_default()
    }

    /// Forget a workspace (its folder was removed).
    pub fn forget(&self, workspace_id: &str) {
        let mut s = self.lock();
        s.files.remove(workspace_id);
        s.status.remove(workspace_id);
        s.outlines.remove(workspace_id);
    }

    /// `indexWorkspace(folder, onProgress)`: walk the folder, outline what it
    /// can, and report `indexing` then `ready`. Blocking; bounded by
    /// `MAX_FILES`.
    pub fn index(&self, workspace_id: &str, root: &str, on_progress: &dyn Fn(&Value)) -> Value {
        let start = status(workspace_id, 0, 0, 0, "indexing");
        let previous = {
            let mut s = self.lock();
            s.status.insert(workspace_id.into(), start.clone());
            s.outlines.remove(workspace_id).unwrap_or_default()
        };
        on_progress(&start);

        let mut walk = Walk { root, files: Vec::new(), symbols: 0, previous, outlines: HashMap::new() };
        walk.dir(root);
        let done = status(workspace_id, walk.files.len(), walk.symbols, 1, "ready");
        {
            let mut s = self.lock();
            s.files.insert(workspace_id.into(), Arc::new(walk.files));
            s.outlines.insert(workspace_id.into(), walk.outlines);
            s.status.insert(workspace_id.into(), done.clone());
        }
        on_progress(&done);
        done
    }

    /// `searchWorkspace(folder, query)`: case-insensitive substring over the
    /// indexed files' lines, in index order, at most 100 hits. Files are read
    /// a batch at a time on several threads; the hits keep the index's order.
    pub fn search(&self, workspace_id: &str, query: &str) -> Vec<Value> {
        let files = self.files(workspace_id);
        let q = query.to_lowercase();
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8);
        let mut hits = Vec::new();
        for batch in files.chunks(threads * 16) {
            let per_file: Vec<Vec<(usize, String)>> = if threads == 1 || batch.len() < 4 {
                batch.iter().map(|f| file_hits(&f.path, &q, MAX_HITS)).collect()
            } else {
                let mut out: Vec<Vec<(usize, String)>> = vec![Vec::new(); batch.len()];
                let size = batch.len().div_ceil(threads);
                std::thread::scope(|s| {
                    for (files, slots) in batch.chunks(size).zip(out.chunks_mut(size)) {
                        let q = &q;
                        s.spawn(move || {
                            for (f, slot) in files.iter().zip(slots.iter_mut()) {
                                *slot = file_hits(&f.path, q, MAX_HITS);
                            }
                        });
                    }
                });
                out
            };
            for (f, lines) in batch.iter().zip(per_file) {
                for (line, text) in lines {
                    if hits.len() >= MAX_HITS {
                        return hits;
                    }
                    hits.push(json!({ "path": f.path, "relPath": f.rel_path, "line": line, "text": text }));
                }
            }
            if hits.len() >= MAX_HITS {
                break;
            }
        }
        hits
    }

    /// `collectIndexSnippets(workspaceIds, query)` from chat.ts: the query's
    /// keyword tokens searched across the chat's workspaces, hits grouped per
    /// file, and the best four files. `workspaces` is `(id, found)` in the
    /// chat's order, `found` false for an id no longer in the settings.
    pub fn snippets(&self, workspaces: &[(String, bool)], query: &str) -> Vec<Value> {
        if workspaces.is_empty() || nekko_js::trim(query).is_empty() {
            return Vec::new();
        }
        let tokens = keyword_tokens(query);
        if tokens.is_empty() {
            return Vec::new();
        }
        struct Entry {
            rel_path: String,
            lines: Vec<String>,
            rank: usize,
        }
        let mut order: Vec<String> = Vec::new();
        let mut by_file: HashMap<String, Entry> = HashMap::new();
        for (rank, (id, found)) in workspaces.iter().enumerate() {
            if !found {
                continue;
            }
            for token in &tokens {
                for hit in self.search(id, token) {
                    let path = hit["path"].as_str().unwrap_or_default().to_string();
                    let entry = by_file.entry(path.clone()).or_insert_with(|| {
                        order.push(path.clone());
                        Entry { rel_path: hit["relPath"].as_str().unwrap_or_default().into(), lines: Vec::new(), rank }
                    });
                    if entry.lines.len() < 8 {
                        entry.lines.push(format!("{}: {}", hit["line"], hit["text"].as_str().unwrap_or_default()));
                    }
                }
            }
        }
        let mut list: Vec<(String, Entry)> =
            order.into_iter().filter_map(|p| by_file.remove(&p).map(|e| (p, e))).collect();
        list.sort_by(|a, b| a.1.rank.cmp(&b.1.rank).then(b.1.lines.len().cmp(&a.1.lines.len())));
        list.into_iter()
            .take(4)
            .map(|(path, e)| json!({ "relPath": e.rel_path, "path": path, "body": e.lines.join("\n") }))
            .collect()
    }
}

/// `Array.from(new Set(query.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])).slice(0, 6)`.
pub fn keyword_tokens(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut run = String::new();
    let word = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_';
    for c in lower.chars().chain(std::iter::once(' ')) {
        if word(c) {
            run.push(c);
            continue;
        }
        if run.len() >= 4 && !out.contains(&run) {
            out.push(run.clone());
        }
        run.clear();
    }
    out.truncate(6);
    out
}

/// One file's matching lines as `searchWorkspace` reports them (number and
/// trimmed text cut to 200 UTF-16 units), at most `cap`. An ASCII file and
/// query are searched in one pass over the lower-cased bytes; anything else
/// line by line with full Unicode lower-casing.
fn file_hits(path: &str, q: &str, cap: usize) -> Vec<(usize, String)> {
    let Ok(bytes) = std::fs::read(path) else { return Vec::new() };
    let content = String::from_utf8_lossy(&bytes);
    let hit = |i: usize, line: &str| (i + 1, nekko_js::slice16(nekko_js::trim(line), 200).to_string());
    let mut out = Vec::new();
    if q.is_empty() || !content.is_ascii() || !q.is_ascii() {
        for (i, line) in content.split('\n').enumerate() {
            if out.len() >= cap {
                break;
            }
            if contains_folded(line, q) {
                out.push(hit(i, line));
            }
        }
        return out;
    }
    // A line never holds a newline, so a query with one matches nothing.
    if q.contains('\n') {
        return out;
    }
    let text = content.as_bytes();
    let lower = text.to_ascii_lowercase();
    let finder = memchr::memmem::Finder::new(q.as_bytes());
    let (mut pos, mut line_no, mut counted) = (0usize, 0usize, 0usize);
    while out.len() < cap
        && let Some(i) = finder.find(&lower[pos..])
    {
        let at = pos + i;
        let start = memchr::memrchr(b'\n', &lower[..at]).map_or(0, |p| p + 1);
        let end = memchr::memchr(b'\n', &lower[at..]).map_or(lower.len(), |p| at + p);
        line_no += memchr::memchr_iter(b'\n', &lower[counted..start]).count();
        counted = start;
        // ASCII content: every byte offset is a char boundary.
        out.push(hit(line_no, &content[start..end]));
        if end >= lower.len() {
            break;
        }
        pos = end + 1;
    }
    out
}

/// `line.toLowerCase().includes(q)`, without lower-casing ASCII lines.
fn contains_folded(line: &str, q: &str) -> bool {
    if q.is_empty() {
        return true;
    }
    if line.is_ascii() && q.is_ascii() {
        let (l, n) = (line.as_bytes(), q.as_bytes());
        return l.len() >= n.len() && l.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n));
    }
    line.to_lowercase().contains(q)
}

struct Walk<'a> {
    root: &'a str,
    files: Vec<IndexedFile>,
    symbols: usize,
    previous: HashMap<String, Outline>,
    outlines: HashMap<String, Outline>,
}

impl Walk<'_> {
    fn dir(&mut self, dir: &str) {
        if self.files.len() >= MAX_FILES {
            return;
        }
        let Ok(entries) = nodefs::read_dir(dir) else { return };
        for e in entries {
            if self.files.len() >= MAX_FILES {
                return;
            }
            let ignored = IGNORED_DIRS.contains(&e.name.as_str());
            if e.name.starts_with('.') && e.name != ".env" && ignored {
                continue;
            }
            if e.is_dir {
                if !ignored {
                    self.dir(&path::join(&[dir, &e.name]));
                }
            } else if is_indexable(&e.name) {
                self.file(path::join(&[dir, &e.name]));
            }
        }
    }

    fn file(&mut self, full: String) {
        // statSync follows links, as the TS walk does.
        let Ok(meta) = std::fs::metadata(&full) else { return };
        let size = meta.len();
        if size > MAX_SIZE {
            return;
        }
        let language = detect_language(&full);
        let modified = meta.modified().ok();
        let symbols = match self.previous.remove(&full) {
            Some(o) if o.size == size && o.modified.is_some() && o.modified == modified => o.symbols,
            _ => Arc::new(match language {
                Some(l) => std::fs::read(&full)
                    .map(|b| extract_outline(&String::from_utf8_lossy(&b), Some(l)))
                    .unwrap_or_default(),
                None => Vec::new(),
            }),
        };
        self.symbols += symbols.len();
        self.outlines.insert(full.clone(), Outline { size, modified, symbols: symbols.clone() });
        self.files.push(IndexedFile {
            rel_path: path::relative(self.root, &full).replace('\\', "/"),
            path: full,
            size,
            language,
            symbols,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unique_lowercase_words_of_four_or_more() {
        assert_eq!(keyword_tokens("Fix the Index_Search in a b c FIX"), ["index_search"]);
        assert_eq!(
            keyword_tokens("éabcd wxyz wxyz 12345 a1b2c3d4e5 f g h i j k l1234 m5678"),
            ["abcd", "wxyz", "12345", "a1b2c3d4e5", "l1234", "m5678"]
        );
    }

    #[test]
    fn the_one_pass_search_finds_what_the_line_by_line_one_does() {
        let path = std::env::temp_dir().join(format!("nekko-ws-hits-{}", now_ms()));
        let text = "aXa xa xa\r\nfoo\n\nAXA\n  padded Xa  \nxa";
        std::fs::write(&path, text).unwrap();
        let p = path.to_string_lossy().into_owned();
        for q in ["xa", "a", "foo\n", "zz", " xa", "\r"] {
            let slow: Vec<(usize, String)> = text
                .split('\n')
                .enumerate()
                .filter(|(_, l)| contains_folded(l, q))
                .map(|(i, l)| (i + 1, nekko_js::trim(l).to_string()))
                .collect();
            assert_eq!(file_hits(&p, q, 100), slow, "query {q:?}");
        }
        assert_eq!(file_hits(&p, "xa", 2).len(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_reindex_rereads_only_changed_files() {
        let dir = std::env::temp_dir().join(format!("nekko-ws-incr-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.ts");
        std::fs::write(&file, "export function aa() {}\n").unwrap();
        let index = Index::new();
        let root = dir.to_string_lossy().into_owned();
        index.index("w", &root, &|_| {});
        assert_eq!(index.files("w")[0].symbols[0].name, "aa");
        // Same size, new content: only the modification time tells.
        std::fs::write(&file, "export function bb() {}\n").unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        index.index("w", &root, &|_| {});
        assert_eq!(index.files("w")[0].symbols[0].name, "bb");
        // Unchanged: the outline is the cached one.
        let before = index.files("w")[0].symbols.clone();
        index.index("w", &root, &|_| {});
        assert!(Arc::ptr_eq(&before, &index.files("w")[0].symbols));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn folds_case_like_to_lower_case() {
        assert!(contains_folded("Hello World", "o w"));
        assert!(contains_folded("KELVIN \u{212A}", "kelvin k"));
        assert!(!contains_folded("abc", "abcd"));
    }
}
