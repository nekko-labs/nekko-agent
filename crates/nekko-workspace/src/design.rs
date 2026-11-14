//! The design board, ported from `packages/host/src/design.ts` and
//! `design-revisions.ts`: `design:get`, `design:addPage`, `design:updatePage`,
//! `design:removePage`, `design:addNote`, `design:resolveNote`, and the board
//! half of `design:generate` (the prompt, cleaning the model's answer, the
//! prototype file and the concept card; the model call is the daemon's).
//!
//! One JSON file, `<data>/design.json`, keyed by workspace id, in
//! `JSON.stringify(store, null, 2)` layout. Writes are serialized and atomic.
//! Unlike the TS host, a generation re-reads the board after the model
//! answers, so an edit made while it ran is kept.
//!
//! The board also follows the project's `nekko-designs/` folder
//! ([`follow_folder`], not in the TS host): a design an agent or a person
//! saves there becomes a card, and an edit to a card's file shows on the card.

use crate::files;
use nekko_js as js;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::now_ms;

/// One writer at a time.
static LOCK: Mutex<()> = Mutex::new(());

/// The system prompt for one-shot prototype generation (`DESIGN_SYSTEM`).
pub const DESIGN_SYSTEM: &str = "You are a world-class product designer and front-end engineer producing a single, self-contained HTML prototype.\nRules: output ONE complete HTML document. All CSS lives in a <style> tag and any JS inline in a <script> tag. No external resources of any kind (no CDNs, web fonts, or remote images; use system font stacks, CSS gradients, and inline SVG). Responsive down to 375px wide. Polished and modern: real visual hierarchy, generous whitespace, consistent spacing scale, believable placeholder content. Add hover/focus states and small interactions where they sell the design.\nOutput ONLY the HTML document. No explanations, no code fences.";

fn file(data_dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir.join("design.json"))
}

fn load(data_dir: &Path) -> Value {
    file(data_dir)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
        .map(js::js_order)
        .unwrap_or_else(|| json!({}))
}

fn save(data_dir: &Path, store: &Value) -> Result<(), String> {
    crate::write_atomic(&file(data_dir)?, js::stringify_pretty(&js::js_order(store.clone()), "  ").as_bytes())
}

/// `String(x)` of a key that may be missing.
fn key_of(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::display)
}

/// `store[workspaceId] ?? []`.
fn pages(store: &Value, workspace: &str) -> Vec<Value> {
    match store.get(workspace) {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

fn board(workspace: &str, store: &Value) -> Value {
    json!({ "workspaceId": workspace, "pages": store.get(workspace).filter(|v| !v.is_null()).cloned().unwrap_or(json!([])) })
}

/// `x.trim()` on a value the UI sent, which throws for anything but a string.
fn trim_arg(v: Option<&Value>, name: &str) -> Result<String, String> {
    match v {
        Some(Value::String(s)) => Ok(js::trim(s).to_string()),
        None => Err(format!("Cannot read properties of undefined (reading 'trim') ({name})")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading 'trim') ({name})")),
        Some(_) => Err(format!("{name}.trim is not a function")),
    }
}

/// Read-modify-write the board of one workspace.
fn edit(
    data_dir: &Path,
    workspace: &str,
    f: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, String>,
) -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(data_dir);
    let next = f(pages(&store, workspace))?;
    if let Value::Object(m) = &mut store {
        m.insert(workspace.into(), Value::Array(next));
    } else {
        store = json!({ workspace: next });
    }
    save(data_dir, &store)?;
    Ok(board(workspace, &store))
}

/// `getDesignBoard(workspaceId)`.
pub fn get(data_dir: &Path, workspace: Option<&Value>) -> Value {
    board(&key_of(workspace), &load(data_dir))
}

/// Is `url` an absolute path to an `.html` / `.htm` file (an import)?
fn is_import(url: &str) -> bool {
    static ABS: OnceLock<Regex> = OnceLock::new();
    static HTML: OnceLock<Regex> = OnceLock::new();
    let abs = ABS.get_or_init(|| Regex::with_flags(r"^(?:[a-z]:[\\/]|\/)", "i").expect("compiles"));
    let html = HTML.get_or_init(|| Regex::with_flags(r"\.html?$", "i").expect("compiles"));
    abs.find(url).is_some() && html.find(&path::extname(url)).is_some()
}

/// `addDesignPage(workspaceId, label, url)`: a live page, or an imported
/// HTML file copied into the project's `nekko-designs/` as a concept.
/// `folder` is the workspace's saved path, when it has one.
pub fn add_page(
    data_dir: &Path,
    workspace: Option<&Value>,
    label: Option<&Value>,
    url: Option<&Value>,
    folder: Option<&str>,
) -> Result<Value, String> {
    let ws = key_of(workspace);
    let now = now_ms();
    let url_text = match url {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    if url.is_some_and(Value::is_string) && is_import(&url_text) {
        if !nekko_tools::nodefs::exists(&url_text) {
            return Err("Design file does not exist.".into());
        }
        let read = files::read_file(&url_text)?;
        if js::truthy(read.get("binary")) || js::truthy(read.get("truncated")) {
            return Err("Import requires a complete HTML file under 1 MB.".into());
        }
        let content = read["content"].as_str().unwrap_or_default().to_string();
        let Some(folder) = folder else { return Err("Choose an existing project.".into()) };
        let id = nekko_js::try_uuid()?;
        let directory = path::join(&[folder, "nekko-designs"]);
        nekko_tools::nodefs::mkdir_p(&directory)?;
        let copy = path::join(&[&directory, &format!("import-{id}.html")]);
        nekko_tools::nodefs::write_utf8(&copy, &content)?;
        let label = trim_arg(label, "label")?;
        let page = json!({
            "id": id,
            "label": if label.is_empty() { "Imported design".to_string() } else { label },
            "url": "",
            "kind": "concept",
            "html": content,
            "file": copy,
            "notes": [],
            "createdAt": now,
            "updatedAt": now,
        });
        return edit(data_dir, &ws, |mut list| {
            list.push(page);
            Ok(list)
        });
    }
    let label = trim_arg(label, "label")?;
    let url_trimmed = trim_arg(url, "url")?;
    let page = json!({
        "id": nekko_js::try_uuid()?,
        "label": if label.is_empty() { url_text } else { label },
        "url": url_trimmed,
        "notes": [],
        "createdAt": now,
        "updatedAt": now,
    });
    edit(data_dir, &ws, |mut list| {
        list.push(page);
        Ok(list)
    })
}

/// `reviseDesign(page, patch)`: the patch spread over the page, the old HTML
/// kept as a revision (the last ten), `updatedAt` now.
pub fn revise(page: &Value, patch: &Value) -> Result<Value, String> {
    let patch_map = match patch {
        Value::Object(m) => m.clone(),
        Value::Null => return Err("Cannot read properties of null (reading 'html')".into()),
        _ => Map::new(),
    };
    let html = patch_map.get("html");
    if let Some(h) = html {
        match h {
            Value::String(s) if s.len() <= 1_000_000 => {}
            _ => return Err("Design HTML must be under 1 MB.".into()),
        }
    }
    let mut revisions = page.get("revisions").and_then(Value::as_array).cloned().unwrap_or_default();
    if let (Some(h), Some(old)) = (html, page.get("html"))
        && Some(h) != page.get("html")
    {
        revisions.push(json!({ "id": nekko_js::try_uuid()?, "html": old, "createdAt": page.get("updatedAt").cloned().unwrap_or(Value::Null) }));
    }
    let start = revisions.len().saturating_sub(10);
    let mut out = page.as_object().cloned().unwrap_or_default();
    for (k, v) in patch_map {
        out.insert(k, v);
    }
    out.insert("revisions".into(), Value::Array(revisions[start..].to_vec()));
    out.insert("updatedAt".into(), json!(now_ms()));
    Ok(js::js_order(Value::Object(out)))
}

/// `updateDesignPage(workspaceId, pageId, patch)`: a new HTML also lands in
/// the page's prototype file.
pub fn update_page(
    data_dir: &Path,
    workspace: Option<&Value>,
    page_id: Option<&Value>,
    patch: &Value,
) -> Result<Value, String> {
    edit(data_dir, &key_of(workspace), |list| {
        list.into_iter()
            .map(|p| {
                if p.get("id") != page_id {
                    return Ok(p);
                }
                let updated = revise(&p, patch)?;
                if let (Some(Value::String(html)), Some(f)) =
                    (patch.get("html"), p.get("file").filter(|f| js::truthy(Some(f))))
                {
                    nekko_tools::nodefs::write_utf8(&js::display(f), html)?;
                }
                Ok(updated)
            })
            .collect()
    })
}

/// `removeDesignPage(workspaceId, pageId)`. A removed card's file stays on
/// disk, so it is remembered as dismissed and [`follow_folder`] leaves it off
/// the board.
pub fn remove_page(data_dir: &Path, workspace: Option<&Value>, page_id: Option<&Value>) -> Result<Value, String> {
    let ws = key_of(workspace);
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(data_dir);
    if !store.is_object() {
        store = json!({});
    }
    let list = pages(&store, &ws);
    let file = list.iter().find(|p| p.get("id") == page_id).and_then(file_of).map(str::to_string);
    let next: Vec<Value> = list.into_iter().filter(|p| p.get("id") != page_id).collect();
    store[ws.as_str()] = Value::Array(next);
    if let Some(file) = file {
        let key = dismissed_key(&ws);
        let mut dismissed = dismissed(&store, &ws);
        if !dismissed.iter().any(|d| file_key(d) == file_key(&file)) {
            dismissed.push(file);
        }
        store[key.as_str()] = json!(dismissed);
    }
    save(data_dir, &store)?;
    Ok(board(&ws, &store))
}

/// Where a workspace's dismissed design files are kept, beside the boards. No
/// workspace id contains `#`, so it is never read as a board.
fn dismissed_key(workspace: &str) -> String {
    format!("{workspace}#dismissed")
}

/// The design files whose cards were removed from this workspace's board.
fn dismissed(store: &Value, workspace: &str) -> Vec<String> {
    match store.get(dismissed_key(workspace)) {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// A card's prototype file, when it has one.
fn file_of(page: &Value) -> Option<&str> {
    page.get("file").and_then(Value::as_str).filter(|f| !f.is_empty())
}

/// A path as the board compares files: either separator, any case.
fn file_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// The most files one board adopts from its folder.
const FOLLOW_LIMIT: usize = 200;

/// A design file's HTML when the board can hold it: complete, text, markup,
/// and within the size [`revise`] accepts.
fn read_design(file: &str) -> Option<String> {
    let read = files::read_file(file).ok()?;
    if js::truthy(read.get("binary")) || js::truthy(read.get("truncated")) {
        return None;
    }
    let html = read.get("content")?.as_str()?;
    (html.contains('<') && html.len() <= 1_000_000).then(|| html.to_string())
}

/// A card's label for an adopted file: the page's `<title>`, else its file
/// name as words (`checkout-design.html` is "Checkout design").
fn adopted_label(html: &str, name: &str) -> String {
    // ASCII lower-casing keeps every byte offset, so they index `html` too.
    let lower = html.to_ascii_lowercase();
    let title = lower.find("<title").and_then(|at| {
        let from = at + lower[at..].find('>')? + 1;
        let to = from + lower[from..].find("</title")?;
        let text = html[from..to].split_whitespace().collect::<Vec<_>>().join(" ");
        (!text.is_empty()).then(|| text.chars().take(60).collect::<String>())
    });
    if let Some(title) = title {
        return title;
    }
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let words = stem.replace(['-', '_'], " ");
    let mut chars = words.trim().chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "Design".into(),
    }
}

/// The board, brought in step with the project's `nekko-designs/` folder
/// first. `folder` is the workspace's saved path, when it has one.
///
/// - A concept whose file changed on disk (an agent or a person edited it)
///   takes the file's HTML; the HTML it had is kept as a revision.
/// - An HTML file in the folder that no card owns becomes a concept card with
///   origin `file`, unless its card was removed before.
///
/// Nothing is written when nothing changed, and never to the folder.
pub fn follow_folder(data_dir: &Path, workspace: Option<&Value>, folder: Option<&str>) -> Result<Value, String> {
    let ws = key_of(workspace);
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(data_dir);
    let mut list = pages(&store, &ws);
    let mut changed = false;

    for page in &mut list {
        if page.get("kind").and_then(Value::as_str) != Some("concept") {
            continue;
        }
        let Some(html) = file_of(page).and_then(read_design) else { continue };
        if page.get("html").and_then(Value::as_str) != Some(html.as_str()) {
            *page = revise(page, &json!({ "html": html }))?;
            changed = true;
        }
    }

    let dir = folder.map(|f| path::join(&[f, "nekko-designs"])).filter(|d| nekko_tools::nodefs::exists(d));
    if let Some(dir) = dir {
        let mut skip: std::collections::HashSet<String> = list.iter().filter_map(file_of).map(file_key).collect();
        skip.extend(dismissed(&store, &ws).iter().map(|d| file_key(d)));
        let mut names: Vec<String> = nekko_tools::nodefs::read_dir(&dir)
            .unwrap_or_default()
            .into_iter()
            .filter(|e| !e.is_dir && is_html(&e.name))
            .map(|e| e.name)
            .collect();
        names.sort();
        let now = now_ms();
        for name in names.into_iter().take(FOLLOW_LIMIT) {
            let file = path::join(&[&dir, &name]);
            if !skip.insert(file_key(&file)) {
                continue;
            }
            let Some(html) = read_design(&file) else { continue };
            let mut page = Map::new();
            page.insert("id".into(), json!(nekko_js::try_uuid()?));
            page.insert("kind".into(), json!("concept"));
            page.insert("label".into(), json!(adopted_label(&html, &name)));
            page.insert("url".into(), json!(""));
            page.insert("html".into(), json!(html));
            page.insert("origin".into(), json!("file"));
            page.insert("file".into(), json!(file));
            page.insert("notes".into(), json!([]));
            page.insert("createdAt".into(), json!(now));
            page.insert("updatedAt".into(), json!(now));
            list.push(Value::Object(page));
            changed = true;
        }
    }

    if changed {
        if !store.is_object() {
            store = json!({});
        }
        store[ws.as_str()] = Value::Array(list);
        save(data_dir, &store)?;
    }
    Ok(board(&ws, &store))
}

/// First line of the index file, which marks it as the app's: a README the
/// person wrote themselves never starts with it and is never overwritten.
pub const INDEX_MARKER: &str =
    "<!-- Kept by Nekko Agent from the Design board. Edits to this file are overwritten. -->";

fn cell(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "\\|")
}

/// The text of `nekko-designs/README.md`: each board card as a row of label,
/// file (relative to the folder) and open notes, so an agent on any provider
/// reads what designs exist and what is pinned to them without a tool.
pub fn index_text(dir: &str, board: &Value) -> String {
    let pages = board.get("pages").and_then(Value::as_array).cloned().unwrap_or_default();
    let prefix = format!("{}/", dir.replace('\\', "/").trim_end_matches('/'));
    let mut out = format!(
        "{INDEX_MARKER}\n# Designs\n\nThe designs on this project's Design board. Open a file to build from it; the highest version of a design (-v2, -v3) is current. Notes are changes the person pinned and has not resolved yet.\n"
    );
    let mut rows = String::new();
    let mut live = String::new();
    for p in &pages {
        let label = cell(p.get("label").and_then(Value::as_str).unwrap_or("Untitled"));
        if let Some(file) = file_of(p) {
            let norm = file.replace('\\', "/");
            let shown = norm.strip_prefix(&prefix).unwrap_or(&norm);
            let notes: Vec<String> = p
                .get("notes")
                .and_then(Value::as_array)
                .map(|n| n.iter().filter_map(|n| n.get("text").and_then(Value::as_str)).map(cell).collect())
                .unwrap_or_default();
            rows.push_str(&format!("| {label} | {} | {} |\n", cell(shown), notes.join("; ")));
        } else if let Some(url) = p.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()) {
            live.push_str(&format!("- {label}: {}\n", cell(url)));
        }
    }
    if rows.is_empty() && live.is_empty() {
        out.push_str("\nNo designs on the board yet.\n");
    }
    if !rows.is_empty() {
        out.push_str(&format!("\n| Label | File | Notes |\n| --- | --- | --- |\n{rows}"));
    }
    if !live.is_empty() {
        out.push_str(&format!("\n## Live pages\n\n{live}"));
    }
    out
}

/// Keep `nekko-designs/README.md` in step with the board. Does nothing when
/// the project has no designs folder, when the README is not the app's own,
/// or when it already says the same. Returns whether it wrote.
pub fn write_index(folder: &str, board: &Value) -> Result<bool, String> {
    let dir = path::join(&[folder, "nekko-designs"]);
    if !nekko_tools::nodefs::exists(&dir) {
        return Ok(false);
    }
    let file = path::join(&[&dir, "README.md"]);
    let existing = if nekko_tools::nodefs::exists(&file) { nekko_tools::nodefs::read_utf8(&file).ok() } else { None };
    if existing.as_deref().is_some_and(|t| !t.starts_with(INDEX_MARKER)) {
        return Ok(false);
    }
    let text = index_text(&dir, board);
    if existing.as_deref() == Some(text.as_str()) {
        return Ok(false);
    }
    nekko_tools::nodefs::write_utf8(&file, &text)?;
    Ok(true)
}

/// Does the name end in `.html` or `.htm`, any case?
fn is_html(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".html") || lower.ends_with(".htm")
}

/// `{ ...p, [key]: value, updatedAt }` keeping each key where it was.
fn with(p: &Value, key: &str, value: Value) -> Value {
    let mut m = p.as_object().cloned().unwrap_or_default();
    m.insert(key.into(), value);
    m.insert("updatedAt".into(), json!(now_ms()));
    js::js_order(Value::Object(m))
}

/// `addDesignNote(workspaceId, pageId, text)`.
pub fn add_note(
    data_dir: &Path,
    workspace: Option<&Value>,
    page_id: Option<&Value>,
    text: Option<&Value>,
) -> Result<Value, String> {
    edit(data_dir, &key_of(workspace), |list| {
        list.into_iter()
            .map(|p| {
                if p.get("id") != page_id {
                    return Ok(p);
                }
                let mut notes = p.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
                notes.push(
                    json!({ "id": nekko_js::try_uuid()?, "text": trim_arg(text, "text")?, "createdAt": now_ms() }),
                );
                Ok(with(&p, "notes", Value::Array(notes)))
            })
            .collect()
    })
}

/// `resolveDesignNote(workspaceId, pageId, noteId)`.
pub fn resolve_note(
    data_dir: &Path,
    workspace: Option<&Value>,
    page_id: Option<&Value>,
    note_id: Option<&Value>,
) -> Result<Value, String> {
    edit(data_dir, &key_of(workspace), |list| {
        Ok(list
            .into_iter()
            .map(|p| {
                if p.get("id") != page_id {
                    return p;
                }
                let notes: Vec<Value> = p
                    .get("notes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|n| n.get("id") != note_id)
                    .collect();
                with(&p, "notes", Value::Array(notes))
            })
            .collect())
    })
}

/// `designAsk(existing, input, prompt)`.
pub fn ask(existing: Option<&Value>, input: &Value, prompt: &str) -> String {
    if let Some(html) = existing.and_then(|e| e.get("html")).filter(|h| js::truthy(Some(h))) {
        let html = js::display(html);
        return format!(
            "Here is the current prototype:\n\n{}\n\nApply this change and output the full updated document, keeping everything else intact: {prompt}",
            js::slice16(&html, 60000)
        );
    }
    if js::truthy(input.get("sketchDataUrl")) {
        let extra = if prompt.is_empty() { String::new() } else { format!("\n\nAdditional instructions: {prompt}") };
        return format!(
            "Turn the attached hand-drawn sketch into a working, polished HTML prototype. Follow the sketch's layout, boxes, and annotations faithfully, then fill in professional visual design (type, color, spacing).{extra}"
        );
    }
    format!("Design this: {prompt}")
}

/// `cleanDesignOutput(raw)`.
pub fn clean_output(raw: &str) -> Result<String, String> {
    static FENCE_OPEN: OnceLock<Regex> = OnceLock::new();
    static FENCE_CLOSE: OnceLock<Regex> = OnceLock::new();
    let open = FENCE_OPEN.get_or_init(|| Regex::with_flags(r"^```(?:html)?\s*", "i").expect("compiles"));
    let close = FENCE_CLOSE.get_or_init(|| Regex::with_flags(r"\s*```\s*$", "i").expect("compiles"));
    let mut out = raw.to_string();
    if let Some(m) = open.find(&out) {
        out.replace_range(m.range(), "");
    }
    if let Some(m) = close.find(&out) {
        out.replace_range(m.range(), "");
    }
    let out = js::trim(&out).to_string();
    // Indices are UTF-16 offsets into the lower-cased text, applied to the original, as in JS.
    let lower: Vec<u16> = out.to_lowercase().encode_utf16().collect();
    let find = |needle: &str| {
        let n: Vec<u16> = needle.encode_utf16().collect();
        lower.windows(n.len()).position(|w| w == n.as_slice())
    };
    let start = find("<!doctype").or_else(|| find("<html"));
    let out = match start {
        Some(s) if s > 0 => {
            let units: Vec<u16> = out.encode_utf16().collect();
            String::from_utf16_lossy(&units[s.min(units.len())..])
        }
        _ => out,
    };
    if !out.contains('<') {
        return Err("The model returned no HTML. Try again, or pick a stronger default model in Models.".into());
    }
    Ok(out)
}

/// `designLabel(input, existing, prompt)`.
pub fn label(input: &Value, existing: Option<&Value>, prompt: &str) -> Result<String, String> {
    let own = match input.get("label") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js::trim(s).to_string(),
        Some(_) => return Err("input.label?.trim is not a function".into()),
    };
    let chosen = if !own.is_empty() {
        own
    } else if let Some(l) = existing.and_then(|e| e.get("label")).filter(|l| js::truthy(Some(l))) {
        js::display(l)
    } else if !prompt.is_empty() {
        js::slice16(prompt, 42).to_string()
    } else {
        "Concept".into()
    };
    Ok(js::trim(&chosen).to_string())
}

/// `designSlug(label)`.
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in label.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let s = out.trim_matches('-');
    let s: String = s.chars().take(40).collect();
    if s.is_empty() { "design".into() } else { s }
}

/// What a generation needs before the model call: the trimmed prompt, the
/// page being refined (if any), and the request text and images.
pub struct Plan {
    pub prompt: String,
    pub existing: Option<Value>,
    pub ask: String,
    pub images: Option<Vec<Value>>,
}

/// The checks and the request `generateDesign` makes before calling the model.
pub fn plan(data_dir: &Path, workspace: Option<&Value>, input: &Value) -> Result<Plan, String> {
    if !input.is_object() {
        return Err("Cannot read properties of undefined (reading 'prompt')".into());
    }
    let prompt = match input.get("prompt") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js::trim(s).to_string(),
        Some(_) => return Err("(input.prompt ?? '').trim is not a function".into()),
    };
    if prompt.is_empty() && !js::truthy(input.get("sketchDataUrl")) {
        return Err("Describe the design or draw a sketch first.".into());
    }
    let store = load(data_dir);
    let existing = input
        .get("pageId")
        .filter(|p| js::truthy(Some(p)))
        .and_then(|id| pages(&store, &key_of(workspace)).into_iter().find(|p| p.get("id") == Some(id)));
    let ask = ask(existing.as_ref(), input, &prompt);
    let images =
        (existing.is_none() && js::truthy(input.get("sketchDataUrl"))).then(|| vec![input["sketchDataUrl"].clone()]);
    Ok(Plan { prompt, existing, ask, images })
}

/// The board half of `generateDesign` once the model answered: the
/// prototype written into the project and the concept card saved.
pub fn land(
    data_dir: &Path,
    workspace: Option<&Value>,
    input: &Value,
    plan: &Plan,
    raw: &str,
    folder: Option<&str>,
) -> Result<Value, String> {
    let out = clean_output(raw)?;
    let label = label(input, plan.existing.as_ref(), &plan.prompt)?;
    let existing_file = plan.existing.as_ref().and_then(|e| e.get("file")).filter(|f| !f.is_null()).cloned();
    let mut file_path = existing_file.clone();
    if let Some(folder) = folder {
        let written = (|| -> Result<Value, String> {
            let dir = path::join(&[folder, "nekko-designs"]);
            nekko_tools::nodefs::mkdir_p(&dir)?;
            let target = match &file_path {
                Some(f) if js::truthy(Some(f)) => js::display(f),
                _ => path::join(&[&dir, &format!("{}-{}.html", slug(&label), &nekko_js::try_uuid()?[..6])]),
            };
            nekko_tools::nodefs::write_utf8(&target, &out)?;
            Ok(json!(target))
        })();
        // The board still works without the file mirror.
        file_path = written.ok().or(existing_file);
    }
    let now = now_ms();
    let ws = key_of(workspace);
    match &plan.existing {
        Some(existing) => {
            let id = existing.get("id").cloned();
            edit(data_dir, &ws, |list| {
                list.into_iter()
                    .map(|p| {
                        if p.get("id") != id.as_ref() {
                            return Ok(p);
                        }
                        let mut m = revise(&p, &json!({ "html": out }))?.as_object().cloned().unwrap_or_default();
                        let prompt =
                            if plan.prompt.is_empty() { p.get("prompt").cloned() } else { Some(json!(plan.prompt)) };
                        match prompt {
                            Some(v) => m.insert("prompt".into(), v),
                            None => m.shift_remove("prompt"),
                        };
                        match &file_path {
                            Some(f) => m.insert("file".into(), f.clone()),
                            None => m.shift_remove("file"),
                        };
                        m.insert("updatedAt".into(), json!(now));
                        Ok(js::js_order(Value::Object(m)))
                    })
                    .collect()
            })
        }
        None => {
            let mut page = Map::new();
            page.insert("id".into(), json!(nekko_js::try_uuid()?));
            page.insert("kind".into(), json!("concept"));
            page.insert("label".into(), json!(label));
            page.insert("url".into(), json!(""));
            page.insert("html".into(), json!(out));
            page.insert("prompt".into(), json!(plan.prompt));
            page.insert(
                "origin".into(),
                json!(if js::truthy(input.get("sketchDataUrl")) { "sketch" } else { "prompt" }),
            );
            if let Some(f) = &file_path {
                page.insert("file".into(), f.clone());
            }
            page.insert("notes".into(), json!([]));
            page.insert("createdAt".into(), json!(now));
            page.insert("updatedAt".into(), json!(now));
            edit(data_dir, &ws, |mut list| {
                list.push(Value::Object(page));
                Ok(list)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_cleans_like_the_ts_helpers() {
        assert_eq!(slug("  Hello, World! Ünïcode  "), "hello-world-n-code");
        assert_eq!(slug("!!!"), "design");
        assert_eq!(clean_output("```html\n<!DOCTYPE html><p>x</p>\n```").unwrap(), "<!DOCTYPE html><p>x</p>");
        assert_eq!(clean_output("Sure! <html><body/></html>").unwrap(), "<html><body/></html>");
        assert!(clean_output("no markup").is_err());
    }
}
