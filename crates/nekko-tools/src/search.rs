//! `glob` and `grep`: the TS host's own small walkers (`globFiles`,
//! `grepFiles` in `packages/host/src/tools.ts`), not ripgrep or globset,
//! because their output is the contract: walk order, the skipped folders,
//! paths relative to the root with `/`, and the line format.

use crate::js;
use crate::jsre::JsRegex;
use crate::nodefs::{self, DirEntry};
use crate::path::native;
use serde_json::Value;

/// Folders neither walker enters (nor lists, for glob and grep).
const SKIP: &[&str] = &["node_modules", ".git", "dist", "out", "build", ".next", "target", ".venv", "coverage"];

/// Depth-first, entries in `readdirSync` order, descending into a directory
/// as soon as it is met, like the recursive TS walkers. An unreadable
/// directory is skipped. `visit` returns false to stop the walk.
fn walk(root: &str, mut visit: impl FnMut(&str, &DirEntry) -> bool) {
    if std::fs::metadata(root).is_ok_and(|m| m.is_file()) {
        let name = std::path::Path::new(root).file_name().unwrap_or_default().to_string_lossy().into_owned();
        visit(root, &DirEntry { name, is_dir: false, is_file: true });
        return;
    }
    let Ok(first) = nodefs::read_dir(root) else { return };
    let mut stack: Vec<(String, std::vec::IntoIter<DirEntry>)> = vec![(root.to_string(), first.into_iter())];
    while let Some((dir, entries)) = stack.last_mut() {
        let Some(e) = entries.next() else {
            stack.pop();
            continue;
        };
        if SKIP.contains(&e.name.as_str()) {
            continue;
        }
        let full = native::join(&[dir, &e.name]);
        if e.is_dir {
            if let Ok(children) = nodefs::read_dir(&full) {
                stack.push((full, children.into_iter()));
            }
        } else if !visit(&full, &e) {
            return;
        }
    }
}

/// `relative(root, full).replace(/\\/g, '/')`.
fn rel(root: &str, full: &str) -> String {
    native::relative(root, full).replace('\\', "/")
}

const GLOB_SPECIAL: &str = ".+^${}()|[]\\";

fn push_str(re: &mut Vec<u16>, s: &str) {
    re.extend(s.encode_utf16());
}

/// `globToRegExp`: `**` (and a following `/`) is `.*`, `*` is `[^/]*`, `?`
/// is `[^/]`, regex punctuation is escaped and everything else is literal.
/// Built over UTF-16 code units, so `?` matches one unit, as it does in TS.
fn glob_units(glob: &[u16]) -> Vec<u16> {
    let star = u16::from(b'*');
    let mut re: Vec<u16> = vec![u16::from(b'^')];
    let mut i = 0;
    while i < glob.len() {
        let c = glob[i];
        if c == star {
            if glob.get(i + 1) == Some(&star) {
                push_str(&mut re, ".*");
                i += 1;
                if glob.get(i + 1) == Some(&u16::from(b'/')) {
                    i += 1;
                }
            } else {
                push_str(&mut re, "[^/]*");
            }
        } else if c == u16::from(b'?') {
            push_str(&mut re, "[^/]");
        } else if GLOB_SPECIAL.encode_utf16().any(|s| s == c) {
            re.push(u16::from(b'\\'));
            re.push(c);
        } else {
            re.push(c);
        }
        i += 1;
    }
    re.push(u16::from(b'$'));
    re
}

/// The same loop over an array "pattern", whose items are compared with
/// `===` and tested with `includes` (a substring test, so `""` counts).
fn glob_items(items: &[Value]) -> String {
    let is = |v: Option<&Value>, s: &str| v.and_then(Value::as_str) == Some(s);
    let mut re = String::from("^");
    let mut i = 0;
    while i < items.len() {
        let c = &items[i];
        if is(Some(c), "*") {
            if is(items.get(i + 1), "*") {
                re.push_str(".*");
                i += 1;
                if is(items.get(i + 1), "/") {
                    i += 1;
                }
            } else {
                re.push_str("[^/]*");
            }
        } else if is(Some(c), "?") {
            re.push_str("[^/]");
        } else {
            let text = js::to_string(Some(c));
            if GLOB_SPECIAL.contains(text.as_str()) {
                re.push('\\');
            }
            re.push_str(&text);
        }
        i += 1;
    }
    re.push('$');
    re
}

/// `globToRegExp(pattern)`, or the error it throws.
fn glob_regex(pattern: Option<&Value>) -> Result<JsRegex, String> {
    let compile_units = |u: &[u16]| {
        JsRegex::from_units(u, "")
            .map_err(|e| format!("Invalid regular expression: /{}/: {e}", String::from_utf16_lossy(u)))
    };
    match pattern {
        None => Err("Cannot read properties of undefined (reading 'length')".into()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'length')".into()),
        Some(Value::String(s)) => compile_units(&glob_units(&s.encode_utf16().collect::<Vec<_>>())),
        Some(Value::Array(items)) => {
            let src = glob_items(items);
            JsRegex::new(&src, "").map_err(|e| format!("Invalid regular expression: /{src}/: {e}"))
        }
        // No `length`: the loop never runs and the pattern is `^$`.
        Some(_) => compile_units(&glob_units(&[])),
    }
}

/// `globFiles(root, pattern)`, first `limit` matches.
pub fn glob_files(root: &str, pattern: Option<&Value>, limit: usize) -> Result<Vec<String>, String> {
    let re = glob_regex(pattern)?;
    let mut out = Vec::new();
    if limit == 0 {
        return Ok(out);
    }
    walk(root, |full, _| {
        let r = rel(root, full);
        let units: Vec<u16> = r.encode_utf16().collect();
        if re.find(&units).is_some() {
            out.push(r);
        }
        out.len() < limit
    });
    Ok(out)
}

/// A pattern that is plain ASCII text with no regex syntax, lowercased.
///
/// For those, `new RegExp(p, 'i').test(line)` is exactly an ASCII
/// case-insensitive substring search: without the `u` flag V8 folds case by
/// uppercasing and never maps a non-ASCII character to an ASCII one (so `ſ`
/// and the Kelvin sign stay apart from `s` and `k`), and in UTF-8 an ASCII
/// byte only ever stands for itself. Models mostly grep for words, and this
/// skips the regex engine for them.
fn ascii_literal(source: &str) -> Option<Vec<u8>> {
    let plain = source.is_ascii() && !source.bytes().any(|b| b"\\^$.|?*+()[]{}".contains(&b));
    plain.then(|| source.to_ascii_lowercase().into_bytes())
}

/// `statSync(full).size > 1_000_000` skips it, then `readFileSync(full,
/// 'utf8')`, any failure skipping it too. One open and a stat of the open
/// file, rather than two path lookups: on Windows each costs as much as
/// reading a small file, and grep does this for every file it meets.
fn read_small(full: &str) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(full).ok()?;
    let meta = file.metadata().ok()?;
    if meta.is_dir() || meta.len() > 1_000_000 {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `grepFiles(root, pattern)`, first `limit` lines.
pub fn grep_files(root: &str, pattern: Option<&Value>, limit: usize) -> Vec<String> {
    // `new RegExp(undefined)` is the empty pattern; anything else is String(x).
    let source = if pattern.is_none() { String::new() } else { js::to_string(pattern) };
    let Ok(re) = JsRegex::new(&source, "i") else {
        return vec![format!("Invalid regex: {source}")];
    };
    let literal = ascii_literal(&source);
    let finder = literal.as_deref().map(memchr::memmem::Finder::new);
    let mut out: Vec<String> = Vec::new();
    // TS checks `out.length > 100` before each entry and slices to 100 at
    // the end, so nothing past the 101st line is ever visible.
    let stop = limit + 1;
    walk(root, |full, _| {
        if out.len() >= stop {
            return false;
        }
        let Some(content) = read_small(full) else { return true };
        // A literal that is nowhere in the file is on none of its lines.
        if let Some(f) = &finder
            && f.find(&content.to_ascii_lowercase().into_bytes()).is_none()
        {
            return true;
        }
        // The regex runs over UTF-16; encode the file once, not line by line.
        // `\n` is one unit either way, so the lines split in step.
        let units: Vec<u16> = if finder.is_some() { Vec::new() } else { content.encode_utf16().collect() };
        let mut unit_lines = units.split(|&u| u == u16::from(b'\n'));
        let r = if root == full {
            std::path::Path::new(full).file_name().unwrap_or_default().to_string_lossy().into_owned()
        } else {
            rel(root, full)
        };
        for (idx, line) in content.split('\n').enumerate() {
            let hit = match &finder {
                Some(f) => f.find(&line.to_ascii_lowercase().into_bytes()).is_some(),
                None => unit_lines.next().is_some_and(|u| re.find(u).is_some()),
            };
            if hit {
                out.push(format!("{r}:{}: {}", idx + 1, js::slice16(js::trim(line), 200)));
                if out.len() >= stop {
                    break;
                }
            }
        }
        true
    });
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn glob_matches(glob: &str, path: &str) -> bool {
        let re = glob_regex(Some(&json!(glob))).unwrap();
        re.find(&path.encode_utf16().collect::<Vec<_>>()).is_some()
    }

    #[test]
    fn the_literal_fast_path_agrees_with_the_regex_engine() {
        let lines = [
            "plain",
            "PLAIN",
            "pLaIn text",
            "ſtrict",
            "strict",
            "STRICT",
            "\u{212A}elvin",
            "kelvin",
            "Kelvin",
            "caf\u{e9}",
            "CAFE",
            "tab\there",
            "a/b-c_d",
            "x\r",
            "",
            "\u{fffd}zanzibar\u{fffd}",
            "i\u{307}",
            "\u{131}d",
        ];
        let patterns = ["plain", "Strict", "kelvin", "cafe", "tab\there", "a/b-c", "x\r", "", "ZANZIBAR", "id", "d"];
        for p in patterns {
            let f = ascii_literal(p).expect(p);
            let finder = memchr::memmem::Finder::new(&f);
            let re = JsRegex::new(p, "i").unwrap();
            for line in lines {
                let fast = finder.find(&line.to_ascii_lowercase().into_bytes()).is_some();
                assert_eq!(fast, re.test(line), "{p:?} on {line:?}");
            }
        }
        for p in ["a.b", "^x", "a|b", "(a)", "[a]", "a{2}", "a+", "a*", "a?", "a$", "\\d", "caf\u{e9}"] {
            assert!(ascii_literal(p).is_none(), "{p:?}");
        }
    }

    #[test]
    fn globs_like_glob_to_regexp() {
        assert!(glob_matches("**/*.ts", "a/b/c.ts"));
        assert!(glob_matches("**/*.ts", "c.ts"));
        assert!(!glob_matches("*.ts", "a/c.ts"));
        assert!(glob_matches("src/**", "src/a/b"));
        assert!(glob_matches("?.md", "a.md"));
        assert!(glob_matches("file(1).txt", "file(1).txt"));
        assert!(!glob_matches("[ab].txt", "a.txt"));
        assert!(glob_matches("[ab].txt", "[ab].txt"));
        // A `?` is one UTF-16 unit, so an emoji needs two.
        assert!(!glob_matches("?.txt", "😀.txt"));
        assert!(glob_matches("??.txt", "😀.txt"));
        assert!(glob_regex(None).is_err());
        assert!(glob_regex(Some(&json!(5))).is_ok());
    }
}
