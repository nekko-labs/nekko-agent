//! `new RegExp(source, flags)` as V8 runs it.
//!
//! Guardrail rules, `grep` and `glob` all go through JavaScript regular
//! expressions in the TS host, without the `u` flag. Rust's `regex` crate
//! differs from that in ways a guardrail would notice: its `\b`, `\s` and `.`
//! are Unicode-aware, `(?i)` folds `ſ` to `s` and the Kelvin sign to `k`
//! (JavaScript's non-Unicode case-insensitivity does neither), and it has no
//! lookaround or backreferences, which user-authored rules may use. `regress`
//! implements ECMAScript's syntax and semantics, and matching over UTF-16 code
//! units as UCS-2 is what a non-`u` pattern does in V8, down to `.` matching
//! half of an emoji.
//!
//! One gap in `regress` is closed here. Without `u`, ECMAScript's `i` compares
//! characters by their single-character uppercase and never lets a non-ASCII
//! character match an ASCII one, so `/s/i` does not match `ſ`. `regress` uses
//! the Unicode tables instead, and merges 40 characters into case classes
//! JavaScript keeps them out of (found by comparing every BMP character's
//! matches against V8's). In every one of them `regress` matches more than V8,
//! never less, so those characters are swapped for code units no input can
//! contain in that position (a low surrogate with no high one before it) in
//! both the pattern and the text, where they can only match themselves.
//! What stays different: a class range written across one of them (Latin
//! Extended-A as a range, say) no longer covers it.

use std::ops::Range;

/// Characters V8 keeps apart under non-`u` `i` that `regress` would fold,
/// sorted: dotless i, long s, the Kelvin, Angstrom and Ohm signs, capital
/// sharp s, capital theta symbol, the Greek capitals with prosgegrammeni and
/// two iota-dialytika forms, the `st` ligature, and three letters Unicode 16
/// added whose case mappings V8 does not know yet.
const CASE_ISOLATED: [u16; 40] = [
    0x0131, 0x017F, 0x03F4, 0x1E9E, 0x1F88, 0x1F89, 0x1F8A, 0x1F8B, 0x1F8C, 0x1F8D, 0x1F8E, 0x1F8F, 0x1F98, 0x1F99,
    0x1F9A, 0x1F9B, 0x1F9C, 0x1F9D, 0x1F9E, 0x1F9F, 0x1FA8, 0x1FA9, 0x1FAA, 0x1FAB, 0x1FAC, 0x1FAD, 0x1FAE, 0x1FAF,
    0x1FBC, 0x1FCC, 0x1FD3, 0x1FE3, 0x1FFC, 0x2126, 0x212A, 0x212B, 0xA7CF, 0xA7D3, 0xA7D5, 0xFB06,
];

/// The stand-in for an isolated character: a low surrogate. Text that came
/// from a valid string only has low surrogates right after high ones, and an
/// isolated character is a BMP character, never the second half of a pair.
fn isolate(c: u16) -> u16 {
    match CASE_ISOLATED.binary_search(&c) {
        Ok(k) => 0xDC00 + k as u16,
        Err(_) => c,
    }
}

fn hex(u: u16) -> Option<u16> {
    char::from_u32(u32::from(u)).and_then(|c| c.to_digit(16)).map(|d| d as u16)
}

/// Swap isolated characters in a pattern, written literally or as `\uXXXX`.
fn isolate_source(src: &[u16]) -> Vec<u16> {
    let backslash = u16::from(b'\\');
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        if c == backslash && i + 1 < src.len() {
            if src[i + 1] == u16::from(b'u')
                && let Some(v) =
                    src.get(i + 2..i + 6).and_then(|h| h.iter().try_fold(0u16, |acc, &d| Some(acc * 16 + hex(d)?)))
                && isolate(v) != v
            {
                out.push(isolate(v));
                i += 6;
                continue;
            }
            // Any other escape passes through whole, so `\\` is never misread.
            out.extend_from_slice(&src[i..i + 2]);
            i += 2;
            continue;
        }
        out.push(isolate(c));
        i += 1;
    }
    out
}

pub struct JsRegex {
    re: regress::Regex,
    /// Whether the text needs the same swap as the pattern (only with `i`).
    isolated: bool,
}

impl JsRegex {
    /// Compile `source` (a JavaScript string, so read as UTF-16 code units).
    pub fn new(source: &str, flags: &str) -> Result<Self, String> {
        let units: Vec<u16> = source.encode_utf16().collect();
        Self::from_units(&units, flags)
    }

    pub fn from_units(units: &[u16], flags: &str) -> Result<Self, String> {
        let isolated = flags.contains('i') && !flags.contains('u');
        let owned;
        let units = if isolated {
            owned = isolate_source(units);
            &owned
        } else {
            units
        };
        regress::Regex::from_unicode(units.iter().map(|&u| u32::from(u)), flags)
            .map(|re| JsRegex { re, isolated })
            .map_err(|e| e.to_string())
    }

    /// `re.exec(text)`: the first match, as a range of UTF-16 code units
    /// (valid for `text` itself, since the swap is unit for unit).
    pub fn find(&self, text: &[u16]) -> Option<Range<usize>> {
        if self.isolated && text.iter().any(|&c| isolate(c) != c) {
            let swapped: Vec<u16> = text.iter().map(|&c| isolate(c)).collect();
            return self.re.find_from_ucs2(&swapped, 0).next().map(|m| m.range());
        }
        self.re.find_from_ucs2(text, 0).next().map(|m| m.range())
    }

    /// `re.exec(text)` with its groups: index 0 is the whole match, a group
    /// that took no part is `None`.
    pub fn exec(&self, text: &[u16]) -> Option<Vec<Option<Range<usize>>>> {
        let m = if self.isolated && text.iter().any(|&c| isolate(c) != c) {
            let swapped: Vec<u16> = text.iter().map(|&c| isolate(c)).collect();
            self.re.find_from_ucs2(&swapped, 0).next()
        } else {
            self.re.find_from_ucs2(text, 0).next()
        }?;
        Some(std::iter::once(Some(m.range())).chain(m.captures.iter().cloned()).collect())
    }

    /// `re.test(text)`.
    pub fn test(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.find(&units).is_some()
    }

    /// `text.replace(/re/g, fn)` over UTF-16 code units: every match, left to
    /// right, replaced by what `f` returns for its groups (index 0 is the
    /// whole match; a group that took no part is `None`, as `undefined`).
    pub fn replace_all(&self, text: &[u16], mut f: impl FnMut(&[Option<&[u16]>]) -> Vec<u16>) -> Vec<u16> {
        let swapped: Option<Vec<u16>> = (self.isolated && text.iter().any(|&c| isolate(c) != c))
            .then(|| text.iter().map(|&c| isolate(c)).collect());
        let haystack = swapped.as_deref().unwrap_or(text);
        let mut out = Vec::with_capacity(text.len());
        let mut last = 0;
        for m in self.re.find_from_ucs2(haystack, 0) {
            let range = m.range();
            if range.start < last {
                continue;
            }
            let groups: Vec<Option<&[u16]>> = std::iter::once(Some(range.clone()))
                .chain(m.captures.iter().cloned())
                .map(|g| g.map(|r| &text[r]))
                .collect();
            out.extend_from_slice(&text[last..range.start]);
            out.extend(f(&groups));
            last = range.end;
        }
        out.extend_from_slice(&text[last..]);
        out
    }

    /// [`JsRegex::replace_all`] with a fixed replacement (no `$` patterns).
    pub fn replace_all_with(&self, text: &[u16], replacement: &str) -> Vec<u16> {
        let rep: Vec<u16> = replacement.encode_utf16().collect();
        self.replace_all(text, |_| rep.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(p: &str, flags: &str, s: &str) -> bool {
        JsRegex::new(p, flags).unwrap().test(s)
    }

    #[test]
    fn behaves_like_a_non_unicode_javascript_regexp() {
        // ASCII word boundary: `ä` is not a word character in JavaScript.
        assert!(matches(r"\brm\b", "i", "ärm -rf"));
        assert!(matches("é", "i", "É"));
        // `.` excludes the four line terminators but not U+0085.
        assert!(!matches("a.b", "", "a\u{2028}b"));
        assert!(matches("a.b", "", "a\u{85}b"));
        // A non-`u` `.` is one code unit.
        assert!(!matches("a.b", "", "a😀b"));
        assert!(matches("a..b", "", "a😀b"));
        // Lookaround and backreferences.
        assert!(matches(r"(\w+) \1", "", "go go"));
        assert!(matches(r"deploy(?! --dry)", "", "deploy now"));
        assert!(!matches(r"deploy(?! --dry)", "", "deploy --dry"));
    }

    #[test]
    fn keeps_the_characters_javascript_keeps_apart() {
        // Each pair: V8 says no match under /i (checked in node).
        for (p, s) in [
            ("s", "\u{17F}"),
            ("[a-z]", "\u{17F}"),
            ("k", "\u{212A}"),
            ("[k]", "\u{212A}"),
            ("i", "\u{131}"),
            ("\u{17F}", "S"),
            ("ß", "\u{1E9E}"),
            ("[ß]", "\u{1E9E}"),
            ("å", "\u{212B}"),
            ("[ω]", "\u{2126}"),
            ("\u{1F80}", "\u{1F88}"),
            ("[θ]", "\u{3F4}"),
            ("sudo", "\u{17F}udo"),
        ] {
            assert!(!matches(p, "i", s), "{p:?} matched {s:?}");
        }
        // ...and each still matches itself, literally or escaped.
        let escaped = |hex: &str| format!("{}u{hex}", '\\');
        for (p, s) in [
            ("\u{17F}".to_string(), "\u{17F}"),
            (escaped("017F"), "\u{17F}"),
            (escaped("017f"), "x\u{17F}"),
            ("[\u{212A}]".to_string(), "\u{212A}"),
        ] {
            assert!(matches(&p, "i", s), "{p:?} missed {s:?}");
        }
        // An escaped backslash is not an escape.
        assert!(matches(&format!("{}{}", '\\', escaped("017F")), "i", &escaped("017F")));
        // Case folding that V8 does apply is untouched.
        assert!(matches("µ", "i", "\u{39C}"));
        assert!(matches("[θ]", "i", "\u{3D1}"));
        assert!(matches("SUDO", "i", "sudo"));
    }
}
