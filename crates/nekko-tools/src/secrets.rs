//! A chat's secrets (#2594): values the user typed or pasted into the chat's
//! secret box, which the agent's commands get as environment variables and
//! the agent never reads. Every text the agent could read back (a tool's
//! output, the Agent commands terminal) goes through [`Secrets::redact`],
//! which writes each value as `[secret NAME]`.
//!
//! The values live only in this process's memory: never in a chat file, an
//! event, a log or the audit trail.

use std::sync::{Mutex, PoisonError};

/// Values shorter than this are set in the environment but not hunted for in
/// output: a two-letter value would blank out ordinary words.
pub const MIN_REDACTED_LEN: usize = 4;

/// The longest value accepted: a long PEM key fits, a pasted file does not.
pub const MAX_SECRET_LEN: usize = 16 * 1024;

/// One chat's secrets, by environment variable name, in the order given.
#[derive(Default)]
pub struct Secrets {
    inner: Mutex<Vec<(String, String)>>,
}

impl std::fmt::Debug for Secrets {
    // Names only: a debug print never shows a value.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secrets").field("names", &self.names()).finish()
    }
}

/// Whether `name` can be an environment variable everywhere we run commands:
/// a letter or `_`, then letters, digits and `_`, at most 64 characters.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 64
}

impl Secrets {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set (or replace) `name`. The value is trimmed: a pasted key often
    /// carries a newline. Refuses an invalid name or an empty or oversized value.
    pub fn set(&self, name: &str, value: &str) -> Result<(), String> {
        if !valid_name(name) {
            return Err(format!("{name} is not a valid environment variable name."));
        }
        let value = value.trim();
        if value.is_empty() {
            return Err("The secret is empty.".into());
        }
        if value.len() > MAX_SECRET_LEN {
            return Err("The secret is too long.".into());
        }
        let mut list = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        list.retain(|(n, _)| n != name);
        list.push((name.to_string(), value.to_string()));
        Ok(())
    }

    pub fn names(&self) -> Vec<String> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(n, _)| n.clone()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner).is_empty()
    }

    /// The environment a command gets: every secret, by name.
    pub fn env(&self) -> Vec<crate::gitguard::EnvChange> {
        let list = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        list.iter().map(|(n, v)| (n.clone(), Some(v.clone()))).collect()
    }

    /// `text` with every secret's value, as written and percent-encoded,
    /// replaced by `[secret NAME]`. Longest values first, so a value that
    /// contains another is replaced whole.
    pub fn redact(&self, text: &str) -> String {
        let list = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if list.is_empty() {
            return text.to_string();
        }
        let mut needles: Vec<(String, String)> = Vec::new();
        for (name, value) in list.iter().filter(|(_, v)| v.len() >= MIN_REDACTED_LEN) {
            let mark = format!("[secret {name}]");
            let encoded = percent_encode(value);
            if encoded != *value {
                needles.push((encoded, mark.clone()));
            }
            needles.push((value.clone(), mark));
        }
        needles.sort_by_key(|(v, _)| std::cmp::Reverse(v.len()));
        let mut out = text.to_string();
        for (value, mark) in &needles {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), mark);
            }
        }
        out
    }

    /// The longest value hunted for in output, as [`Secrets::redact`] sees it.
    fn longest(&self) -> usize {
        let list = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        list.iter().map(|(_, v)| percent_encode(v).len().max(v.len())).max().unwrap_or(0)
    }
}

/// `encodeURIComponent`, the form a value takes in a URL's query or path.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Redacts a stream that arrives in chunks (a command's output, as it is
/// mirrored to the Agent commands terminal), so a value split across two
/// chunks is still caught: the last few characters wait for the next chunk
/// or [`StreamRedactor::finish`].
pub struct StreamRedactor<'a> {
    secrets: &'a Secrets,
    hold: usize,
    carry: Mutex<String>,
}

impl<'a> StreamRedactor<'a> {
    pub fn new(secrets: &'a Secrets) -> Self {
        Self { secrets, hold: secrets.longest().saturating_sub(1), carry: Mutex::new(String::new()) }
    }

    /// What can be shown of the stream so far.
    pub fn push(&self, chunk: &str) -> String {
        let mut carry = self.carry.lock().unwrap_or_else(PoisonError::into_inner);
        carry.push_str(chunk);
        let redacted = self.secrets.redact(&carry);
        if self.hold == 0 || redacted.len() <= self.hold {
            if self.hold == 0 {
                carry.clear();
                return redacted;
            }
            *carry = redacted;
            return String::new();
        }
        let mut cut = redacted.len() - self.hold;
        while !redacted.is_char_boundary(cut) {
            cut -= 1;
        }
        let (shown, kept) = redacted.split_at(cut);
        let shown = shown.to_string();
        *carry = kept.to_string();
        shown
    }

    /// The rest of the stream, once it has ended.
    pub fn finish(&self) -> String {
        let mut carry = self.carry.lock().unwrap_or_else(PoisonError::into_inner);
        let out = self.secrets.redact(&carry);
        carry.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(pairs: &[(&str, &str)]) -> Secrets {
        let s = Secrets::new();
        for (n, v) in pairs {
            s.set(n, v).unwrap();
        }
        s
    }

    #[test]
    fn names_must_be_environment_variables() {
        for ok in ["OPENAI_API_KEY", "_X", "a1"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A B", "$A", &"A".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(Secrets::new().set("A B", "value").is_err());
        assert!(Secrets::new().set("A", "  \n").is_err());
    }

    #[test]
    fn values_are_trimmed_and_replaced_by_name() {
        let s = with(&[("TOKEN", " sk-live-123456\n")]);
        assert_eq!(s.env(), vec![("TOKEN".to_string(), Some("sk-live-123456".to_string()))]);
        assert_eq!(s.redact("key=sk-live-123456 done"), "key=[secret TOKEN] done");
        s.set("TOKEN", "other-value").unwrap();
        assert_eq!(s.names(), ["TOKEN"]);
        assert_eq!(s.redact("sk-live-123456 other-value"), "sk-live-123456 [secret TOKEN]");
    }

    #[test]
    fn a_url_encoded_value_is_caught_too() {
        let s = with(&[("PASS", "p@ss word!")]);
        assert_eq!(s.redact("https://x/?p=p%40ss%20word!"), "https://x/?p=[secret PASS]");
    }

    #[test]
    fn the_longer_value_wins() {
        let s = with(&[("SHORT", "abcd"), ("LONG", "abcdefgh")]);
        assert_eq!(s.redact("abcdefgh abcd"), "[secret LONG] [secret SHORT]");
    }

    #[test]
    fn short_values_are_not_hunted() {
        let s = with(&[("PIN", "123")]);
        assert_eq!(s.redact("call 123"), "call 123");
        assert_eq!(s.env().len(), 1);
    }

    #[test]
    fn debug_never_prints_a_value() {
        let s = with(&[("TOKEN", "sk-live-123456")]);
        assert!(!format!("{s:?}").contains("sk-live"));
    }

    #[test]
    fn a_value_split_across_chunks_is_still_caught() {
        let s = with(&[("TOKEN", "sk-live-123456")]);
        let r = StreamRedactor::new(&s);
        let mut shown = String::new();
        for chunk in ["export sk-li", "ve-12", "3456 and é more", "\n"] {
            shown.push_str(&r.push(chunk));
        }
        shown.push_str(&r.finish());
        assert_eq!(shown, "export [secret TOKEN] and é more\n");
    }

    #[test]
    fn with_no_secrets_the_stream_passes_straight_through() {
        let s = Secrets::new();
        let r = StreamRedactor::new(&s);
        assert_eq!(r.push("hello"), "hello");
        assert_eq!(r.finish(), "");
    }
}
