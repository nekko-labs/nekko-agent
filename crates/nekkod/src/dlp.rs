//! Outbound DLP (decision 0064): before a call can carry data off this
//! computer, look in what it carries for the values the Privacy Shield
//! recognises (keys and tokens, passwords, card numbers, government ids,
//! email addresses, phone numbers, the user's own private terms).
//!
//! The gate then asks, naming the kind ("an API key or token") and never the
//! value. It reads the arguments of every MCP call, read-only ones too (a
//! search query reaches the search engine), and the address of a `fetch_url`.
//! Recipient arguments are left to the recipient rule (decision 0063), so an
//! always-allowed tool writing to a known address does not ask every time.
//!
//! It only knows what the Shield's detectors know: a secret with no
//! recognisable shape gets through.

use nekko_privacy::Kind;
use serde_json::Value;

/// The kinds that ask. Not the account name in paths (file arguments carry it
/// all the time) and not IP addresses (an address may be the host itself).
fn counts(kind: Kind) -> bool {
    !matches!(kind, Kind::User | Kind::Ip)
}

/// The kinds of private value in a call's arguments, each once, in the
/// detectors' order. Recipient arguments are skipped.
pub fn in_input(input: &Value, terms: &[String]) -> Vec<Kind> {
    let mut texts = Vec::new();
    strings(input, 0, &mut texts);
    in_texts(&texts, terms)
}

/// The kinds of private value in a text (a fetched address).
pub fn in_text(text: &str, terms: &[String]) -> Vec<Kind> {
    in_texts(&[text.to_string()], terms)
}

fn in_texts(texts: &[String], terms: &[String]) -> Vec<Kind> {
    let mut found: Vec<Kind> = Vec::new();
    for t in texts {
        // A value in an address may be percent-encoded.
        let decoded = percent_decode(t);
        for text in [t.as_str(), decoded.as_str()] {
            for span in nekko_privacy::scan(text, &|k| counts(k), &[], terms) {
                if !found.contains(&span.kind) {
                    found.push(span.kind);
                }
            }
        }
    }
    found.sort();
    found
}

fn strings(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 8 {
        return;
    }
    match v {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|i| strings(i, depth + 1, out)),
        Value::Object(map) => {
            for (k, child) in map {
                if !crate::outward::is_recipient_key(k) {
                    strings(child, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The kinds in words, for an approval: "an API key or token and an email address".
pub fn describe(kinds: &[Kind]) -> String {
    let words: Vec<&str> = kinds
        .iter()
        .map(|k| match k {
            Kind::Email => "an email address",
            Kind::Phone => "a phone number",
            Kind::Card => "a card number",
            Kind::Ssn | Kind::MyNumber => "a government ID number",
            Kind::Secret => "an API key, token or password",
            Kind::Term => "one of your private terms",
            Kind::Ip => "an IP address",
            Kind::User => "your account name",
        })
        .collect();
    match words.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_keys_cards_and_terms_in_arguments_and_addresses() {
        let token = "ghp_0123456789abcdefghijABCDEFGHIJ";
        assert_eq!(in_input(&json!({ "query": format!("leaked {token}") }), &[]), [Kind::Secret]);
        assert_eq!(in_input(&json!({ "q": "card 4111 1111 1111 1111" }), &[]), [Kind::Card]);
        assert_eq!(in_input(&json!({ "query": "Project Bluebird budget" }), &["Bluebird".into()]), [Kind::Term]);
        assert_eq!(in_text(&format!("https://x.example/?q={token}"), &[]), [Kind::Secret]);
        assert_eq!(in_text("https://x.example/?q=ops%40example.com", &[]), [Kind::Email], "percent-encoded");
    }

    #[test]
    fn ordinary_queries_and_recipients_do_not_count() {
        assert!(in_input(&json!({ "query": "rust serde flatten enum" }), &[]).is_empty());
        assert!(in_input(&json!({ "path": "/Users/davide/code/app.ts" }), &[]).is_empty(), "account name in a path");
        assert!(in_input(&json!({ "to": "ops@example.com", "subject": "hi" }), &[]).is_empty(), "the recipient rule's");
        assert!(in_text("https://93.184.216.34/page", &[]).is_empty(), "an IP host");
    }

    #[test]
    fn says_the_kinds_never_the_values() {
        assert_eq!(describe(&[Kind::Secret]), "an API key, token or password");
        assert_eq!(describe(&[Kind::Email, Kind::Secret]), "an email address and an API key, token or password");
    }
}
