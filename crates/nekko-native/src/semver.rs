//! Version comparison as electron-updater does it: node-semver's strict
//! `parse` (the `FULL` grammar after `trim()`, at most 256 characters, parts
//! up to `Number.MAX_SAFE_INTEGER`) and its `compare` (main version, then
//! prerelease identifiers, numeric ones numerically and below alphanumeric
//! ones; build metadata ignored). Held to node-semver by
//! `tests/golden/semver.json`, which `semver.golden.test.ts` writes from the
//! real package.

use std::cmp::Ordering;

const MAX_LENGTH: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// One prerelease identifier: numeric (below `MAX_SAFE_INTEGER`, as
/// node-semver numberifies it) or text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ident {
    Num(u64),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<Ident>,
    pub build: Vec<String>,
}

impl std::fmt::Display for Version {
    /// node-semver's `version` (no build metadata).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            let parts: Vec<String> = self
                .pre
                .iter()
                .map(|i| match i {
                    Ident::Num(n) => n.to_string(),
                    Ident::Text(t) => t.clone(),
                })
                .collect();
            write!(f, "-{}", parts.join("."))?;
        }
        Ok(())
    }
}

/// JavaScript's `String.prototype.trim` whitespace (enough for versions).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `0|[1-9]\d*`, ASCII digits only.
fn numeric_part(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    // Longer than u64 is beyond MAX_SAFE_INTEGER anyway.
    let n: u64 = s.parse().ok()?;
    (n <= MAX_SAFE_INTEGER).then_some(n)
}

fn ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

/// `PRERELEASEIDENTIFIER`: `\d*[a-zA-Z-][a-zA-Z0-9-]*` or `0|[1-9]\d*`.
fn pre_ident(s: &str) -> Option<Ident> {
    if s.is_empty() || !s.bytes().all(ident_char) {
        return None;
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        if s.len() > 1 && s.starts_with('0') {
            return None;
        }
        // node-semver keeps an identifier at or past MAX_SAFE_INTEGER as text.
        return Some(match s.parse::<u64>() {
            Ok(n) if n < MAX_SAFE_INTEGER => Ident::Num(n),
            _ => Ident::Text(s.to_string()),
        });
    }
    Some(Ident::Text(s.to_string()))
}

/// `semver.parse(v)`: the version, or `None` where node-semver returns null.
pub fn parse(raw: &str) -> Option<Version> {
    if raw.len() > MAX_LENGTH {
        return None;
    }
    let s = js_trim(raw);
    let s = s.strip_prefix('v').unwrap_or(s);
    let (rest, build) = match s.split_once('+') {
        Some((r, b)) => {
            let parts: Vec<String> = b.split('.').map(str::to_string).collect();
            if parts.iter().any(|p| p.is_empty() || !p.bytes().all(ident_char)) {
                return None;
            }
            (r, parts)
        }
        None => (s, Vec::new()),
    };
    let (main, pre) = match rest.split_once('-') {
        Some((m, p)) => {
            let ids: Option<Vec<Ident>> = p.split('.').map(pre_ident).collect();
            (m, ids?)
        }
        None => (rest, Vec::new()),
    };
    let mut nums = main.split('.');
    let major = numeric_part(nums.next()?)?;
    let minor = numeric_part(nums.next()?)?;
    let patch = numeric_part(nums.next()?)?;
    if nums.next().is_some() {
        return None;
    }
    Some(Version { major, minor, patch, pre, build })
}

/// `compareIdentifiers`.
fn compare_ident(a: &Ident, b: &Ident) -> Ordering {
    match (a, b) {
        (Ident::Num(x), Ident::Num(y)) => x.cmp(y),
        (Ident::Num(_), Ident::Text(_)) => Ordering::Less,
        (Ident::Text(_), Ident::Num(_)) => Ordering::Greater,
        // A numeric-looking text identifier (past MAX_SAFE_INTEGER) compares as a number in JS (`+a`).
        (Ident::Text(x), Ident::Text(y)) => {
            let xn = x.bytes().all(|c| c.is_ascii_digit());
            let yn = y.bytes().all(|c| c.is_ascii_digit());
            match (xn, yn) {
                (true, true) => {
                    let (fx, fy) = (x.parse::<f64>().unwrap_or(0.0), y.parse::<f64>().unwrap_or(0.0));
                    fx.partial_cmp(&fy).unwrap_or(Ordering::Equal)
                }
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                // JS `<` on strings compares UTF-16 code units; identifiers are ASCII.
                (false, false) => x.cmp(y),
            }
        }
    }
}

/// `semver.compare(a, b)`.
pub fn compare(a: &Version, b: &Version) -> Ordering {
    let main = (a.major, a.minor, a.patch).cmp(&(b.major, b.minor, b.patch));
    if main != Ordering::Equal {
        return main;
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => return Ordering::Equal,
        (false, true) => return Ordering::Less,
        (true, false) => return Ordering::Greater,
        _ => {}
    }
    for i in 0.. {
        match (a.pre.get(i), b.pre.get(i)) {
            (None, None) => return Ordering::Equal,
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (Some(x), Some(y)) if x == y => continue,
            (Some(x), Some(y)) => return compare_ident(x, y),
        }
    }
    Ordering::Equal
}

/// Whether electron-updater offers `latest` to an app at `current`
/// (`isUpdateAvailable` without staging, a minimum OS or downgrades:
/// none of those are configured for this app). An unparsable feed version is
/// the error electron-updater raises.
pub fn is_update_available(current: &Version, latest: &str) -> Result<bool, String> {
    let Some(latest) = parse(latest) else {
        return Err(format!(
            "This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: \"{latest}\""
        ));
    };
    Ok(compare(&latest, current) == Ordering::Greater)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_orders_like_node_semver() {
        assert_eq!(parse(" v1.2.3 ").unwrap().to_string(), "1.2.3");
        assert!(parse("1.2").is_none() && parse("01.2.3").is_none() && parse("1.2.3-01").is_none());
        let order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0"];
        for w in order.windows(2) {
            assert_eq!(compare(&parse(w[0]).unwrap(), &parse(w[1]).unwrap()), Ordering::Less, "{w:?}");
        }
        assert_eq!(compare(&parse("1.0.0+a").unwrap(), &parse("1.0.0+b").unwrap()), Ordering::Equal);
    }
}
