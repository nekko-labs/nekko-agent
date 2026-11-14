//! Deletes in shell commands (#2780), on top of the rules and the read-only
//! allowlist.
//!
//! - **Refused in every mode**, YOLO included: a delete that names no path,
//!   names the filesystem or a drive root, a folder right under a root or a
//!   mount point (recursively), the home folder or a folder above it, passes
//!   `--no-preserve-root`, or recursively deletes a path that starts with a
//!   variable (`rm -rf "$DIR/"` is `rm -rf /` when `DIR` is empty). When the
//!   strict reader gives up on a command (it refuses `$`, backticks and
//!   subshells), the command is read loosely for this check, so
//!   `rm -rf "$HOME"` is refused rather than merely asked about.
//! - **Run without asking**: a delete whose every path is, links followed,
//!   inside a delete root: a chat folder in a Nekko chat worktree
//!   (`<repo>/.git/nekko-worktrees/<name>`) or the app's scratch folder
//!   (`~/.nekko-agent/scratch`). Git files inside the root still ask.

use crate::allowlist::{self, Dialect, Segment};
use crate::guardrails::{Action, GuardrailMatch, Severity};
use crate::path::native;
use crate::sandbox::real_location;
use std::path::{Path, PathBuf};

/// The `ruleId` of the match that refuses a delete which could wipe a drive or a home folder.
pub const UNSAFE_DELETE: &str = "unsafe-delete";

/// The app folder's subfolder a chat may delete inside without asking.
pub const SCRATCH: &str = "scratch";

/// Where a command runs and which folders it may delete inside without asking.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeleteScope {
    /// The command's starting directory. `None` when Nekko cannot know it
    /// (Claude Code's shell keeps its own), so only absolute paths count.
    pub cwd: Option<String>,
    /// Folders a delete may remove things inside without asking ([`delete_roots`]).
    pub roots: Vec<String>,
    /// The user's home folder; `None` reads `HOME`, then `USERPROFILE`.
    pub home: Option<String>,
}

impl DeleteScope {
    fn home(&self) -> Option<String> {
        self.home
            .clone()
            .or_else(|| std::env::var("HOME").ok().filter(|h| !h.is_empty()))
            .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
            .map(|h| native::resolve(&[&h]))
    }
}

/// The folders a chat may delete inside without asking: each of its folders
/// that lies in a Nekko chat worktree, and the app folder's `scratch`.
pub fn delete_roots<'a>(folders: impl IntoIterator<Item = &'a str>, app_data_root: Option<&str>) -> Vec<String> {
    let mut roots: Vec<String> =
        folders.into_iter().filter(|f| in_chat_worktree(f)).map(|f| native::resolve(&[f])).collect();
    if let Some(app) = app_data_root.filter(|a| !a.is_empty()) {
        roots.push(native::resolve(&[app, SCRATCH]));
    }
    roots
}

/// `folder` is in `<git dir>/nekko-worktrees/<name>`, a checkout git knows
/// as a worktree (its root has a `.git` file).
fn in_chat_worktree(folder: &str) -> bool {
    let p = PathBuf::from(native::resolve(&[folder]));
    let parts: Vec<_> = p.components().collect();
    (1..parts.len().saturating_sub(1)).any(|i| {
        let parent = parts[i - 1].as_os_str().to_string_lossy();
        parts[i].as_os_str() == "nekko-worktrees"
            && parent.to_ascii_lowercase().ends_with(".git")
            && parts[..=i + 1].iter().collect::<PathBuf>().join(".git").is_file()
    })
}

// ------------------------------------------------------------ reading a delete

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Rm,
    Rmdir,
    Unlink,
    RemoveItem,
    CmdDel,
    Find,
}

#[derive(Default)]
struct Delete {
    recursive: bool,
    targets: Vec<String>,
    no_preserve_root: bool,
    /// `--help` / `--version`: deletes nothing.
    info: bool,
    /// `rmdir -p`: also removes the parents named in the path.
    parents: bool,
}

/// A command word as the shell finds it: the file name, lower-cased (macOS
/// and Windows file systems ignore case), without `.exe`.
fn command_name(word: &str) -> String {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

fn kind(name: &str, d: Dialect) -> Option<Kind> {
    match (d, name) {
        (Dialect::Posix, "rm") => Some(Kind::Rm),
        (Dialect::Posix, "rmdir") => Some(Kind::Rmdir),
        (Dialect::Posix, "unlink") => Some(Kind::Unlink),
        (Dialect::Posix, "find") => Some(Kind::Find),
        (Dialect::Cmd, "del" | "erase" | "rd" | "rmdir") => Some(Kind::CmdDel),
        (Dialect::PowerShell, "remove-item" | "rm" | "del" | "erase" | "rd" | "rmdir" | "ri") => Some(Kind::RemoveItem),
        _ => None,
    }
}

fn parse(kind: Kind, args: &[String]) -> Option<Delete> {
    let mut del = Delete::default();
    match kind {
        Kind::Rm | Kind::Rmdir | Kind::Unlink => {
            let mut options = true;
            for a in args {
                if options && a == "--" {
                    options = false;
                } else if options && a.starts_with("--") {
                    // getopt takes any unambiguous abbreviation.
                    let n = a.split('=').next().unwrap_or_default();
                    let abbrev = |full: &str, min: usize| n.len() >= min && full.starts_with(n);
                    del.no_preserve_root |= abbrev("--no-preserve-root", 3);
                    del.recursive |= kind == Kind::Rm && abbrev("--recursive", 3);
                    del.parents |= kind == Kind::Rmdir && abbrev("--parents", 3);
                    del.info |= n == "--help" || n == "--version";
                } else if options && a.len() > 1 && a.starts_with('-') {
                    del.recursive |= kind == Kind::Rm && a[1..].contains(['r', 'R']);
                    del.parents |= kind == Kind::Rmdir && a[1..].contains('p');
                } else {
                    del.targets.push(a.clone());
                }
            }
        }
        Kind::RemoveItem => {
            const VALUED: &[&str] =
                &["-path", "-literalpath", "-filter", "-include", "-exclude", "-credential", "-stream"];
            let mut i = 0;
            while i < args.len() {
                let a = &args[i];
                i += 1;
                if a.len() > 1 && a.starts_with('-') {
                    let (name, inline) = match a.split_once(':') {
                        Some((n, v)) => (n.to_ascii_lowercase(), Some(v.to_string())),
                        None => (a.to_ascii_lowercase(), None),
                    };
                    if "-recurse".starts_with(&name) {
                        del.recursive = true;
                    } else if let Some(p) = VALUED.iter().find(|p| p.starts_with(&name)) {
                        let value = inline.or_else(|| {
                            i += 1;
                            args.get(i - 1).cloned()
                        });
                        if matches!(*p, "-path" | "-literalpath") {
                            del.targets.extend(value.unwrap_or_default().split(',').map(str::to_string));
                        }
                    }
                } else {
                    del.targets.extend(a.split(',').filter(|t| !t.is_empty()).map(str::to_string));
                }
            }
        }
        Kind::CmdDel => {
            for a in args {
                if let Some(switches) = a.strip_prefix('/') {
                    del.recursive |= switches.split('/').any(|s| s.eq_ignore_ascii_case("s"));
                } else {
                    del.targets.push(a.clone());
                }
            }
        }
        Kind::Find => {
            // `find [-H|-L|-P] [path...] expression`: a delete only when the
            // expression deletes.
            let rest = args.iter().skip_while(|a| matches!(a.as_str(), "-H" | "-L" | "-P"));
            let (paths, expr): (Vec<&String>, Vec<&String>) = {
                let all: Vec<&String> = rest.collect();
                let at = all.iter().position(|a| a.starts_with('-') || *a == "(" || *a == "!").unwrap_or(all.len());
                (all[..at].to_vec(), all[at..].to_vec())
            };
            let deletes = expr.iter().enumerate().any(|(i, a)| {
                a.as_str() == "-delete"
                    || (matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir")
                        && expr
                            .get(i + 1)
                            .is_some_and(|c| matches!(command_name(c).as_str(), "rm" | "unlink" | "rmdir")))
            });
            // `find ~ -name '*.pyc' -delete` picks what it deletes; only an
            // expression with no test in it deletes everything under its paths.
            const NO_TEST: &[&str] = &[
                "-delete",
                "-depth",
                "-xdev",
                "-mount",
                "-print",
                "-print0",
                "-mindepth",
                "-maxdepth",
                "-follow",
                "-exec",
                "-execdir",
                "-ok",
                "-okdir",
            ];
            let mut tested = false;
            let mut in_exec = false;
            for a in &expr {
                if in_exec {
                    // An -exec command runs to `;` or `+`; its flags are not tests.
                    in_exec = !matches!(a.as_str(), ";" | "+");
                } else if matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") {
                    in_exec = true;
                } else {
                    tested |= a.starts_with('-') && !NO_TEST.contains(&a.as_str());
                }
            }
            if !deletes || tested {
                return None;
            }
            del.recursive = true;
            del.targets = if paths.is_empty() { vec![".".into()] } else { paths.into_iter().cloned().collect() };
        }
    }
    Some(del)
}

/// A simple command with what runs it peeled off: leading `VAR=value`
/// words and wrappers (`sudo`, `env`, `xargs`, `nohup`, `timeout`, ...).
/// The flag says the command's paths may come from its input (`xargs`).
fn unwrap(mut words: &[String]) -> (&[String], bool) {
    let mut fed = false;
    let is_assignment = |w: &String| {
        w.split_once('=').is_some_and(|(n, _)| {
            !n.is_empty()
                && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !n.starts_with(|c: char| c.is_ascii_digit())
        })
    };
    for _ in 0..8 {
        while words.first().is_some_and(is_assignment) {
            words = &words[1..];
        }
        let Some(first) = words.first() else { break };
        let with_arg: &[&str] = match command_name(first).as_str() {
            "sudo" => &["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"],
            "doas" => &["-u", "-C"],
            "env" => &["-u", "-C", "--unset", "--chdir"],
            "nice" => &["-n"],
            "timeout" => &["-s", "-k", "--signal", "--kill-after"],
            "stdbuf" => &["-i", "-o", "-e"],
            "exec" => &["-a"],
            "xargs" => {
                fed = true;
                &["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]
            }
            "command" | "builtin" | "nohup" | "time" => &[],
            _ => break,
        };
        let timeout = command_name(first) == "timeout";
        words = &words[1..];
        while let Some(w) = words.first().filter(|w| w.len() > 1 && w.starts_with('-')) {
            if w == "--" {
                words = &words[1..];
                break;
            }
            words = &words[if with_arg.contains(&w.as_str()) { 2 } else { 1 }.min(words.len())..];
        }
        if timeout && !words.is_empty() {
            words = &words[1..]; // the duration
        }
    }
    (words, fed)
}

/// The script inside `sh -c '...'`, `eval ...`, `cmd /c ...` or `powershell -Command ...`.
fn inner_script(name: &str, args: &[String]) -> Option<(String, Dialect)> {
    match name {
        "sh" | "bash" | "zsh" | "dash" | "ksh" => {
            let at = args
                .iter()
                .position(|a| a.len() > 1 && a.starts_with('-') && !a.starts_with("--") && a.contains('c'))?;
            args.get(at + 1).map(|s| (s.clone(), Dialect::Posix))
        }
        "eval" => Some((args.join(" "), Dialect::Posix)),
        "cmd" => {
            let at = args.iter().position(|a| a.eq_ignore_ascii_case("/c") || a.eq_ignore_ascii_case("/k"))?;
            Some((args[at + 1..].join(" "), Dialect::Cmd))
        }
        "powershell" | "pwsh" => {
            let at = args.iter().position(|a| {
                let a = a.to_ascii_lowercase();
                a.len() > 1 && "-command".starts_with(&a)
            })?;
            Some((args[at + 1..].join(" "), Dialect::PowerShell))
        }
        _ => None,
    }
}

// ------------------------------------------------------------ paths

fn expands(c: char, d: Dialect) -> bool {
    match d {
        Dialect::Posix | Dialect::PowerShell => c == '$' || c == '`',
        Dialect::Cmd => c == '%' || c == '!',
    }
}

/// Characters that make a path stand for paths the reader cannot list:
/// wildcards, brace expansion, and any expansion the loose reader let through.
fn wild(c: char, d: Dialect) -> bool {
    matches!(c, '*' | '?') || (d != Dialect::Cmd && matches!(c, '[' | '{')) || expands(c, d)
}

/// The deepest folder of `p` with no wildcard in it, and whether `p` had one.
fn literal_parent(p: &str, d: Dialect) -> (String, bool) {
    let mut base = p.to_string();
    while base.chars().any(|c| wild(c, d)) {
        let up = native::dirname(&base);
        if up == base {
            break;
        }
        base = up;
    }
    let globbed = base != p;
    (base, globbed)
}

/// `p` with `~` expanded, or `None` when it names another user's home.
fn expand_tilde(p: &str, d: Dialect, home: Option<&str>) -> Option<String> {
    if d == Dialect::Cmd || !p.starts_with('~') {
        return Some(p.to_string());
    }
    let rest = &p[1..];
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
        return None;
    }
    home.map(|h| native::join(&[h, rest]))
}

/// The absolute paths `target` can mean: one per possible starting
/// directory, `None` for a relative path when one of those is unknown.
fn absolutes(target: &str, cwds: &[Option<String>]) -> Vec<Option<String>> {
    if native::is_absolute(target) {
        return vec![Some(native::resolve(&[target]))];
    }
    cwds.iter().map(|c| c.as_ref().map(|c| native::resolve(&[c, target]))).collect()
}

/// `root` is `target` or contains it (the string rule from the sandbox).
fn within(root: &str, target: &str) -> bool {
    let rel = native::relative(root, target);
    rel.is_empty() || (!rel.starts_with("..") && !native::is_absolute(&rel))
}

fn same(a: &str, b: &str) -> bool {
    native::relative(a, b).is_empty()
}

fn is_root(p: &str) -> bool {
    native::dirname(p) == p
}

/// A drive root written for cmd or PowerShell (`C:`, `C:\`, `\`, `C:\*`),
/// judged on the text so it holds on any host.
fn windows_root_text(t: &str) -> bool {
    let b = t.as_bytes();
    let rest = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        &t[2..]
    } else if t.starts_with(['\\', '/']) {
        t
    } else {
        return false;
    };
    rest.chars().all(|c| matches!(c, '\\' | '/' | '*' | '.'))
}

#[cfg(unix)]
fn mount_point(p: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    let path = Path::new(p);
    match (std::fs::metadata(path), path.parent().map(std::fs::metadata)) {
        (Ok(m), Some(Ok(parent))) => m.is_dir() && m.dev() != parent.dev(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn mount_point(_: &str) -> bool {
    false
}

/// Why deleting `p` (as written and where it really is) could wipe a drive
/// or a home folder.
fn wipes(p: &str, recursive: bool, globbed: bool, home: Option<&str>) -> Option<&'static str> {
    let real = real_location(p);
    let real_home = home.map(real_location);
    let above_home = |x: &str| home.is_some_and(|h| within(x, h)) || real_home.as_deref().is_some_and(|h| within(x, h));
    for x in [p, real.as_str()] {
        if is_root(x) {
            return Some(if globbed { "Delete of everything on a drive" } else { "Delete of a whole drive" });
        }
        if above_home(x) {
            return Some(if globbed { "Delete of everything in the home folder" } else { "Delete of the home folder" });
        }
        if recursive && !globbed && (is_root(&native::dirname(x)) || mount_point(x)) {
            return Some("Recursive delete of a drive or a top-level folder");
        }
    }
    None
}

/// Why one target of a delete is refused, if it is.
fn unsafe_target(
    t: &str,
    recursive: bool,
    d: Dialect,
    cwds: &[Option<String>],
    home: Option<&str>,
) -> Option<&'static str> {
    if t.trim().is_empty() {
        return Some("Delete without a path");
    }
    if recursive && t.starts_with(|c| expands(c, d)) {
        return Some("Recursive delete of a path that starts with a variable");
    }
    if d != Dialect::Posix && windows_root_text(t) {
        return Some("Delete of a whole drive");
    }
    let Some(t) = expand_tilde(t, d, home) else {
        // `~name`: someone's home folder.
        let bare = !t[1..].contains(['/', '\\']);
        return (recursive && bare).then_some("Delete of the home folder");
    };
    for p in absolutes(&t, cwds).into_iter().flatten() {
        let (base, globbed) = literal_parent(&p, d);
        if let Some(why) = wipes(&base, recursive, globbed, home) {
            return Some(why);
        }
    }
    None
}

// ------------------------------------------------------------ walking a command

struct Seg {
    words: Vec<String>,
    sep: &'static str,
}

fn strict(segments: &[Segment]) -> Vec<Seg> {
    segments.iter().map(|s| Seg { words: s.words.clone(), sep: s.sep }).collect()
}

/// A rough split for commands the strict reader refuses: on every operator
/// and bracket, quotes dropped, expansions left in the words.
fn loose(command: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut flush = |cur: &mut String, sep: &'static str| {
        let words: Vec<String> = cur.split_whitespace().map(str::to_string).collect();
        if !words.is_empty() {
            out.push(Seg { words, sep });
        }
        cur.clear();
    };
    for c in command.chars() {
        match c {
            '|' => flush(&mut cur, "|"),
            ';' | '\n' | '\r' | '&' | '(' | ')' | '`' | '{' | '}' => flush(&mut cur, ";"),
            '\'' | '"' => {}
            c => cur.push(c),
        }
    }
    flush(&mut cur, "");
    out
}

fn segments_of(command: &str, d: Dialect) -> Vec<Seg> {
    match allowlist::split(command, d) {
        Ok(s) => strict(&s),
        Err(_) => loose(command),
    }
}

/// Where the next command may start after `words` ran, followed by `sep`.
fn next_cwds(
    words: &[String],
    sep: &str,
    d: Dialect,
    cwds: &[Option<String>],
    home: Option<&str>,
) -> Vec<Option<String>> {
    let Some(first) = words.first() else { return cwds.to_vec() };
    let name = command_name(first);
    let changes = match d {
        Dialect::Posix => matches!(name.as_str(), "cd" | "chdir" | "pushd" | "popd"),
        Dialect::Cmd => matches!(name.as_str(), "cd" | "chdir" | "pushd" | "popd"),
        Dialect::PowerShell => {
            matches!(name.as_str(), "cd" | "chdir" | "set-location" | "sl" | "pushd" | "popd" | "push-location")
        }
    };
    if !changes {
        return cwds.to_vec();
    }
    // A pipeline or background job changes directory in a subshell (cmd's `&` runs in order).
    if sep == "|" || (sep == "&" && d != Dialect::Cmd) {
        return cwds.to_vec();
    }
    let arg = words[1..].iter().find(|a| !(a.starts_with('-') || (d == Dialect::Cmd && a.starts_with('/'))));
    let new: Vec<Option<String>> = match (name.as_str(), arg) {
        ("popd", _) => vec![None],
        (_, None) if d == Dialect::Cmd => cwds.to_vec(),
        (_, None) => vec![home.map(str::to_string)],
        (_, Some(a)) if a.chars().any(|c| wild(c, d)) => vec![None],
        (_, Some(a)) => match expand_tilde(a, d, home) {
            Some(a) => absolutes(&a, cwds),
            None => vec![None],
        },
    };
    match sep {
        "&&" | "" => new,
        // `cd x || rm ...` deletes only when cd failed.
        "||" => cwds.to_vec(),
        // `cd x; rm ...` deletes where cd went, or where it was when cd failed.
        _ => cwds.iter().cloned().chain(new).collect(),
    }
}

fn deny(label: &str, evidence: &[String]) -> GuardrailMatch {
    GuardrailMatch {
        rule_id: UNSAFE_DELETE.into(),
        label: label.into(),
        severity: Severity::High,
        action: Action::Deny,
        evidence: evidence.join(" "),
    }
}

fn walk(segs: &[Seg], d: Dialect, start: &[Option<String>], home: Option<&str>, depth: u8) -> Option<GuardrailMatch> {
    let mut cwds = start.to_vec();
    let mut piped = false;
    for s in segs {
        if let Some(m) = check_segment(&s.words, piped, d, &cwds, home, depth) {
            return Some(m);
        }
        cwds = next_cwds(&s.words, s.sep, d, &cwds, home);
        piped = s.sep == "|";
    }
    None
}

fn check_segment(
    words: &[String],
    piped: bool,
    d: Dialect,
    cwds: &[Option<String>],
    home: Option<&str>,
    depth: u8,
) -> Option<GuardrailMatch> {
    let (cmd, xargs) = unwrap(words);
    let (first, args) = cmd.split_first()?;
    let name = command_name(first);
    if depth < 4
        && let Some((script, inner)) = inner_script(&name, args)
    {
        return walk(&segments_of(&script, inner), inner, cwds, home, depth + 1);
    }
    let del = parse(kind(&name, d)?, args)?;
    if del.info {
        return None;
    }
    if del.no_preserve_root {
        return Some(deny("Delete with --no-preserve-root", words));
    }
    if del.targets.is_empty() {
        // Paths from a pipe (`... | Remove-Item`, `xargs rm`) are not known here; that asks.
        return (!piped && !xargs).then(|| deny("Delete without a path", words));
    }
    del.targets.iter().find_map(|t| unsafe_target(t, del.recursive, d, cwds, home).map(|why| deny(why, words)))
}

/// The first delete in `command` that could wipe a drive or a home folder.
pub(crate) fn unsafe_delete(
    command: &str,
    parsed: Option<&[Segment]>,
    d: Dialect,
    scope: &DeleteScope,
) -> Option<GuardrailMatch> {
    let segs = match parsed {
        Some(s) => strict(s),
        None => loose(command),
    };
    let home = scope.home();
    walk(&segs, d, std::slice::from_ref(&scope.cwd), home.as_deref(), 0)
}

// ------------------------------------------------------------ scoped deletes

/// Inside `root` and not git's: no `.git` (or `.gitconfig`) between the root
/// and the path, and no git directory on the way down.
fn in_root(root: &str, p: &str, strictly: bool) -> bool {
    if !within(root, p) || (strictly && same(root, p)) {
        return false;
    }
    let rel = native::relative(root, p);
    let gitty = Path::new(&rel).components().any(|c| {
        let n = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        n == ".git" || n == ".gitconfig"
    });
    let git_dir_between = Path::new(p)
        .ancestors()
        .skip(1)
        .take_while(|a| within(root, &a.to_string_lossy()) && !same(root, &a.to_string_lossy()))
        .any(|a| a.join("HEAD").is_file() && (a.join("objects").is_dir() || a.join("commondir").is_file()));
    !gitty && !git_dir_between
}

/// `p` is inside one of the roots, as written and where it really is.
fn in_scope(p: &str, d: Dialect, roots: &[String]) -> bool {
    let (base, globbed) = literal_parent(p, d);
    if globbed {
        // Only sh wildcards, which never match a leading dot (so never `.git`
        // or `..`), and no brace expansion.
        let rel = native::relative(&base, p);
        let ok = d == Dialect::Posix
            && !p.chars().any(|c| expands(c, d) || c == '{')
            && Path::new(&rel).components().all(|c| {
                let n = c.as_os_str().to_string_lossy();
                !n.starts_with('.') && !n.starts_with('[')
            });
        if !ok {
            return false;
        }
    }
    let (target, strictly) = if globbed { (base.as_str(), false) } else { (p, true) };
    let real = real_location(target);
    roots.iter().any(|r| in_root(r, target, strictly) && in_root(&real_location(r), &real, strictly))
}

fn allow_name(word: &str, d: Dialect) -> Option<Kind> {
    match d {
        // As written, never a path: `/tmp/rm` is not rm.
        Dialect::Posix => kind(word, d).filter(|k| *k != Kind::Find),
        _ => kind(&word.to_ascii_lowercase(), d),
    }
}

/// For each segment, whether it is a delete that stays inside the scope's
/// roots and may run without asking.
pub(crate) fn scoped_deletes(segments: &[Segment], d: Dialect, scope: &DeleteScope) -> Vec<bool> {
    let mut out = vec![false; segments.len()];
    if scope.roots.is_empty() {
        return out;
    }
    let home = scope.home();
    let mut cwds = vec![scope.cwd.clone()];
    let mut piped = false;
    for (i, s) in segments.iter().enumerate() {
        out[i] = !piped
            && s.words.split_first().is_some_and(|(first, args)| {
                let Some(del) = allow_name(first, d).and_then(|k| parse(k, args)) else { return false };
                !del.info
                    && !del.no_preserve_root
                    && !del.parents
                    && !del.targets.is_empty()
                    && del.targets.iter().all(|t| {
                        !t.trim().is_empty()
                            && expand_tilde(t, d, home.as_deref()).is_some_and(|t| {
                                absolutes(&t, &cwds)
                                    .iter()
                                    .all(|p| p.as_ref().is_some_and(|p| in_scope(p, d, &scope.roots)))
                            })
                    })
            });
        cwds = next_cwds(&s.words, s.sep, d, &cwds, home.as_deref());
        piped = s.sep == "|";
    }
    out
}

/// The scope for a command a native tool runs from `cwd`: the chat's folders
/// in Nekko chat worktrees and the app's scratch folder.
pub(crate) fn scope_for(ctx: &crate::ToolContext, cwd: Option<String>) -> DeleteScope {
    DeleteScope {
        cwd,
        roots: delete_roots(ctx.workspaces.iter().map(|w| w.path.as_str()), ctx.app_data_root.as_deref()),
        home: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guardrails::{GuardrailRule, classify_command_scoped, default_guardrails};

    /// A home folder with a repository, a Nekko chat worktree of it, the app
    /// folder, and a link from the worktree to outside it.
    struct Rig {
        dir: PathBuf,
        home: String,
        repo: String,
        wt: String,
        scratch: String,
    }

    impl Rig {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nekko-delete-guard-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let home = dir.join("home");
            let repo = home.join("code").join("repo");
            let wt = repo.join(".git").join("nekko-worktrees").join("calm-jade-otter");
            std::fs::create_dir_all(wt.join("build")).unwrap();
            std::fs::create_dir_all(wt.join("sub").join("out")).unwrap();
            std::fs::create_dir_all(repo.join("src")).unwrap();
            std::fs::write(wt.join(".git"), "gitdir: ../../worktrees/calm-jade-otter\n").unwrap();
            let app = home.join(".nekko-agent");
            std::fs::create_dir_all(app.join("scratch").join("tmp")).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(repo.join("src"), wt.join("escape")).unwrap();
            let s = |p: PathBuf| real_location(&p.to_string_lossy());
            let scratch = s(app.join("scratch"));
            Self { home: s(home), repo: s(repo), wt: s(wt), scratch, dir }
        }

        fn scope(&self, cwd: Option<&str>) -> DeleteScope {
            let app = native::join(&[&self.home, ".nekko-agent"]);
            DeleteScope {
                cwd: cwd.map(str::to_string),
                roots: delete_roots([self.wt.as_str(), self.repo.as_str()], Some(&app)),
                home: Some(self.home.clone()),
            }
        }

        fn action(&self, command: &str, cwd: Option<&str>, d: Dialect) -> Action {
            classify_command_scoped(command, &default_guardrails(), d, &self.scope(cwd)).action
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn only_chat_worktrees_and_scratch_are_delete_roots() {
        let r = Rig::new("roots");
        assert_eq!(r.scope(None).roots, vec![r.wt.clone(), r.scratch.clone()]);
    }

    #[test]
    fn deletes_that_could_wipe_a_drive_or_home_are_refused() {
        let r = Rig::new("deny");
        let home = r.home.clone();
        let above = native::dirname(&home);
        let wt = r.wt.clone();
        for (cmd, cwd) in [
            ("rm -rf /", None),
            ("rm -rf /*", None),
            ("rm -r -f /", None),
            ("rm -fr //", None),
            ("rm -rf /.", None),
            ("rm --recursive --force /", None),
            ("/bin/rm -rf /", None),
            ("RM -rf /", None),
            ("sudo rm -rf /", None),
            ("sudo -u root rm -rf /", None),
            ("env FOO=1 rm -rf /", None),
            ("FOO=1 rm -rf /", None),
            ("timeout 5 rm -rf ~", None),
            ("nohup rm -rf / &", None),
            ("xargs rm -rf /", None),
            ("rm -rf /{usr,bin}", None),
            ("rm -rf /usr", None),
            ("rm -rf /tmp", None),
            ("rm -rf ~", None),
            ("rm -rf ~/", None),
            ("rm -rf ~/*", None),
            ("rm -rf ~/.*", None),
            ("rm ~/*", None),
            ("rm -rf ~root", None),
            (&format!("rm -rf {home}") as &str, None),
            (&format!("rm -rf {above}"), None),
            (&format!("rm -rf '{home}/'"), None),
            ("rm -rf . ", Some(home.as_str())),
            ("rm -rf *", Some(home.as_str())),
            ("rm -rf ..", Some(native::join(&[&home, "code"]).as_str())),
            ("cd / && rm -rf *", Some(wt.as_str())),
            ("cd ~; rm -rf ./*", Some(wt.as_str())),
            ("cd; rm -rf *", Some(wt.as_str())),
            ("ls && rm -rf /", None),
            ("ls\nrm -rf /", None),
            ("rm -rf --no-preserve-root /x", None),
            ("rm -rf", None),
            ("rm -f", None),
            ("rm", None),
            ("rm -rf ''", None),
            ("rm -rf \"$HOME\"", None),
            ("rm -rf $HOME", None),
            ("rm -rf \"$DIR/\"", None),
            ("rm -rf ${DIR}", None),
            ("rm -rf $(pwd)", None),
            ("rm -rf `pwd`", None),
            ("rm -rf ~/$X", None),
            ("bash -c \"rm -rf /\"", None),
            ("sh -lc 'rm -rf ~'", None),
            ("eval rm -rf /", None),
            ("find / -delete", None),
            ("find ~ -exec rm -rf {} +", None),
        ] {
            let d = classify_command_scoped(cmd, &default_guardrails(), Dialect::Posix, &r.scope(cwd));
            assert_eq!(d.action, Action::Deny, "{cmd:?} in {cwd:?}: {:?}", d.matches);
            assert!(d.matches.iter().any(|m| m.rule_id == UNSAFE_DELETE), "{cmd:?}");
        }
        for cmd in [
            r"Remove-Item -Recurse -Force C:\",
            r"Remove-Item -Recurse -Force C:\*",
            r"Remove-Item -Path C:\ -Recurse",
            r"Remove-Item -Recurse \",
            "Remove-Item -Recurse ~",
            "rm -r -fo ~",
            "Remove-Item -Recurse $HOME",
            "Remove-Item -Recurse $env:USERPROFILE",
            "Remove-Item",
            "Remove-Item -Recurse",
        ] {
            assert_eq!(r.action(cmd, None, Dialect::PowerShell), Action::Deny, "{cmd:?}");
        }
        for cmd in [r"rd /s /q C:\", r"rmdir /s/q c:", r"del /s /q \*", "rd /s %USERPROFILE%", "del", "rd /s /q"] {
            assert_eq!(r.action(cmd, None, Dialect::Cmd), Action::Deny, "{cmd:?}");
        }
    }

    #[test]
    fn ordinary_deletes_outside_the_roots_still_ask() {
        let r = Rig::new("ask");
        let repo = r.repo.clone();
        for (cmd, cwd) in [
            ("rm -rf ./dist", None),
            ("rm -rf dist", Some(repo.as_str())),
            ("rm -rf src", Some(repo.as_str())),
            ("rm -rf /tmp/nekko-x/y", None),
            ("rm file.txt", None),
            ("rm -rf ..", None),
            ("rm $FILE", None),
            ("ls | xargs rm", None),
            ("find ~ -name '*.pyc' -delete", None),
            ("find . -delete", None),
            ("cd /nonexistent || rm -rf *", None),
            ("rmdir empty", None),
        ] {
            let d = classify_command_scoped(cmd, &default_guardrails(), Dialect::Posix, &r.scope(cwd));
            assert_eq!(d.action, Action::Ask, "{cmd:?} in {cwd:?}: {:?}", d.matches);
        }
        // Text that only mentions a delete is not one (the regex rule still asks).
        assert_eq!(r.action("echo 'rm -rf /'", None, Dialect::Posix), Action::Ask);
        assert_eq!(r.action("rm --help", None, Dialect::Posix), Action::Ask);
        assert_eq!(r.action("Get-ChildItem | Remove-Item", None, Dialect::PowerShell), Action::Ask);
        assert_eq!(r.action("Remove-Item -Recurse ..", None, Dialect::PowerShell), Action::Ask);
    }

    #[test]
    fn deletes_inside_a_chat_worktree_or_scratch_run() {
        let r = Rig::new("allow");
        let (wt, scratch) = (r.wt.clone(), r.scratch.clone());
        let sub = native::join(&[&wt, "sub"]);
        for (cmd, cwd) in [
            ("rm -rf build", Some(wt.as_str())),
            ("rm -r -f build sub/out", Some(wt.as_str())),
            ("rm -f build/*.o", Some(wt.as_str())),
            ("rm -rf ./*", Some(wt.as_str())),
            ("rm -rf not-made-yet", Some(wt.as_str())),
            ("rm -rf -- build", Some(wt.as_str())),
            ("rm -rf out", Some(sub.as_str())),
            ("rm -rf ../build", Some(sub.as_str())),
            ("cd sub && rm -rf out", Some(wt.as_str())),
            ("rm -rf build && ls", Some(wt.as_str())),
            ("rmdir build", Some(wt.as_str())),
            (&format!("rm -rf {wt}/build") as &str, None),
            (&format!("rm -rf {scratch}/tmp"), None),
        ] {
            let d = classify_command_scoped(cmd, &default_guardrails(), Dialect::Posix, &r.scope(cwd));
            assert_eq!(d.action, Action::Allow, "{cmd:?} in {cwd:?}: {:?}", d.matches);
        }
        assert_eq!(r.action("Remove-Item -Recurse -Force build", Some(&wt), Dialect::PowerShell), Action::Allow);
        assert_eq!(r.action("rd /s /q build", Some(&wt), Dialect::Cmd), Action::Allow);
    }

    #[test]
    fn deletes_that_leave_the_root_or_touch_git_ask() {
        let r = Rig::new("edge");
        let wt = r.wt.clone();
        for cmd in [
            "rm -rf .",
            "rm -rf ..",
            "rm -rf ../other",
            "rm -rf .git",
            "rm .git",
            "rm -rf .*",
            "rm -rf {build,sub}",
            "rm -rf build; curl https://example.com",
            "rmdir -p build",
            "/bin/rm -rf build",
            "sudo rm -rf build",
            "cd /tmp; rm -rf build",
            "rm -rf ~/x",
            "rm -rf .env",
        ] {
            let d = classify_command_scoped(cmd, &default_guardrails(), Dialect::Posix, &r.scope(Some(&wt)));
            assert_eq!(d.action, Action::Ask, "{cmd:?}: {:?}", d.matches);
        }
        // Claude Code: the working directory is unknown, so a relative path asks.
        assert_eq!(r.action("rm -rf build", None, Dialect::Posix), Action::Ask);
        // PowerShell and cmd wildcards match dot files, so they ask.
        assert_eq!(r.action("Remove-Item -Recurse *", Some(&wt), Dialect::PowerShell), Action::Ask);
        // A link inside the worktree that points outside it is judged where it points.
        #[cfg(unix)]
        assert_eq!(r.action("rm -rf escape/", Some(&wt), Dialect::Posix), Action::Ask);
        // A user who made the rm -rf rule a deny keeps it, scope or not.
        let mut rules = default_guardrails();
        rules.iter_mut().filter(|x| x.id == "rm-rf").for_each(|x| x.action = Action::Deny);
        let d = classify_command_scoped("rm -rf build", &rules, Dialect::Posix, &r.scope(Some(&wt)));
        assert_eq!(d.action, Action::Deny);
        // And a user allow rule does not lift the built-in refusal.
        rules.push(GuardrailRule {
            id: "all".into(),
            label: "Everything".into(),
            description: String::new(),
            pattern: ".*".into(),
            severity: Severity::Low,
            action: Action::Allow,
            enabled: true,
        });
        let d = classify_command_scoped("rm -rf /", &rules, Dialect::Posix, &DeleteScope::default());
        assert_eq!(d.action, Action::Deny);
    }
}
