//! Node's `path` module, ported line for line from Node 24's `lib/path.js`.
//!
//! Every path a tool prints, and every sandbox decision, is made on strings by
//! `path.resolve` and `path.relative`, not by the filesystem. Rust's `Path`
//! disagrees with them in places that matter here: it keeps `..` components
//! instead of folding them, treats `\foo` as relative on Windows (Node puts it
//! on the current drive), and compares Windows paths case-sensitively (Node's
//! `relative` lowercases them). So the jail check and the printed paths use
//! these ports, and only the final string is handed to the filesystem.
//!
//! Both flavours build on every platform, like `path.win32` and `path.posix`,
//! so either can be tested anywhere; [`native`] is the one Node would pick.

mod posix_impl;
mod win32_impl;

pub(crate) type U16 = Vec<u16>;

pub(crate) const SLASH: u16 = b'/' as u16;
pub(crate) const BACKSLASH: u16 = b'\\' as u16;
pub(crate) const DOT: u16 = b'.' as u16;
pub(crate) const COLON: u16 = b':' as u16;

pub(crate) fn units(s: &str) -> U16 {
    s.encode_utf16().collect()
}

pub(crate) fn string(u: &[u16]) -> String {
    String::from_utf16_lossy(u)
}

/// `str.charCodeAt(i) === c`, which is false past the end.
pub(crate) fn at(p: &[u16], i: usize, c: u16) -> bool {
    p.get(i) == Some(&c)
}

pub(crate) fn last_index_of(p: &[u16], c: u16) -> Option<usize> {
    p.iter().rposition(|&x| x == c)
}

/// `normalizeString` from `lib/path.js`: fold `.` and `..` segments.
pub(crate) fn normalize_string(path: &[u16], allow_above_root: bool, sep: u16, is_sep: fn(u16) -> bool) -> U16 {
    let mut res: U16 = Vec::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u16 = 0;
    for i in 0..=path.len() {
        if i < path.len() {
            code = path[i];
        } else if is_sep(code) {
            break;
        } else {
            code = SLASH;
        }
        let ii = i as isize;
        if is_sep(code) {
            if last_slash == ii - 1 || dots == 1 {
                // A repeated separator or a `.` segment: nothing to add.
            } else if dots == 2 {
                let ends_in_dotdot = res.len() >= 2
                    && last_segment_length == 2
                    && res[res.len() - 1] == DOT
                    && res[res.len() - 2] == DOT;
                if !ends_in_dotdot {
                    if res.len() > 2 {
                        match last_index_of(&res, sep) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(idx) => {
                                res.truncate(idx);
                                let last = last_index_of(&res, sep).map_or(-1, |x| x as isize);
                                last_segment_length = res.len() as isize - 1 - last;
                            }
                        }
                        last_slash = ii;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = ii;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(sep);
                    }
                    res.extend_from_slice(&[DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(sep);
                }
                res.extend_from_slice(&path[(last_slash + 1) as usize..i]);
                last_segment_length = ii - last_slash - 1;
            }
            last_slash = ii;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

fn win_sep(c: u16) -> bool {
    c == SLASH || c == BACKSLASH
}

fn posix_sep(c: u16) -> bool {
    c == SLASH
}

fn device_root(c: u16) -> bool {
    (b'a' as u16..=b'z' as u16).contains(&c) || (b'A' as u16..=b'Z' as u16).contains(&c)
}

/// `path.posix.dirname` / `path.win32.dirname` from `lib/path.js`.
pub(crate) fn dirname_units(path: &[u16], win: bool) -> U16 {
    let is_sep: fn(u16) -> bool = if win { win_sep } else { posix_sep };
    let len = path.len();
    if len == 0 {
        return vec![DOT];
    }
    if !win {
        let has_root = path[0] == SLASH;
        let mut end: Option<usize> = None;
        let mut matched_slash = true;
        for i in (1..len).rev() {
            if path[i] == SLASH {
                if !matched_slash {
                    end = Some(i);
                    break;
                }
            } else {
                matched_slash = false;
            }
        }
        return match end {
            None if has_root => vec![SLASH],
            None => vec![DOT],
            Some(1) if has_root => vec![SLASH, SLASH],
            Some(e) => path[..e].to_vec(),
        };
    }
    let mut root_end: Option<usize> = None;
    let mut offset = 0;
    let code = path[0];
    if len == 1 {
        return if is_sep(code) { path.to_vec() } else { vec![DOT] };
    }
    if is_sep(code) {
        root_end = Some(1);
        offset = 1;
        if is_sep(path[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        return path.to_vec();
                    }
                    if j != last {
                        root_end = Some(j + 1);
                        offset = j + 1;
                    }
                }
            }
        }
    } else if device_root(code) && path[1] == COLON {
        let r = if len > 2 && is_sep(path[2]) { 3 } else { 2 };
        root_end = Some(r);
        offset = r;
    }
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (offset..len).rev() {
        if is_sep(path[i]) {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end.or(root_end) {
        Some(e) => path[..e].to_vec(),
        None => vec![DOT],
    }
}

/// `path.posix.basename` / `path.win32.basename` (no suffix) from `lib/path.js`.
pub(crate) fn basename_units(path: &[u16], win: bool) -> U16 {
    let is_sep: fn(u16) -> bool = if win { win_sep } else { posix_sep };
    let mut start = 0;
    if win && path.len() >= 2 && path[1] == COLON && device_root(path[0]) {
        start = 2;
    }
    let mut first = start;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (start..path.len()).rev() {
        if is_sep(path[i]) {
            if !matched_slash {
                first = i + 1;
                break;
            }
        } else if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
    }
    match end {
        Some(e) => path[first..e].to_vec(),
        None => Vec::new(),
    }
}

/// `path.posix.extname` / `path.win32.extname` from `lib/path.js`.
pub(crate) fn extname_units(path: &[u16], win: bool) -> U16 {
    let is_sep: fn(u16) -> bool = if win { win_sep } else { posix_sep };
    let mut start = 0;
    let mut start_part = 0;
    if win && path.len() >= 2 && path[1] == COLON && device_root(path[0]) {
        start = 2;
        start_part = 2;
    }
    let mut start_dot: Option<usize> = None;
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    // 0: no dot run seen before the last dot, 1: only dots, -1: something else.
    let mut pre_dot_state = 0;
    for i in (start..path.len()).rev() {
        let code = path[i];
        if is_sep(code) {
            if !matched_slash {
                start_part = i + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_slash = false;
            end = Some(i + 1);
        }
        if code == DOT {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(d), Some(e)) if pre_dot_state != 0 && !(pre_dot_state == 1 && d + 1 == e && d == start_part + 1) => {
            path[d..e].to_vec()
        }
        _ => Vec::new(),
    }
}

/// The process working directory as Node reports it.
pub(crate) fn process_cwd() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into())
}

/// `path.win32`.
pub mod win32 {
    use super::{string, units, win32_impl as imp};

    /// `path.win32.resolve(...parts)`.
    pub fn resolve(parts: &[&str]) -> String {
        let parts: Vec<_> = parts.iter().map(|p| units(p)).collect();
        let cwd = || units(&super::process_cwd());
        let drive_cwd = |device: &[u16]| std::env::var(format!("={}", string(device))).ok().map(|s| units(&s));
        string(&imp::resolve(&parts, &cwd, &drive_cwd))
    }

    /// `path.win32.relative(from, to)`.
    pub fn relative(from: &str, to: &str) -> String {
        if from == to {
            return String::new();
        }
        string(&imp::relative(&units(&resolve(&[from])), &units(&resolve(&[to]))))
    }

    /// `path.win32.isAbsolute(p)`.
    pub fn is_absolute(p: &str) -> bool {
        imp::is_absolute(&units(p))
    }

    /// `path.win32.normalize(p)`.
    pub fn normalize(p: &str) -> String {
        string(&imp::normalize(&units(p)))
    }

    /// `path.win32.basename(p)`.
    pub fn basename(p: &str) -> String {
        string(&super::basename_units(&units(p), true))
    }

    /// `path.win32.dirname(p)`.
    pub fn dirname(p: &str) -> String {
        string(&super::dirname_units(&units(p), true))
    }

    /// `path.win32.extname(p)`.
    pub fn extname(p: &str) -> String {
        string(&super::extname_units(&units(p), true))
    }

    /// `path.win32.join(...parts)`.
    pub fn join(parts: &[&str]) -> String {
        let parts: Vec<_> = parts.iter().map(|p| units(p)).collect();
        string(&imp::join(&parts))
    }
}

/// `path.posix`.
pub mod posix {
    use super::{posix_impl as imp, string, units};

    /// Node's `posixCwd`: on Windows, the drive-less, slash form of the cwd.
    fn cwd() -> super::U16 {
        let cwd = super::process_cwd();
        if cfg!(windows) {
            let s = cwd.replace('\\', "/");
            let from = s.find('/').unwrap_or(s.len());
            units(&s[from..])
        } else {
            units(&cwd)
        }
    }

    /// `path.posix.resolve(...parts)`.
    pub fn resolve(parts: &[&str]) -> String {
        let parts: Vec<_> = parts.iter().map(|p| units(p)).collect();
        string(&imp::resolve(&parts, &cwd))
    }

    /// `path.posix.relative(from, to)`.
    pub fn relative(from: &str, to: &str) -> String {
        if from == to {
            return String::new();
        }
        string(&imp::relative(&units(&resolve(&[from])), &units(&resolve(&[to]))))
    }

    /// `path.posix.isAbsolute(p)`.
    pub fn is_absolute(p: &str) -> bool {
        imp::is_absolute(&units(p))
    }

    /// `path.posix.normalize(p)`.
    pub fn normalize(p: &str) -> String {
        string(&imp::normalize(&units(p)))
    }

    /// `path.posix.basename(p)`.
    pub fn basename(p: &str) -> String {
        string(&super::basename_units(&units(p), false))
    }

    /// `path.posix.dirname(p)`.
    pub fn dirname(p: &str) -> String {
        string(&super::dirname_units(&units(p), false))
    }

    /// `path.posix.extname(p)`.
    pub fn extname(p: &str) -> String {
        string(&super::extname_units(&units(p), false))
    }

    /// `path.posix.join(...parts)`.
    pub fn join(parts: &[&str]) -> String {
        let parts: Vec<_> = parts.iter().map(|p| units(p)).collect();
        string(&imp::join(&parts))
    }
}

/// The flavour Node uses on this platform (`require('path')`).
#[cfg(windows)]
pub use win32 as native;

/// The flavour Node uses on this platform (`require('path')`).
#[cfg(not(windows))]
pub use posix as native;
