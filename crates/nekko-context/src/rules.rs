//! Project rules beyond the root guideline files: the rule folders other
//! agent tools read (`.agents/rules`, `.claude/rules`, `.cursor/rules`,
//! `.kiro/steering`, `.windsurf/rules`, `.github/instructions`,
//! `.github/copilot-instructions.md`)
//! and `AGENTS.md` / `CLAUDE.md` files in subfolders.
//!
//! Each rule has an activation, read from its frontmatter the way its own
//! tool reads it:
//!
//! - *always*: its text goes into every turn, like a root `AGENTS.md`;
//! - *paths*: it applies to files matching its globs. Its text goes in when an
//!   attached file matches; otherwise it is listed in the rules index;
//! - *on demand*: it has a description and no globs. It is listed in the
//!   index, and the model reads the file when the description fits the task;
//! - *manual*: only when the user attaches it. Never listed.
//!
//! The index is one short item per folder, so a repository with many scoped
//! rules costs a few lines per turn instead of every rule's full text. The
//! listed files are inside the workspace, where `read_file` can reach them.
//!
//! `guidance` picks how much of this a chat gets (`Session.guidance`):
//! `rules` (the default) is everything above, `root` is the root guideline
//! files alone (the behavior before rules), `off` is no project guidance.

use crate::gather::{collect_guidelines, read_limited};
use crate::nodepath;
use nekko_js as js;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Folders the subfolder walk never enters.
const SKIP_DIRS: [&str; 10] =
    ["node_modules", ".git", "target", "dist", "build", "vendor", ".worktrees", "out", "coverage", "__pycache__"];
/// How deep the walk for subfolder `AGENTS.md` files goes, and how many folders it visits.
const WALK_DEPTH: usize = 4;
const WALK_DIRS: usize = 2_000;
/// Rules read per workspace folder, and lines in one index.
const MAX_RULES: usize = 100;
const MAX_INDEX: usize = 60;

#[derive(Clone, Debug, PartialEq)]
pub enum Activation {
    Always,
    /// Globs relative to the workspace folder.
    Paths(Vec<String>),
    OnDemand,
    Manual,
}

#[derive(Clone, Debug)]
pub struct Rule {
    /// The file, as `path.join` builds it.
    pub path: String,
    /// The file relative to its workspace folder, with `/`.
    pub rel: String,
    /// The workspace folder it was found in.
    pub root: String,
    pub description: String,
    pub activation: Activation,
    /// The text after the frontmatter.
    pub body: String,
}

/// How much project guidance a chat takes (`Session.guidance`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Guidance {
    Rules,
    Root,
    Off,
}

impl Guidance {
    /// Unset and unknown values are the default, `rules`.
    pub fn from_value(v: Option<&serde_json::Value>) -> Self {
        match v.and_then(|v| v.as_str()) {
            Some("root") => Self::Root,
            Some("off") => Self::Off,
            _ => Self::Rules,
        }
    }
}

/// The parsed frontmatter: `key: value` lines, inline `[a, b]` lists and
/// block `- a` lists. Enough for the rule formats, not general YAML.
struct Front {
    pairs: Vec<(String, Vec<String>)>,
}

impl Front {
    fn get(&self, key: &str) -> Option<&[String]> {
        self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_slice())
    }

    fn first(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| v.first()).map(String::as_str).filter(|s| !s.is_empty())
    }

    fn flag(&self, key: &str) -> Option<bool> {
        match self.first(key)? {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }
    }

    /// Globs from any of the fields the formats use, split on commas.
    fn globs(&self) -> Vec<String> {
        let mut out = Vec::new();
        for key in ["paths", "globs", "applyTo", "fileMatchPattern"] {
            for v in self.get(key).unwrap_or_default() {
                out.extend(v.split(',').map(|g| unquote(g.trim()).to_string()).filter(|g| !g.is_empty()));
            }
        }
        out
    }
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    for q in ['"', '\''] {
        if let Some(inner) = s.strip_prefix(q).and_then(|r| r.strip_suffix(q)) {
            return inner;
        }
    }
    s
}

/// Split `---` frontmatter from the body. A file without one is all body.
fn split_front(text: &str) -> (Front, String) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut pairs: Vec<(String, Vec<String>)> = Vec::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (Front { pairs }, text.to_string());
    }
    let mut consumed = text.find('\n').map_or(text.len(), |i| i + 1);
    let mut closed = false;
    for line in lines {
        consumed += line.len() + 1;
        let t = line.trim_end();
        if t == "---" {
            closed = true;
            break;
        }
        if let Some(item) = t.trim_start().strip_prefix("- ") {
            if let Some((_, vals)) = pairs.last_mut() {
                vals.push(unquote(item).to_string());
            }
            continue;
        }
        let Some((k, v)) = t.split_once(':') else { continue };
        let v = v.trim();
        let vals = if let Some(inner) = v.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
            inner.split(',').map(|s| unquote(s).to_string()).filter(|s| !s.is_empty()).collect()
        } else if v.is_empty() {
            Vec::new()
        } else {
            vec![unquote(v).to_string()]
        };
        pairs.push((k.trim().to_string(), vals));
    }
    if !closed {
        return (Front { pairs: Vec::new() }, text.to_string());
    }
    let body = text.get(consumed.min(text.len())..).unwrap_or("");
    (Front { pairs }, body.trim_start_matches(['\r', '\n']).to_string())
}

/// What a file's own tool would do with it when its frontmatter says nothing.
#[derive(Clone, Copy, PartialEq)]
enum Default_ {
    /// Claude Code rules, Kiro steering, `.agents/rules`: always on.
    Always,
    /// Cursor rules and Copilot instruction files: only when asked for.
    Manual,
}

fn activation(front: &Front, fallback: Default_) -> Activation {
    // Windsurf's `trigger`: always_on, manual, model_decision, glob.
    let trigger = front.first("trigger");
    if front.flag("alwaysApply") == Some(true)
        || front.first("inclusion") == Some("always")
        || trigger == Some("always_on")
    {
        return Activation::Always;
    }
    if front.first("inclusion") == Some("manual") || trigger == Some("manual") {
        return Activation::Manual;
    }
    let globs = front.globs();
    if !globs.is_empty() {
        // `applyTo: "**"` is Copilot's way of saying always.
        if globs.iter().all(|g| g == "**" || g == "**/*") {
            return Activation::Always;
        }
        return Activation::Paths(globs);
    }
    let described = front.first("description").is_some();
    let asks = front.flag("alwaysApply") == Some(false)
        || front.first("inclusion") == Some("auto")
        || trigger == Some("model_decision");
    if described && asks {
        return Activation::OnDemand;
    }
    match fallback {
        Default_::Always => Activation::Always,
        Default_::Manual if described => Activation::OnDemand,
        Default_::Manual => Activation::Manual,
    }
}

/// `rel` with `/` whatever the platform.
fn rel_of(root: &str, full: &str) -> String {
    let r = full.strip_prefix(root).unwrap_or(full);
    r.trim_start_matches(['/', '\\']).replace('\\', "/")
}

/// Whether `path` is `root` or below it (not merely a longer name: `/a/bc` is not in `/a/b`).
fn inside(root: &str, path: &str) -> bool {
    path.strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']) || root.ends_with(['/', '\\']))
}

/// Files under `dir` (recursively, sorted) whose name passes `keep`.
fn files_under(dir: &str, keep: &dyn Fn(&str) -> bool, out: &mut Vec<String>, depth: usize) {
    if depth > WALK_DEPTH || out.len() >= MAX_RULES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<(String, bool)> = rd
        .filter_map(Result::ok)
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir())))
        .collect();
    entries.sort();
    for (name, is_dir) in entries {
        let p = nodepath::join(dir, &name);
        if is_dir {
            files_under(&p, keep, out, depth + 1);
        } else if keep(&name) {
            out.push(p);
        }
    }
}

/// How long a folder's subfolder walk is reused. The Context Inspector
/// previews the context as the user types, and a walk visits up to
/// `WALK_DIRS` folders; a guide added in the last few seconds can wait.
const WALK_TTL: Duration = Duration::from_secs(5);

/// Each folder's last walk: when it ran and what it found.
type WalkCache = HashMap<String, (Instant, Vec<String>)>;

/// `AGENTS.md` and `CLAUDE.md` in subfolders, not the root (the root files
/// are the guidelines), from the walk cache when it is fresh.
fn nested_guides(root: &str) -> Vec<String> {
    static CACHE: OnceLock<Mutex<WalkCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((at, found)) = cache.lock().ok().and_then(|c| c.get(root).cloned())
        && at.elapsed() < WALK_TTL
    {
        return found;
    }
    let found = walk_guides(root);
    if let Ok(mut c) = cache.lock() {
        c.retain(|_, (at, _)| at.elapsed() < WALK_TTL);
        c.insert(root.to_string(), (Instant::now(), found.clone()));
    }
    found
}

/// The walk behind `nested_guides`. Hidden folders and build output are skipped.
fn walk_guides(root: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut queue = vec![(root.to_string(), 0usize)];
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop() {
        visited += 1;
        if visited > WALK_DIRS || out.len() >= MAX_RULES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<(String, bool)> = rd
            .filter_map(Result::ok)
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir())))
            .collect();
        entries.sort();
        for (name, is_dir) in entries.into_iter().rev() {
            let p = nodepath::join(&dir, &name);
            if is_dir {
                if depth < WALK_DEPTH && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push((p, depth + 1));
                }
            } else if depth > 0 && (name == "AGENTS.md" || name == "CLAUDE.md") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// A rule folder, which file names in it are rules, and what a rule there does by default.
type Source<'a> = (&'a str, &'a dyn Fn(&str) -> bool, Default_);

/// Every rule in one workspace folder, in a stable order: the rule folders,
/// then the subfolder guides. A rule whose text repeats an earlier one (a
/// symlinked `.claude/rules`, a `CLAUDE.md` that is a copy) is dropped.
pub fn collect_rules(workspace_paths: &[String]) -> Vec<Rule> {
    let mut out: Vec<Rule> = Vec::new();
    let md = |n: &str| n.ends_with(".md");
    let cursor = |n: &str| n.ends_with(".mdc") || n.ends_with(".md");
    let copilot = |n: &str| n.ends_with(".instructions.md");
    let sources: [Source; 6] = [
        (".agents/rules", &md, Default_::Always),
        (".claude/rules", &md, Default_::Always),
        (".cursor/rules", &cursor, Default_::Manual),
        (".kiro/steering", &md, Default_::Always),
        (".windsurf/rules", &md, Default_::Manual),
        (".github/instructions", &copilot, Default_::Manual),
    ];
    for root in workspace_paths {
        let mut found: Vec<(String, Default_)> = Vec::new();
        for (dir, keep, fallback) in &sources {
            let mut files = Vec::new();
            files_under(&nodepath::join(root, dir), *keep, &mut files, 0);
            found.extend(files.into_iter().map(|f| (f, *fallback)));
        }
        let copilot_root = nodepath::join(root, ".github/copilot-instructions.md");
        if Path::new(&copilot_root).is_file() {
            found.push((copilot_root, Default_::Always));
        }
        let start = out.len();
        for (path, fallback) in found {
            let Some(text) = read_limited(&path) else { continue };
            let (front, body) = split_front(&text);
            let rule = Rule {
                rel: rel_of(root, &path),
                root: root.clone(),
                description: front.first("description").unwrap_or("").to_string(),
                activation: activation(&front, fallback),
                body,
                path,
            };
            push_unique(&mut out, rule);
        }
        for path in nested_guides(root) {
            let Some(body) = read_limited(&path) else { continue };
            let rel = rel_of(root, &path);
            let folder = rel.rsplit_once('/').map_or("", |(d, _)| d).to_string();
            let rule = Rule {
                description: String::new(),
                activation: Activation::Paths(vec![format!("{folder}/**")]),
                rel,
                root: root.clone(),
                body,
                path,
            };
            push_unique(&mut out, rule);
        }
        out.truncate(start + MAX_RULES.min(out.len() - start));
    }
    out
}

fn push_unique(out: &mut Vec<Rule>, rule: Rule) {
    let body = js::trim(&rule.body);
    if body.is_empty() || out.iter().any(|r| js::trim(&r.body) == body) {
        return;
    }
    out.push(rule);
}

/// Glob match over `/`-separated paths: `**` spans folders, `*` and `?` stay
/// inside one, `{a,b}` is either. A glob without a `/` matches the file name
/// in any folder, as Cursor and Copilot read `*.ts`.
pub fn glob_match(glob: &str, path: &str) -> bool {
    let glob = glob.trim_start_matches("./");
    if let Some(open) = glob.find('{')
        && let Some(len) = glob[open..].find('}')
    {
        let close = open + len;
        return glob[open + 1..close]
            .split(',')
            .any(|alt| glob_match(&format!("{}{alt}{}", &glob[..open], &glob[close + 1..]), path));
    }
    if !glob.contains('/') {
        let name = path.rsplit('/').next().unwrap_or(path);
        return seg_match(glob.as_bytes(), name.as_bytes())
            || parts_match(&[glob], &path.split('/').collect::<Vec<_>>());
    }
    let g: Vec<&str> = glob.split('/').filter(|s| !s.is_empty()).collect();
    let p: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    parts_match(&g, &p)
}

fn parts_match(g: &[&str], p: &[&str]) -> bool {
    match g.first() {
        None => p.is_empty(),
        Some(&"**") => (0..=p.len()).any(|i| parts_match(&g[1..], &p[i..])),
        Some(seg) => !p.is_empty() && seg_match(seg.as_bytes(), p[0].as_bytes()) && parts_match(&g[1..], &p[1..]),
    }
}

fn seg_match(g: &[u8], s: &[u8]) -> bool {
    match g.first() {
        None => s.is_empty(),
        Some(b'*') => (0..=s.len()).any(|i| seg_match(&g[1..], &s[i..])),
        Some(b'?') => !s.is_empty() && seg_match(&g[1..], &s[1..]),
        Some(c) => s.first() == Some(c) && seg_match(&g[1..], &s[1..]),
    }
}

/// What a chat's project guidance adds to its context.
#[derive(Debug, Default, PartialEq)]
pub struct ProjectGuidance {
    /// Files whose full text goes in: (path, content).
    pub guidelines: Vec<(String, String)>,
    /// One index per workspace folder with rules left out: (folder, text).
    pub indexes: Vec<(String, String)>,
}

/// The guideline files and rules a chat gets, for its folders and the
/// files attached to it (absolute paths), at its `guidance` level.
pub fn project_guidance(workspace_paths: &[String], attached: &[String], level: Guidance) -> ProjectGuidance {
    let mut out = ProjectGuidance::default();
    if level == Guidance::Off {
        return out;
    }
    out.guidelines = collect_guidelines(workspace_paths).into_iter().map(|g| (g.path, g.content)).collect();
    if level == Guidance::Root {
        return out;
    }
    let rules = collect_rules(workspace_paths);
    for root in workspace_paths {
        let attached_rel: Vec<String> =
            attached.iter().filter(|a| inside(root, a)).map(|a| rel_of(root, a)).filter(|r| !r.is_empty()).collect();
        let mut index = Vec::new();
        for rule in rules.iter().filter(|r| &r.root == root) {
            let taken = |out: &ProjectGuidance| out.guidelines.iter().any(|(_, c)| js::trim(c) == js::trim(&rule.body));
            match &rule.activation {
                Activation::Always => {
                    if !taken(&out) {
                        out.guidelines.push((rule.path.clone(), rule.body.clone()));
                    }
                }
                Activation::Paths(globs) => {
                    if attached_rel.iter().any(|a| globs.iter().any(|g| glob_match(g, a))) {
                        if !taken(&out) {
                            out.guidelines.push((rule.path.clone(), rule.body.clone()));
                        }
                    } else {
                        let what = if rule.description.is_empty() {
                            String::new()
                        } else {
                            format!(" ({})", rule.description)
                        };
                        index.push(format!("- {}: applies to {}{what}", rule.rel, globs.join(", ")));
                    }
                }
                Activation::OnDemand => index.push(format!("- {}: {}", rule.rel, rule.description)),
                Activation::Manual => {}
            }
        }
        if !index.is_empty() {
            let more = index.len().saturating_sub(MAX_INDEX);
            index.truncate(MAX_INDEX);
            if more > 0 {
                index.push(format!("- ...and {more} more under the same folders"));
            }
            let text = format!(
                "Project rules not loaded yet. Read a rule's file (paths are relative to {root}) before working on files it applies to, or when its description fits the task. Rules in a subfolder override the ones above them.\n\n{}",
                index.join("\n")
            );
            out.indexes.push((root.clone(), text));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[(&str, &str)]) -> String {
        // A counter, not the clock: Windows' clock is coarse enough that two
        // tests running in parallel got the same folder and each other's files.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("nekko-rules-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, text) in files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        root.to_string_lossy().into_owned()
    }

    #[test]
    fn globs() {
        assert!(glob_match("src/**/*.ts", "src/a/b.ts"));
        assert!(glob_match("src/**/*.ts", "src/b.ts"));
        assert!(!glob_match("src/**/*.ts", "lib/b.ts"));
        assert!(glob_match("*.tsx", "apps/x/View.tsx"));
        assert!(glob_match("**/*.{ts,tsx}", "a/b.tsx"));
        assert!(glob_match("apps/desktop/**", "apps/desktop/src/x.ts"));
        assert!(!glob_match("apps/desktop/**", "apps/mobile/x.ts"));
        assert!(glob_match("crates/*/src/?.rs", "crates/a/src/x.rs"));
    }

    #[test]
    fn reads_each_tools_activation() {
        let root = tree(&[
            (".claude/rules/always.md", "Always text"),
            (".claude/rules/api.md", "---\npaths:\n  - \"src/api/**/*.ts\"\n---\nAPI text"),
            (
                ".cursor/rules/tests.mdc",
                "---\ndescription: How we write tests\nglobs:\nalwaysApply: false\n---\nTest text",
            ),
            (".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\nStyle text"),
            (".cursor/rules/manual.mdc", "---\n---\nManual text"),
            (".kiro/steering/tech.md", "---\ninclusion: fileMatch\nfileMatchPattern: \"*.rs\"\n---\nRust text"),
            (".kiro/steering/product.md", "Product text"),
            (".kiro/steering/auto.md", "---\ninclusion: auto\nname: db\ndescription: Database work\n---\nDb text"),
            (".windsurf/rules/web.md", "---\ntrigger: glob\nglobs: \"*.css\"\n---\nCss text"),
            (".windsurf/rules/on.md", "---\ntrigger: always_on\n---\nOn text"),
            (".windsurf/rules/pick.md", "---\ntrigger: model_decision\ndescription: Pick me\n---\nPick text"),
            (".github/instructions/py.instructions.md", "---\napplyTo: \"**/*.py,**/*.pyi\"\n---\nPy text"),
            (".github/instructions/all.instructions.md", "---\napplyTo: \"**\"\n---\nAll text"),
            (".agents/rules/dup.md", "Always text"),
            ("apps/web/AGENTS.md", "Web text"),
            ("node_modules/pkg/AGENTS.md", "Never"),
            ("AGENTS.md", "Root text"),
        ]);
        let rules = collect_rules(std::slice::from_ref(&root));
        let by = |rel: &str| rules.iter().find(|r| r.rel == rel).map(|r| r.activation.clone());
        // `.agents/rules` is read first, so its copy wins and the `.claude/rules` duplicate is dropped.
        assert_eq!(by(".agents/rules/dup.md"), Some(Activation::Always));
        assert_eq!(by(".claude/rules/always.md"), None);
        assert_eq!(by(".claude/rules/api.md"), Some(Activation::Paths(vec!["src/api/**/*.ts".into()])));
        assert_eq!(by(".cursor/rules/tests.mdc"), Some(Activation::OnDemand));
        assert_eq!(by(".cursor/rules/style.mdc"), Some(Activation::Always));
        assert_eq!(by(".cursor/rules/manual.mdc"), Some(Activation::Manual));
        assert_eq!(by(".kiro/steering/tech.md"), Some(Activation::Paths(vec!["*.rs".into()])));
        assert_eq!(by(".kiro/steering/product.md"), Some(Activation::Always));
        assert_eq!(by(".kiro/steering/auto.md"), Some(Activation::OnDemand));
        assert_eq!(by(".windsurf/rules/web.md"), Some(Activation::Paths(vec!["*.css".into()])));
        assert_eq!(by(".windsurf/rules/on.md"), Some(Activation::Always));
        assert_eq!(by(".windsurf/rules/pick.md"), Some(Activation::OnDemand));
        assert_eq!(
            by(".github/instructions/py.instructions.md"),
            Some(Activation::Paths(vec!["**/*.py".into(), "**/*.pyi".into()]))
        );
        assert_eq!(by(".github/instructions/all.instructions.md"), Some(Activation::Always));
        assert_eq!(by("apps/web/AGENTS.md"), Some(Activation::Paths(vec!["apps/web/**".into()])));
        assert!(rules.iter().all(|r| !r.rel.starts_with("node_modules")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn guidance_levels() {
        let root = tree(&[
            ("AGENTS.md", "Root text"),
            (".claude/rules/always.md", "Always text"),
            (".claude/rules/api.md", "---\ndescription: API rules\npaths: src/api/**\n---\nAPI text"),
            (".cursor/rules/tests.mdc", "---\ndescription: How we write tests\n---\nTest text"),
        ]);
        let roots = std::slice::from_ref(&root);
        assert_eq!(project_guidance(roots, &[], Guidance::Off), ProjectGuidance::default());

        let root_only = project_guidance(roots, &[], Guidance::Root);
        assert_eq!(root_only.guidelines.len(), 1);
        assert!(root_only.indexes.is_empty());

        let rules = project_guidance(roots, &[], Guidance::Rules);
        let bodies: Vec<&str> = rules.guidelines.iter().map(|(_, c)| c.as_str()).collect();
        assert_eq!(bodies, ["Root text", "Always text"]);
        let index = &rules.indexes[0].1;
        assert!(index.contains("- .claude/rules/api.md: applies to src/api/** (API rules)"), "{index}");
        assert!(index.contains("- .cursor/rules/tests.mdc: How we write tests"), "{index}");

        // An attached file under src/api brings the API rule's text in and out of the index.
        let attached = nodepath::join(&root, "src/api/user.ts");
        let scoped = project_guidance(roots, &[attached], Guidance::Rules);
        assert!(scoped.guidelines.iter().any(|(_, c)| c == "API text"));
        assert!(!scoped.indexes[0].1.contains("api.md"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_sibling_folder_is_not_inside() {
        assert!(inside("/code/x", "/code/x/a.ts"));
        assert!(inside("/code/x/", "/code/x/a.ts"));
        assert!(!inside("/code/x", "/code/xy/a.ts"));
    }

    #[test]
    fn frontmatter_needs_a_closing_fence() {
        let (front, body) = split_front("---\npaths: a\nno end");
        assert!(front.pairs.is_empty());
        assert_eq!(body, "---\npaths: a\nno end");
        assert_eq!(Guidance::from_value(Some(&serde_json::json!("off"))), Guidance::Off);
        assert_eq!(Guidance::from_value(None), Guidance::Rules);
    }
}
