//! Skills: marketplace installs, skills other agent tools keep, and the
//! Vaizer catalog. Ported from `packages/host/src/skills.ts`,
//! `external-skills.ts` and `vaizer.ts`, with `parseSkillMarkdown`,
//! `skillToMarkdown` and `normalizeInstallTarget` from `@nekko-agent/shared`:
//! `skills:installed`, `skills:external`, `skills:targets`, `skill:install`,
//! `skill:uninstall`, `vaizer:catalog`, `vaizer:skillMd`.
//!
//! The built-in catalog, the built-in skill names and the bundled Vaizer
//! snapshot come from the TS sources (`skills-data.json`, written by
//! packages/host/src/skills.golden.test.ts, which fails when it goes stale).

use nekko_js as js;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::now_ms;

/// The TS host's data: `MARKET_SKILLS`, `SKILLS` names, `VAIZER_SNAPSHOT`.
const DATA: &str = include_str!("skills-data.json");

fn data() -> &'static Value {
    static D: OnceLock<Value> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(DATA).unwrap_or(Value::Null))
}

fn re(cell: &'static OnceLock<Regex>, src: &str, flags: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::with_flags(src, flags).expect("skill pattern compiles"))
}

/// One writer of `skills.json` at a time.
static LOCK: Mutex<()> = Mutex::new(());

const TARGETS: &[&str] = &["nekko-agent", "claude", "codex"];

/// `normalizeInstallTarget(target)`.
pub fn normalize_target(target: Option<&Value>) -> &'static str {
    match target.and_then(Value::as_str) {
        Some(t) if !t.is_empty() => TARGETS.iter().find(|x| **x == t).copied().unwrap_or("nekko-agent"),
        _ => "nekko-agent",
    }
}

/// `getMarketSkill(id)`.
pub fn market_skill(id: &Value) -> Option<Value> {
    data()["market"].as_array()?.iter().find(|s| s.get("id") == Some(id)).cloned()
}

/// `${v}` of a field that may be missing.
fn show(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js::display)
}

/// `skillToMarkdown(m)`.
pub fn skill_to_markdown(m: &Value) -> String {
    if let Some(md) = m.get("markdown").filter(|v| js::truthy(Some(v))) {
        let md = js::display(md);
        return if md.ends_with('\n') { md } else { format!("{md}\n") };
    }
    let url = m.get("url").filter(|v| js::truthy(Some(v))).map(|u| format!(", {}", js::display(u))).unwrap_or_default();
    let mut lines = vec![
        "---".to_string(),
        format!("name: {}", show(m.get("name"))),
        format!("description: {}", show(m.get("description"))),
        "---".into(),
        String::new(),
        format!("# {}", show(m.get("name"))),
        String::new(),
        // `[...].join('\n')` prints a missing element as nothing.
        m.get("instructions").filter(|v| !v.is_null()).map(js::display).unwrap_or_default(),
        String::new(),
        format!("> Installed from the Nekko Agent skills marketplace (author: {}{url}).", show(m.get("author"))),
    ];
    if let Some(b) = m.get("basedOn").filter(|v| js::truthy(Some(v))) {
        lines.push(format!(
            "> Based on {}; this is our own summary, see the original for its full text.",
            js::display(b)
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn file(data_dir: &Path) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir.join("skills.json"))
}

fn load(data_dir: &Path) -> Vec<Value> {
    file(data_dir)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
        .and_then(|v| match v {
            Value::Array(a) => Some(a),
            _ => None,
        })
        .map(|a| a.into_iter().map(js::js_order).collect())
        .unwrap_or_default()
}

fn save(data_dir: &Path, records: &[Value]) -> Result<(), String> {
    crate::write_atomic(&file(data_dir)?, js::stringify_pretty(&Value::Array(records.to_vec()), "  ").as_bytes())
}

fn path_of(r: &Value) -> Option<String> {
    r.get("path").filter(|p| js::truthy(Some(p))).map(js::display)
}

fn list_locked(data_dir: &Path) -> Vec<Value> {
    let records = load(data_dir);
    let alive: Vec<Value> = records.iter().filter(|r| path_of(r).is_none_or(|p| nodefs::exists(&p))).cloned().collect();
    // Self-heal: drop records whose file-based install was deleted out of band.
    if alive.len() != records.len() {
        let _ = save(data_dir, &alive);
    }
    alive
}

/// `listInstalledSkills()`.
pub fn list_installed(data_dir: &Path) -> Vec<Value> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    list_locked(data_dir)
}

/// The user-level skills folder of a file-based target.
fn target_dir(home: &str, target: &str) -> Option<String> {
    match target {
        "claude" => Some(path::join(&[home, ".claude", "skills"])),
        "codex" => Some(path::join(&[home, ".codex", "skills"])),
        _ => None,
    }
}

/// `skillTargets()`.
pub fn targets(home: &str) -> Value {
    json!([
        { "id": "nekko-agent", "label": "Nekko Agent", "hint": "joins the / menu and Skills tab", "available": true },
        {
            "id": "claude",
            "label": "Claude Code",
            "hint": "~/.claude/skills/<name>/SKILL.md",
            "available": nodefs::exists(&path::join(&[home, ".claude"])),
            "dir": target_dir(home, "claude"),
        },
        {
            "id": "codex",
            "label": "Codex",
            "hint": "~/.codex/skills/<name>/SKILL.md",
            "available": nodefs::exists(&path::join(&[home, ".codex"])),
            "dir": target_dir(home, "codex"),
        },
    ])
}

/// `installSkill(skillId, target, payload)`.
pub fn install(
    data_dir: &Path,
    home: &str,
    skill_id: &Value,
    raw_target: Option<&Value>,
    payload: Option<&Value>,
) -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let target = normalize_target(raw_target);
    let refuse = |message: String| json!({ "ok": false, "message": message, "installed": list_locked(data_dir) });
    let built_in = market_skill(skill_id);
    let skill = built_in.clone().or_else(|| payload.filter(|p| p.get("id") == Some(skill_id)).cloned());
    let Some(skill) = skill else { return Ok(refuse("Unknown skill.".into())) };
    static NAME: OnceLock<Regex> = OnceLock::new();
    let name = show(skill.get("name"));
    if re(&NAME, r"^[a-z0-9._-]+$", "i").find(&name).is_none() {
        return Ok(refuse("Invalid skill name.".into()));
    }
    let mut records = load(data_dir);
    if records.iter().any(|r| r.get("skillId") == Some(skill_id) && r.get("target") == Some(&json!(target))) {
        return Ok(json!({ "ok": true, "message": "Already installed.", "installed": list_locked(data_dir) }));
    }
    let mut written: Option<String> = None;
    if let Some(base) = target_dir(home, target) {
        let dir = path::join(&[&base, &name]);
        // Never clobber a skill folder we did not create (no record for it).
        if nodefs::exists(&dir) {
            return Ok(refuse(format!("A skill named \"{name}\" already exists there.")));
        }
        nodefs::mkdir_p(&dir)?;
        nodefs::write_utf8(&path::join(&[&dir, "SKILL.md"]), &skill_to_markdown(&skill))?;
        written = Some(dir);
    }
    let mut record = Map::new();
    record.insert("skillId".into(), skill_id.clone());
    record.insert("target".into(), json!(target));
    if let Some(p) = written {
        record.insert("path".into(), json!(p));
    }
    record.insert("installedAt".into(), json!(now_ms()));
    // A snapshot keeps a skill from outside the catalog (Vaizer) runnable.
    if built_in.is_none() {
        record.insert("skill".into(), skill);
    }
    records.push(Value::Object(record));
    save(data_dir, &records)?;
    Ok(json!({ "ok": true, "installed": list_locked(data_dir) }))
}

/// `uninstallSkill(skillId, target)`: the folder a file-based install wrote
/// is removed (a failure keeps the folder but still drops the record).
pub fn uninstall(data_dir: &Path, skill_id: &Value, target: Option<&Value>) -> Result<Vec<Value>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let records = load(data_dir);
    let matches = |r: &Value| r.get("skillId") == Some(skill_id) && r.get("target") == target;
    if let Some(p) = records.iter().find(|r| matches(r)).and_then(path_of)
        && nodefs::exists(&p)
    {
        let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
    }
    let kept: Vec<Value> = records.into_iter().filter(|r| !matches(r)).collect();
    save(data_dir, &kept)?;
    Ok(list_locked(data_dir))
}

/// The names Nekko Agent's own skills take (built-in, then installed to
/// Nekko Agent), which win over an external skill of the same name.
pub fn reserved_names(data_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        data()["builtinNames"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    for r in list_installed(data_dir) {
        if normalize_target(r.get("target")) != "nekko-agent" {
            continue;
        }
        let skill = r
            .get("skill")
            .filter(|s| js::truthy(Some(s)))
            .cloned()
            .or_else(|| market_skill(r.get("skillId").unwrap_or(&Value::Null)));
        if let Some(s) = skill {
            names.push(show(s.get("name")));
        }
    }
    names
}

/// `parseSkillMarkdown(raw)`: `{ name?, description?, body }`.
pub fn parse_skill_markdown(raw: &str) -> (Option<String>, Option<String>, String) {
    static FM: OnceLock<Regex> = OnceLock::new();
    static KV: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static CONT: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(raw).replace("\r\n", "\n");
    let Some(fm) = re(&FM, r"^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)", "").find(&text) else {
        return (None, None, js::trim(&text).to_string());
    };
    let front = fm.group(1).map(|r| &text[r]).unwrap_or_default();
    let lines: Vec<&str> = front.split('\n').collect();
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(kv) = re(&KV, r"^([A-Za-z0-9_-]+):[ \t]*(.*)$", "").find(line) {
            let key = kv.group(1).map(|r| line[r].to_lowercase()).unwrap_or_default();
            let mut value = kv.group(2).map(|r| js::trim(&line[r]).to_string()).unwrap_or_default();
            if re(&BLOCK, r"^[>|][+-]?$", "").find(&value).is_some() {
                let mut block: Vec<String> = Vec::new();
                while i + 1 < lines.len()
                    && (re(&CONT, r"^\s+\S", "").find(lines[i + 1]).is_some() || js::trim(lines[i + 1]).is_empty())
                {
                    i += 1;
                    block.push(js::trim(lines[i]).to_string());
                }
                let joined = block.join(if value.starts_with('>') { " " } else { "\n" });
                let mut collapsed = String::new();
                let mut spaces = 0;
                for c in joined.chars() {
                    if c == ' ' {
                        spaces += 1;
                        continue;
                    }
                    if spaces > 0 {
                        collapsed.push(' ');
                        spaces = 0;
                    }
                    collapsed.push(c);
                }
                if spaces > 0 {
                    collapsed.push(' ');
                }
                value = js::trim(&collapsed).to_string();
            } else if re(&QUOTED, r#"^(['"]).*\1$"#, "").find(&value).is_some() {
                let units: Vec<u16> = value.encode_utf16().collect();
                value = String::from_utf16_lossy(&units[1..units.len() - 1]);
            }
            fields.retain(|(k, _)| *k != key);
            fields.push((key, value));
        }
        i += 1;
    }
    let get = |k: &str| fields.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    let body = js::trim(&text[fm.end()..]).to_string();
    (get("name"), get("description"), body)
}

const TOOL_DIRS: &[(&str, &str, &str)] = &[
    ("claude", ".claude", "skills"),
    ("codex", ".codex", "skills"),
    ("gemini", ".gemini", "skills"),
    ("agents", ".agents", "skills"),
];

/// A SKILL.md larger than this is skipped rather than pasted into a prompt.
pub const MAX_SKILL_BYTES: u64 = 256 * 1024;

/// JavaScript's default `sort()`: by UTF-16 code units.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn skill_dirs(base: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir() || t.is_symlink()))
        .map(|e| path::join(&[base, &e.file_name().to_string_lossy()]))
        .filter(|d| nodefs::exists(&path::join(&[d, "SKILL.md"])))
        .collect();
    out.sort_by(|a, b| utf16_cmp(a, b));
    out
}

/// `hasOwnFiles(dir)`: anything beside SKILL.md, dotfiles aside.
fn has_own_files(dir: &str) -> bool {
    std::fs::read_dir(dir).is_ok_and(|rd| {
        rd.filter_map(|e| e.ok()).any(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n != "SKILL.md" && !n.starts_with('.')
        })
    })
}

fn first_line(body: &str) -> String {
    let line = body.split('\n').find(|l| !js::trim(l).is_empty() && !js::trim(l).starts_with('#')).unwrap_or("");
    js::slice16(js::trim(line), 160).to_string()
}

fn skill_template(name: &str, dir: Option<&str>, body: &str) -> String {
    let intro = match dir {
        Some(d) => format!(
            "Use the \"{name}\" skill below. Its own files (scripts, references) are in {d}. That folder belongs to the skill, not to the user's project: do the work in the project as usual, and only read from that folder when the instructions point at one of its files."
        ),
        None => format!("Use the \"{name}\" skill below."),
    };
    format!("{intro}\n\n{body}")
}

fn read_skill(dir: &str, tool: &str, scope: &str) -> Option<Value> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    let file = path::join(&[dir, "SKILL.md"]);
    if std::fs::metadata(&file).ok()?.len() > MAX_SKILL_BYTES {
        return None;
    }
    let (name, description, body) = parse_skill_markdown(&nodefs::read_utf8(&file).ok()?);
    let name = name.unwrap_or_else(|| path::basename(dir));
    if re(&NAME, r"^[a-z0-9._-]+$", "i").find(&name).is_none() || body.is_empty() {
        return None;
    }
    let own = has_own_files(dir).then_some(dir);
    Some(json!({
        "id": format!("external:{tool}:{scope}:{name}"),
        "name": name,
        "description": description.unwrap_or_else(|| first_line(&body)),
        "template": skill_template(&name, own, &body),
        "category": "Imported",
        "origin": { "tool": tool, "scope": scope, "dir": dir },
        "workflow": {
            "nodes": [
                { "id": "t", "kind": "trigger", "label": format!("/{name}"), "detail": "Skill invoked" },
                { "id": "agent", "kind": "agent", "label": "Follow SKILL.md", "detail": "Instructions from the skill file" },
                { "id": "out", "kind": "output", "label": "Deliverable" },
            ],
            "edges": [{ "from": "t", "to": "agent" }, { "from": "agent", "to": "out" }],
        },
    }))
}

/// `discoverExternalSkills({ home, projectRoots, exclude, reserved })`:
/// project-level skills first, each name at most once.
pub fn discover_external(home: &str, project_roots: &[String], exclude: &[String], reserved: &[String]) -> Vec<Value> {
    let exclude: Vec<String> = exclude.iter().map(|p| path::resolve(&[p])).collect();
    let mut taken: Vec<String> = reserved.iter().map(|n| n.to_lowercase()).collect();
    let mut seen_bases: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut bases: Vec<(&str, &str, String)> = Vec::new();
    for root in project_roots {
        for (tool, a, b) in TOOL_DIRS {
            bases.push((tool, "project", path::join(&[root, a, b])));
        }
    }
    for (tool, a, b) in TOOL_DIRS {
        bases.push((tool, "user", path::join(&[home, a, b])));
    }
    for (tool, scope, base) in bases {
        let key = path::resolve(&[&base]);
        if seen_bases.contains(&key) {
            continue;
        }
        seen_bases.push(key);
        for dir in skill_dirs(&base) {
            if exclude.contains(&path::resolve(&[&dir])) {
                continue;
            }
            let Some(skill) = read_skill(&dir, tool, scope) else { continue };
            let lower = show(skill.get("name")).to_lowercase();
            if taken.contains(&lower) {
                continue;
            }
            taken.push(lower);
            out.push(skill);
        }
    }
    out
}

/// The Vaizer marketplace: offline-first catalog and SKILL.md fetches.
pub struct Vaizer {
    http: reqwest::Client,
    catalog_url: String,
    raw_base: String,
}

impl Default for Vaizer {
    fn default() -> Self {
        let d = data();
        Self::new(
            d["vaizerCatalogUrl"].as_str().unwrap_or_default(),
            &format!("https://raw.githubusercontent.com/{}/main", d["vaizerRepo"].as_str().unwrap_or_default()),
        )
    }
}

/// `validSkill(s)`.
fn valid_skill(s: &Value) -> bool {
    static SLUG: OnceLock<Regex> = OnceLock::new();
    s.get("id").is_some_and(Value::is_string)
        && s.get("slug").and_then(Value::as_str).is_some_and(|slug| re(&SLUG, r"^[a-z0-9-]+$", "").find(slug).is_some())
        && s.get("description").is_some_and(Value::is_string)
        && matches!(s.get("tier").and_then(Value::as_str), Some("nekko-official" | "community"))
}

fn valid_slug(slug: &str) -> bool {
    static SLUG: OnceLock<Regex> = OnceLock::new();
    re(&SLUG, r"^[a-z0-9-]+$", "").find(slug).is_some()
}

impl Vaizer {
    /// `FETCH_TIMEOUT_MS`.
    const TIMEOUT: Duration = Duration::from_secs(6);

    pub fn new(catalog_url: &str, raw_base: &str) -> Self {
        Self {
            http: reqwest::Client::builder().timeout(Self::TIMEOUT).build().unwrap_or_default(),
            catalog_url: catalog_url.into(),
            raw_base: raw_base.trim_end_matches('/').into(),
        }
    }

    fn cache_file(data_dir: &Path) -> Result<std::path::PathBuf, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        Ok(data_dir.join("vaizer.json"))
    }

    /// `readCache()`: the last live fetch, marked `cached`.
    fn read_cache(data_dir: &Path) -> Option<Value> {
        let text = std::fs::read(Self::cache_file(data_dir).ok()?).ok()?;
        let Value::Object(mut c) = js::js_order(serde_json::from_str(&String::from_utf8_lossy(&text)).ok()?) else {
            return None;
        };
        if !c.get("skills").is_some_and(Value::is_array) {
            return None;
        }
        c.insert("source".into(), json!("cached"));
        Some(Value::Object(c))
    }

    fn snapshot() -> Value {
        data()["vaizerSnapshot"].clone()
    }

    /// `getVaizerCatalog(refresh)`: no network without `refresh`.
    pub async fn catalog(&self, data_dir: &Path, refresh: bool) -> Value {
        let fallback = || Self::read_cache(data_dir).unwrap_or_else(Self::snapshot);
        if !refresh {
            return fallback();
        }
        let Ok(res) = self.http.get(&self.catalog_url).send().await else { return fallback() };
        if !res.status().is_success() {
            return fallback();
        }
        let Ok(raw) = res.json::<Value>().await else { return fallback() };
        let skills: Vec<Value> = match raw.get("skills") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.iter().filter(|s| valid_skill(s)).cloned().collect(),
            // `.filter` on anything else throws, which falls back.
            Some(_) => return fallback(),
        };
        if skills.is_empty() {
            return fallback();
        }
        let mut catalog = Map::new();
        catalog.insert(
            "marketplace".into(),
            js::coalesce(raw.get("marketplace"), Some(&json!("vaizer"))).cloned().unwrap_or(json!("vaizer")),
        );
        if let Some(a) = raw.get("addCommand") {
            catalog.insert("addCommand".into(), a.clone());
        }
        catalog.insert("skills".into(), Value::Array(skills));
        catalog.insert("source".into(), json!("live"));
        catalog.insert("fetchedAt".into(), json!(now_ms()));
        let catalog = Value::Object(catalog);
        match Self::cache_file(data_dir) {
            Ok(f) => {
                if crate::write_atomic(&f, js::stringify_pretty(&catalog, "  ").as_bytes()).is_err() {
                    return fallback();
                }
            }
            Err(_) => return fallback(),
        }
        catalog
    }

    /// `getVaizerSkillMd(slug)`: the current plugin path, then the legacy one.
    pub async fn skill_md(&self, slug: &str) -> Value {
        if !valid_slug(slug) {
            return Value::Null;
        }
        let urls = [
            format!("{}/plugins/vaizer/skills/{slug}/SKILL.md", self.raw_base),
            format!("{}/plugins/{slug}/skills/{slug}/SKILL.md", self.raw_base),
        ];
        for url in urls {
            let Ok(res) = self.http.get(&url).send().await else { continue };
            if !res.status().is_success() {
                continue;
            }
            let Ok(bytes) = res.bytes().await else { continue };
            let text = js::decode_text(&bytes);
            if !js::trim(&text).is_empty() {
                return json!(text);
            }
        }
        Value::Null
    }
}

/// `marketSkillInstructions(m)`: a Vaizer skill's SKILL.md body, else the
/// catalog `instructions`; empty when the template already says it all.
pub fn market_skill_instructions(m: &Value) -> String {
    let from_markdown = m
        .get("markdown")
        .filter(|v| js::truthy(Some(v)))
        .and_then(Value::as_str)
        .map(|md| parse_skill_markdown(md).2)
        .unwrap_or_default();
    let raw = if from_markdown.is_empty() {
        m.get("instructions").map(js::display).filter(|_| !js::nullish(m.get("instructions"))).unwrap_or_default()
    } else {
        from_markdown
    };
    let body = js::trim(&raw).to_string();
    let template = m.get("template").map(js::display).unwrap_or_default();
    if body.is_empty() || template.contains(&body) {
        return String::new();
    }
    body
}

/// `marketSkillPrompt(m)`: the template, with the skill's own instructions before it when it has any.
pub fn market_skill_prompt(m: &Value) -> String {
    let body = market_skill_instructions(m);
    let template = m.get("template").map(js::display).unwrap_or_default();
    if body.is_empty() {
        return template;
    }
    [
        format!("Use the \"{}\" skill. Its instructions:", show(m.get("name"))),
        String::new(),
        body,
        String::new(),
        "Task:".into(),
        template,
    ]
    .join("\n")
}

/// `marketWorkflow(skill)`: its own workflow, else the generic trigger, context, agent, tools, output chain.
pub fn market_workflow(m: &Value) -> Value {
    if let Some(w) = m.get("workflow").filter(|v| js::truthy(Some(v))) {
        return w.clone();
    }
    let tools: Vec<String> =
        m.get("tools").and_then(Value::as_array).map(|t| t.iter().map(js::display).collect()).unwrap_or_default();
    let description = m.get("description").map(js::display).unwrap_or_default();
    let mut nodes = vec![
        json!({ "id": "t", "kind": "trigger", "label": format!("/{}", show(m.get("name"))), "detail": "Skill invoked" }),
        json!({ "id": "ctx", "kind": "context", "label": "Gather context", "detail": "Files, diff, inputs" }),
        json!({ "id": "agent", "kind": "agent", "label": "Run instructions", "detail": js::slice16(&description, 48) }),
    ];
    if !tools.is_empty() {
        nodes.push(json!({ "id": "tools", "kind": "tool", "label": "Use tools", "detail": tools.iter().take(3).cloned().collect::<Vec<_>>().join(", ") }));
    }
    nodes.push(json!({ "id": "out", "kind": "output", "label": "Deliverable" }));
    let ids: Vec<&str> = nodes.iter().map(|n| n["id"].as_str().unwrap_or_default()).collect();
    let edges: Vec<Value> = ids.windows(2).map(|w| json!({ "from": w[0], "to": w[1] })).collect();
    json!({ "nodes": nodes, "edges": edges })
}

/// `marketToSkillDef(m)`: a marketplace skill as a runnable skill.
pub fn skill_def(m: &Value) -> Value {
    let mut out = Map::new();
    for k in ["id", "name", "description"] {
        if let Some(v) = m.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    out.insert("template".into(), json!(market_skill_prompt(m)));
    for k in ["category", "tools"] {
        if let Some(v) = m.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    out.insert("workflow".into(), market_workflow(m));
    Value::Object(out)
}

/// `listInstalledSkillDefs()`: Nekko Agent-target installs as runnable skills
/// (a Vaizer install carries its own snapshot; a catalog one resolves by id).
pub fn installed_skill_defs(data_dir: &Path) -> Vec<Value> {
    list_installed(data_dir)
        .iter()
        .filter(|r| normalize_target(r.get("target")) == "nekko-agent")
        .filter_map(|r| match r.get("skill").filter(|v| !js::nullish(Some(v))) {
            Some(s) => js::truthy(Some(s)).then(|| s.clone()),
            None => r.get("skillId").and_then(market_skill),
        })
        .map(|m| skill_def(&m))
        .collect()
}

/// The host's `externalSkills()`: other tools' SKILL.md folders under the
/// home and the given folders, minus Nekko's own exports and taken names.
pub fn external_skills(data_dir: &Path, home: &str, project_roots: &[String]) -> Vec<Value> {
    let exclude: Vec<String> = list_installed(data_dir)
        .iter()
        .filter_map(|r| r.get("path").filter(|p| js::truthy(Some(p))).map(js::display))
        .collect();
    discover_external(home, project_roots, &exclude, &reserved_names(data_dir))
}

/// The raw value of one frontmatter key (`allowed-tools`, `argument-hint`):
/// a scalar, a flow list (`[a, b]`) or a block list (`- a` lines), as text
/// with list items joined by `, `.
pub fn frontmatter_value(raw: &str, key: &str) -> Option<String> {
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(raw).replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let lines: Vec<&str> = rest[..end].split('\n').collect();
    let want = key.to_lowercase();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.trim().to_lowercase() != want || line.starts_with([' ', '\t']) {
            continue;
        }
        let v = v.trim();
        if !v.is_empty() {
            let v = v.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(v);
            let unq = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            return Some(unq(v));
        }
        let mut items = Vec::new();
        while i < lines.len() {
            let Some(item) = lines[i].trim_start().strip_prefix("- ") else { break };
            items.push(item.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
            i += 1;
        }
        return (!items.is_empty()).then(|| items.join(", "));
    }
    None
}

/// Claude Code's `allowed-tools` value as entries: split on commas and
/// whitespace outside parentheses, so `Bash(git add:*) Read` is two.
pub fn split_allowed_tools(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    for c in value.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        if depth <= 0 && (c == ',' || c.is_whitespace()) {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
            depth = 0;
            continue;
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// A file's text when it sits inside `root` once links are followed, is a
/// regular file and is no larger than [`MAX_SKILL_BYTES`].
fn read_contained(file: &Path, root: &Path) -> Option<String> {
    let real = std::fs::canonicalize(file).ok()?;
    if !real.starts_with(root) {
        return None;
    }
    let meta = std::fs::metadata(&real).ok()?;
    if !meta.is_file() || meta.len() > MAX_SKILL_BYTES {
        return None;
    }
    std::fs::read_to_string(&real).ok()
}

/// Folder entries, by name, that are directories inside `root` once links
/// are followed (a link pointing out of the plugin is dropped).
fn contained_dirs(dir: &Path, root: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(String, std::path::PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let real = std::fs::canonicalize(e.path()).ok()?;
            (real.starts_with(root) && real.is_dir()).then(|| (e.file_name().to_string_lossy().into_owned(), real))
        })
        .collect();
    out.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
    out
}

/// `1.10.0` above `1.9.2`: numeric parts compared as numbers, anything else as text.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| -> Vec<String> { s.split(['.', '-', '+']).map(str::to_string).collect() };
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).map(String::as_str).unwrap_or("0"), pb.get(i).map(String::as_str).unwrap_or("0"));
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            _ => x.cmp(y),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    std::cmp::Ordering::Equal
}

fn valid_name(name: &str) -> bool {
    static NAME: OnceLock<Regex> = OnceLock::new();
    re(&NAME, r"^[a-z0-9._-]+$", "i").find(name).is_some()
}

/// The plugins `~/.claude/settings.json` turns on: `(plugin, marketplace)`.
fn enabled_plugins(home: &str) -> Vec<(String, String)> {
    let file = path::join(&[home, ".claude", "settings.json"]);
    let Some(settings) = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Vec::new();
    };
    let Some(map) = settings.get("enabledPlugins").and_then(Value::as_object) else { return Vec::new() };
    let mut out: Vec<(String, String)> = map
        .iter()
        .filter(|(_, on)| on.as_bool() == Some(true))
        .filter_map(|(k, _)| {
            let (plugin, market) = k.split_once('@')?;
            (valid_name(plugin) && valid_name(market)).then(|| (plugin.to_string(), market.to_string()))
        })
        .collect();
    out.sort();
    out
}

/// One plugin skill or command as a runnable skill, `<plugin>:<name>`.
#[allow(clippy::too_many_arguments)]
fn plugin_def(
    plugin: &str,
    market: &str,
    version: &str,
    root: &Path,
    kind: &str,
    name: &str,
    raw: &str,
    dir: &Path,
) -> Option<Value> {
    let (fm_name, description, body) = parse_skill_markdown(raw);
    if body.is_empty() {
        return None;
    }
    // A skill names itself; a command is its file name.
    let name = match (kind, fm_name) {
        ("skill", Some(n)) if valid_name(&n) => n,
        _ => name.to_string(),
    };
    if !valid_name(&name) {
        return None;
    }
    let id = format!("{plugin}:{name}");
    let root_s = root.to_string_lossy().into_owned();
    let template =
        if kind == "skill" { skill_template(&id, Some(&dir.to_string_lossy()), &body) } else { body.clone() };
    let allowed: Vec<String> =
        frontmatter_value(raw, "allowed-tools").map(|v| split_allowed_tools(&v)).unwrap_or_default();
    let mut def = json!({
        "id": id,
        "name": id,
        "description": description.unwrap_or_else(|| first_line(&body)),
        "template": template,
        "category": "Imported",
        "source": "plugin",
        "origin": {
            "tool": "claude-plugin",
            "scope": "user",
            "dir": dir.to_string_lossy(),
            "plugin": plugin,
            "marketplace": market,
            "version": version,
            "kind": kind,
        },
        "pluginRoot": root_s,
        "allowedTools": allowed,
        "workflow": {
            "nodes": [
                { "id": "t", "kind": "trigger", "label": format!("/{id}"), "detail": "Skill invoked" },
                { "id": "agent", "kind": "agent", "label": if kind == "skill" { "Follow SKILL.md" } else { "Run the command" }, "detail": format!("From the {plugin} plugin") },
                { "id": "out", "kind": "output", "label": "Deliverable" },
            ],
            "edges": [{ "from": "t", "to": "agent" }, { "from": "agent", "to": "out" }],
        },
    });
    if let Some(hint) = frontmatter_value(raw, "argument-hint").filter(|h| !h.is_empty()) {
        def["argumentHint"] = json!(hint);
    }
    Some(def)
}

/// Claude Code plugin skills and commands: for each plugin enabled in
/// `~/.claude/settings.json`, its installed version with the highest
/// `.claude-plugin/plugin.json` version under
/// `~/.claude/plugins/cache/<marketplace>/<plugin>/`, then `skills/*/SKILL.md`
/// and `commands/*.md` as `<plugin>:<name>` (a skill wins over a command of
/// the same name). Read only; links out of the plugin folder are not followed.
pub fn plugin_skills(home: &str) -> Vec<Value> {
    let cache = Path::new(home).join(".claude").join("plugins").join("cache");
    let mut out = Vec::new();
    for (plugin, market) in enabled_plugins(home) {
        let Ok(folder) = std::fs::canonicalize(cache.join(&market).join(&plugin)) else { continue };
        let mut versions: Vec<(String, std::path::PathBuf)> = contained_dirs(&folder, &folder)
            .into_iter()
            .filter(|(n, _)| !n.starts_with('.'))
            .map(|(n, dir)| {
                let manifest = read_contained(&dir.join(".claude-plugin").join("plugin.json"), &dir)
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok());
                let v =
                    manifest.as_ref().and_then(|m| m.get("version")).and_then(Value::as_str).unwrap_or(&n).to_string();
                (v, dir)
            })
            .collect();
        versions.sort_by(|a, b| version_cmp(&a.0, &b.0).then_with(|| a.1.cmp(&b.1)));
        let Some((version, root)) = versions.pop() else { continue };
        let mut names: Vec<String> = Vec::new();
        let mut push = |def: Option<Value>| {
            if let Some(d) = def {
                let id = d["id"].as_str().unwrap_or_default().to_lowercase();
                if !names.contains(&id) {
                    names.push(id);
                    out.push(d);
                }
            }
        };
        for (dir_name, dir) in contained_dirs(&root.join("skills"), &root) {
            let Some(raw) = read_contained(&dir.join("SKILL.md"), &root) else { continue };
            push(plugin_def(&plugin, &market, &version, &root, "skill", &dir_name, &raw, &dir));
        }
        let commands = root.join("commands");
        let mut files: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(&commands)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.strip_suffix(".md").map(|stem| (stem.to_string(), e.path()))
            })
            .collect();
        files.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
        for (stem, file) in files {
            let Some(raw) = read_contained(&file, &root) else { continue };
            push(plugin_def(&plugin, &market, &version, &root, "command", &stem, &raw, &root));
        }
    }
    out
}

/// Every skill a workflow's skill step can run, in precedence order (the
/// first of a name wins): built-in, Nekko installs, other tools' `SKILL.md`
/// folders, then Claude Code plugin skills and commands. Each carries its
/// `source` (`builtin`, `installed`, `external`, `plugin`); an external or
/// plugin skill also its `allowedTools` from `allowed-tools`, and a plugin's
/// its `pluginRoot`.
pub fn resolve_skill_defs(data_dir: &Path, home: &str, project_roots: &[String]) -> Vec<Value> {
    let builtin: Vec<Value> = data()["builtin"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s.get("kind").and_then(Value::as_str) != Some("goal"))
        .cloned()
        .collect();
    let external: Vec<Value> = external_skills(data_dir, home, project_roots)
        .into_iter()
        .map(|mut s| {
            let file = s.pointer("/origin/dir").and_then(Value::as_str).map(|d| path::join(&[d, "SKILL.md"]));
            let allowed = file
                .and_then(|f| nodefs::read_utf8(&f).ok())
                .and_then(|raw| frontmatter_value(&raw, "allowed-tools"))
                .map(|v| split_allowed_tools(&v))
                .unwrap_or_default();
            s["allowedTools"] = json!(allowed);
            s
        })
        .collect();
    let lists = [
        (builtin, "builtin"),
        (installed_skill_defs(data_dir), "installed"),
        (external, "external"),
        (plugin_skills(home), "plugin"),
    ];
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (list, source) in lists {
        for mut s in list {
            if !seen.insert(show(s.get("name")).to_lowercase()) {
                continue;
            }
            s["source"] = json!(source);
            out.push(s);
        }
    }
    out
}

/// `runnableSkills(SKILLS, listInstalledSkillDefs(), externalSkills())`: every
/// skill a chat can run, built-ins first, then installs, then other tools'
/// (the first of a name wins); goals are not runnable this way.
pub fn runnable_skills(data_dir: &Path, home: &str, project_roots: &[String]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let builtin = data()["builtin"].as_array().cloned().unwrap_or_default();
    // Each list with its source; an external skill's is the tool it came from.
    let lists = [
        (builtin, Some("builtin")),
        (installed_skill_defs(data_dir), Some("marketplace")),
        (external_skills(data_dir, home, project_roots), None),
    ];
    for (list, source) in lists {
        for s in list {
            let name = show(s.get("name"));
            if s.get("kind").and_then(Value::as_str) == Some("goal") || !seen.insert(name) {
                continue;
            }
            let source = match source {
                Some(src) => json!(src),
                None => s
                    .get("origin")
                    .and_then(|o| o.get("tool"))
                    .filter(|t| !js::nullish(Some(t)))
                    .cloned()
                    .unwrap_or(json!("agents")),
            };
            // Keys in the TS literal's order; an undefined field is left out.
            let mut o = Map::new();
            for (k, v) in [
                ("name", s.get("name").cloned()),
                ("description", s.get("description").cloned()),
                ("category", s.get("category").cloned()),
                ("source", Some(source)),
                ("template", s.get("template").cloned()),
            ] {
                if let Some(v) = v {
                    o.insert(k.into(), v);
                }
            }
            out.push(Value::Object(o));
        }
    }
    out
}
