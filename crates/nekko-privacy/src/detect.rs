//! What counts as private, and where it is in a piece of text.
//!
//! Every detector is deterministic and runs on this machine: regular
//! expressions with a validating check where a shape alone is too loose
//! (Luhn for card numbers, the check digit for a My Number, the reserved
//! ranges for an IP), plus the user's own words and the computer's account
//! name in home-folder paths. Nothing here calls a model, so nothing here can
//! leak what it is looking at.

use std::sync::OnceLock;

/// A kind of private value. `id` is the wire and settings name; `label` is
/// what its placeholder says (`[PII_EMAIL_1]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Email,
    Phone,
    Card,
    Ssn,
    MyNumber,
    Ip,
    Secret,
    User,
    Term,
}

impl Kind {
    pub const ALL: [Kind; 9] = [
        Kind::Email,
        Kind::Phone,
        Kind::Card,
        Kind::Ssn,
        Kind::MyNumber,
        Kind::Ip,
        Kind::Secret,
        Kind::User,
        Kind::Term,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Kind::Email => "email",
            Kind::Phone => "phone",
            Kind::Card => "card",
            Kind::Ssn => "ssn",
            Kind::MyNumber => "my-number",
            Kind::Ip => "ip",
            Kind::Secret => "secret",
            Kind::User => "username",
            Kind::Term => "term",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Email => "EMAIL",
            Kind::Phone => "PHONE",
            Kind::Card => "CARD",
            Kind::Ssn => "SSN",
            Kind::MyNumber => "MYNUMBER",
            Kind::Ip => "IP",
            Kind::Secret => "SECRET",
            Kind::User => "USER",
            Kind::Term => "TERM",
        }
    }

    pub fn from_id(id: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.id() == id)
    }
}

/// One private value in a text, as byte offsets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

struct Rule {
    kind: Kind,
    re: regress::Regex,
    /// The capture group that is the private part (0: the whole match).
    group: usize,
    check: fn(&str) -> bool,
}

fn any(_: &str) -> bool {
    true
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let rule = |kind, src: &str, flags: &str, group, check| Rule {
            kind,
            re: regress::Regex::with_flags(src, flags).expect("privacy pattern compiles"),
            group,
            check,
        };
        vec![
            // Secrets first: a key inside a URL or an assignment wins over the
            // email or IP that may sit beside it.
            rule(Kind::Secret, r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", "", 0, any),
            rule(
                Kind::Secret,
                r"(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})",
                "",
                0,
                any,
            ),
            // https://user:password@host: the password only.
            rule(Kind::Secret, r"[a-z][a-z0-9+.-]*://[^/\s:@]+:([^/\s@]+)@", "i", 1, any),
            // password: "hunter22", "api_key" = 'abc123': a quoted literal only,
            // so `password: string` and `password = read()` stay code.
            rule(
                Kind::Secret,
                r#"(?<![A-Za-z0-9])(?:password|passwd|passphrase|api[_-]?key|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|secret[_-]?access[_-]?key)["']?\s*[:=]\s*(["'])([^"'\s]{4,})\1"#,
                "i",
                2,
                any,
            ),
            // DB_PASSWORD=..., export GITHUB_TOKEN=... in env files and shells.
            rule(
                Kind::Secret,
                r#"^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*["']?([^\s"'#]{4,})"#,
                "m",
                1,
                |v| !v.starts_with('$') && !v.starts_with('<'),
            ),
            rule(
                Kind::Email,
                r"(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])",
                "",
                0,
                |v| !v.starts_with("git@"),
            ),
            rule(Kind::Card, r"(?<![\d-])(?:\d{4}[ -]){3}\d{1,7}(?![\d-])", "", 0, luhn_card),
            rule(Kind::Card, r"(?<![\w-])(?:4\d{15}|5[1-5]\d{14}|2[2-7]\d{14}|3[47]\d{13}|6(?:011|5\d\d)\d{12}|35\d{14})(?![\w-])", "", 0, luhn_card),
            rule(Kind::MyNumber, r"(?<![\w-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\w-])", "", 0, my_number),
            rule(Kind::Ssn, r"(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])", "", 0, ssn),
            // +81 90-1234-5678, +1 (415) 555-0100, +44 20 7946 0958
            rule(Kind::Phone, r"(?<![\w+])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w-])", "", 0, phone_digits),
            // (415) 555-0100, 415-555-0100, 090-1234-5678, 03-1234-5678
            rule(
                Kind::Phone,
                r"(?<![\w.-])(?:\(\d{3}\)[ ]?\d{3}-\d{4}|\d{3}[-.]\d{3}[-.]\d{4}|0\d{1,4}-\d{1,4}-\d{4})(?![\w-])",
                "",
                0,
                phone_digits,
            ),
            rule(
                Kind::Ip,
                r"(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])",
                "",
                0,
                public_ip,
            ),
        ]
    })
}

fn digits(s: &str) -> Vec<u32> {
    s.chars().filter_map(|c| c.to_digit(10)).collect()
}

fn luhn_card(s: &str) -> bool {
    let d = digits(s);
    if !(13..=19).contains(&d.len()) || d.iter().all(|x| *x == d[0]) {
        return false;
    }
    let sum: u32 = d
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &x)| if !i.is_multiple_of(2) { if x * 2 > 9 { x * 2 - 9 } else { x * 2 } } else { x })
        .sum();
    sum.is_multiple_of(10)
}

/// The individual number's check digit (マイナンバー, the 12th digit).
fn my_number(s: &str) -> bool {
    let d = digits(s);
    if d.len() != 12 || d.iter().all(|x| *x == d[0]) {
        return false;
    }
    // P_n is the n-th digit from the right, not counting the check digit.
    let sum: u32 = (1..=11).map(|n| d[11 - n] * if n <= 6 { n as u32 + 1 } else { n as u32 - 5 }).sum();
    let r = sum % 11;
    let check = if r <= 1 { 0 } else { 11 - r };
    d[11] == check
}

fn ssn(s: &str) -> bool {
    let area: u32 = s[0..3].parse().unwrap_or(0);
    let group = &s[4..6];
    let serial = &s[7..11];
    area != 0 && area != 666 && area < 900 && group != "00" && serial != "0000"
}

fn phone_digits(s: &str) -> bool {
    (9..=15).contains(&digits(s).len())
}

/// Loopback, unspecified, broadcast and private (RFC 1918) and link-local
/// ranges say nothing about a person and turn up all over code.
fn public_ip(s: &str) -> bool {
    let o: Vec<u32> = s.split('.').filter_map(|p| p.parse().ok()).collect();
    if o.len() != 4 {
        return false;
    }
    !(o[0] == 0
        || o[0] == 10
        || o[0] == 127
        || o[0] >= 224
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 169 && o[1] == 254))
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `name` where it is a home folder: `/Users/name`, `/home/name`, `C:\Users\name`.
fn find_usernames(text: &str, name: &str, out: &mut Vec<Span>) {
    if name.chars().count() < 2 {
        return;
    }
    for (i, _) in text.match_indices(name) {
        let end = i + name.len();
        if text[end..].chars().next().is_some_and(|c| word_char(c) || c == '-' || c == '.') {
            continue;
        }
        let before = text[..i].trim_end_matches(['/', '\\']);
        let seps = i - before.len();
        if !(1..=2).contains(&seps) {
            continue;
        }
        let lower = before.to_ascii_lowercase();
        if lower.ends_with("users") || lower.ends_with("/home") || lower.ends_with("\\home") {
            out.push(Span { start: i, end, kind: Kind::User });
        }
    }
}

/// The user's own words (a client, a codename, their name), case-insensitive
/// and whole-word where the term starts or ends with a letter or digit.
fn find_term(text: &str, term: &str, out: &mut Vec<Span>) {
    let term = term.trim();
    if term.chars().count() < 2 {
        return;
    }
    let (hay, needle) = if term.is_ascii() {
        (text.to_ascii_lowercase(), term.to_ascii_lowercase())
    } else {
        (text.to_string(), term.to_string())
    };
    let first = needle.chars().next().is_some_and(word_char);
    let last = needle.chars().last().is_some_and(word_char);
    for (i, _) in hay.match_indices(&needle) {
        let end = i + needle.len();
        if first && text[..i].chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        if last && text[end..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        out.push(Span { start: i, end, kind: Kind::Term });
    }
}

/// Every private value in `text` of a kind `on` lets through, in order and
/// not overlapping.
pub fn scan(text: &str, on: &dyn Fn(Kind) -> bool, usernames: &[String], terms: &[String]) -> Vec<Span> {
    let mut found = Vec::new();
    if on(Kind::Term) {
        for term in terms {
            find_term(text, term, &mut found);
        }
    }
    if on(Kind::User) {
        for name in usernames {
            find_usernames(text, name, &mut found);
        }
    }
    for rule in rules().iter().filter(|r| on(r.kind)) {
        for m in rule.re.find_iter(text) {
            let Some(range) = m.group(rule.group) else { continue };
            if range.is_empty() || !(rule.check)(&text[range.clone()]) {
                continue;
            }
            found.push(Span { start: range.start, end: range.end, kind: rule.kind });
        }
    }
    // Earlier detectors win an overlap (the user's terms, then secrets, then
    // the rest in rule order); among one detector's own, the first.
    let mut out: Vec<Span> = Vec::with_capacity(found.len());
    for span in found {
        if out.iter().all(|kept| span.end <= kept.start || span.start >= kept.end) {
            out.push(span);
        }
    }
    out.sort_by_key(|s| s.start);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<(Kind, &str)> {
        scan(text, &|_| true, &["philip".into()], &["Acme Corp".into()])
            .into_iter()
            .map(|s| (s.kind, &text[s.start..s.end]))
            .collect()
    }

    #[test]
    fn finds_each_kind() {
        let cases: &[(&str, Kind, &str)] = &[
            ("mail jane.doe+x@example.co.jp now", Kind::Email, "jane.doe+x@example.co.jp"),
            ("call +81 90-1234-5678 today", Kind::Phone, "+81 90-1234-5678"),
            ("call (415) 555-0100 today", Kind::Phone, "(415) 555-0100"),
            ("携帯 090-1234-5678 です", Kind::Phone, "090-1234-5678"),
            ("card 4111 1111 1111 1111 exp", Kind::Card, "4111 1111 1111 1111"),
            ("card 4111111111111111 exp", Kind::Card, "4111111111111111"),
            ("ssn 123-45-6789.", Kind::Ssn, "123-45-6789"),
            ("my number 1234 5678 9018", Kind::MyNumber, "1234 5678 9018"),
            ("host 8.8.4.4 up", Kind::Ip, "8.8.4.4"),
            ("key sk-ant-api03-abcdefghijklmnopqrstu end", Kind::Secret, "sk-ant-api03-abcdefghijklmnopqrstu"),
            ("{ \"password\": \"hunter22\" }", Kind::Secret, "hunter22"),
            ("DB_PASSWORD=s3cretpass\n", Kind::Secret, "s3cretpass"),
            ("https://bob:pa55word@git.example.com/x", Kind::Secret, "pa55word"),
            ("open /Users/philip/code/app.ts", Kind::User, "philip"),
            ("open C:\\Users\\philip\\code", Kind::User, "philip"),
            ("for acme corp, again", Kind::Term, "acme corp"),
        ];
        for (text, kind, value) in cases {
            assert_eq!(kinds(text), vec![(*kind, *value)], "{text}");
        }
    }

    #[test]
    fn leaves_code_alone() {
        for text in [
            "git@github.com:nekko-labs/nekko-agent.git",
            "const password: string = read();",
            "export DB_PASSWORD=$SECRET_FROM_VAULT",
            "listen on 127.0.0.1:8080 or 192.168.1.20 or 10.0.0.2",
            // A bare 1.2.3.4 is also a real address, so only a `v`-prefixed version is safe.
            "release v10.20.30.40",
            "released 2026-10-22, ts 1729584000000",
            "id 1234567812345678 is not a card",
            "an array [1, 2, 3] and 123-45-678",
            "philip wrote /home/philipa/x and philosophy",
            "acmecorp is one word",
            "the 555-0100 extension",
        ] {
            assert_eq!(kinds(text), vec![], "{text}");
        }
    }

    #[test]
    fn checks_the_my_number_digit() {
        assert!(my_number("123456789018"));
        assert!(!my_number("123456789012"));
    }

    #[test]
    fn honors_the_kind_switch() {
        let text = "a@b.io 8.8.8.8";
        let only_ip = scan(text, &|k| k == Kind::Ip, &[], &[]);
        assert_eq!(only_ip.len(), 1);
        assert_eq!(only_ip[0].kind, Kind::Ip);
    }
}
