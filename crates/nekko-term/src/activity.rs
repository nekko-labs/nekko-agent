//! Passive, bounded metadata. Terminal output is untrusted display data, never commands.
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalActivity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request_url: Option<String>,
}

#[derive(Default)]
pub struct Observer {
    mode: u8,
    osc: Vec<u8>,
    word: Vec<u8>,
    word_overflow: bool,
}

fn text(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(160)
        .collect::<String>()
        .trim()
        .to_owned()
}

impl Observer {
    pub fn feed(&mut self, bytes: &[u8], activity: &mut TerminalActivity) {
        for &b in bytes {
            match self.mode {
                0 => {
                    if b == 27 {
                        self.finish_word(activity);
                        self.mode = 1;
                    } else if b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b'<' | b'>' | b')' | b']') {
                        self.finish_word(activity);
                    } else if !self.word_overflow {
                        if self.word.len() < 512 {
                            self.word.push(b);
                        } else {
                            self.word.clear();
                            self.word_overflow = true;
                        }
                    }
                }
                1 => {
                    self.mode = if b == b']' {
                        self.osc.clear();
                        2
                    } else {
                        0
                    };
                }
                2 => {
                    if b == 7 {
                        self.apply(activity);
                        self.mode = 0;
                    } else if b == 27 {
                        self.mode = 3;
                    } else if self.osc.len() < 4096 {
                        self.osc.push(b);
                    } else {
                        self.osc.clear();
                        self.mode = 4;
                    }
                }
                3 => {
                    if b == b'\\' {
                        self.apply(activity);
                        self.mode = 0;
                    } else {
                        self.osc.clear();
                        self.mode = if b == b']' { 2 } else { 0 };
                    }
                }
                // Discard an oversized OSC until its terminator. Never interpret its tail.
                4 => {
                    if b == 7 {
                        self.mode = 0;
                    } else if b == 27 {
                        self.mode = 5;
                    }
                }
                5 => {
                    self.mode = if b == b'\\' || b == 7 { 0 } else { 4 };
                }
                _ => unreachable!(),
            }
        }
    }

    fn finish_word(&mut self, activity: &mut TerminalActivity) {
        if !self.word_overflow {
            if let Ok(s) = std::str::from_utf8(&self.word) {
                let s = s.trim_end_matches(['.', ',', ';', ':']);
                if valid_pr(s) {
                    activity.pull_request_url = Some(s.to_owned());
                }
            }
        }
        self.word.clear();
        self.word_overflow = false;
    }

    fn apply(&mut self, a: &mut TerminalActivity) {
        let Ok(s) = std::str::from_utf8(&self.osc) else { return };
        if let Some(title) = s.strip_prefix("0;").or_else(|| s.strip_prefix("2;")) {
            let title = text(title);
            a.title = (!title.is_empty()).then_some(title);
        } else if let Some(path) = s.strip_prefix("7;file:///") {
            // Only an explicitly local absolute path, never an SSH host's path.
            if let Some(path) = decode_path(&format!("/{path}")) {
                a.cwd = Some(path);
            }
        } else if s == "133;C" {
            a.state = Some("running".into());
            a.detail = Some("Command running".into());
            a.last_exit_code = None;
        } else if s == "133;A" || s == "133;B" {
            a.state = Some("idle".into());
        } else if let Some(code) = s.strip_prefix("133;D") {
            a.state = Some("idle".into());
            a.last_exit_code = code.strip_prefix(';').and_then(|c| c.parse().ok());
            a.detail = Some(
                if a.last_exit_code.is_some_and(|c| c != 0) { "Command failed" } else { "Command finished" }.into(),
            );
        } else if let Some(body) = s.strip_prefix("777;notify;") {
            a.state = Some("attention".into());
            a.detail = Some(text(&body.replace(';', " · ")));
        } else if let Some(body) = s.strip_prefix("777;nekko;") {
            if let Some((state, detail)) = body.split_once(';') {
                let state = match state {
                    "working" => "running",
                    "idle" => "idle",
                    "attention" => "attention",
                    _ => return,
                };
                a.state = Some(state.into());
                a.detail = Some(text(detail));
                a.last_exit_code = None;
            }
        }
    }
}

fn valid_pr(s: &str) -> bool {
    let Some(path) = s.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 4
        && parts[..2].iter().all(|p| {
            !p.is_empty()
                && *p != "."
                && *p != ".."
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_ .".contains(&b) && b != b' ')
        })
        && parts[2] == "pull"
        && !parts[3].is_empty()
        && parts[3].bytes().all(|b| b.is_ascii_digit())
        && parts[3].parse::<u64>().is_ok_and(|n| n > 0)
}

fn decode_path(path: &str) -> Option<String> {
    if path.len() > 2048 {
        return None;
    }
    let mut out = Vec::new();
    let mut bytes = path.bytes();
    while let Some(b) = bytes.next() {
        out.push(if b == b'%' {
            let h = (bytes.next()? as char).to_digit(16)?;
            let l = (bytes.next()? as char).to_digit(16)?;
            (h * 16 + l) as u8
        } else {
            b
        });
    }
    let path = String::from_utf8(out).ok()?;
    (!path.chars().any(char::is_control)).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_sequences_and_unicode() {
        let mut o = Observer::default();
        let mut a = TerminalActivity::default();
        for b in "\x1b]2;Fix 日本語\x1b\\\x1b]133;C\x07".bytes() {
            o.feed(&[b], &mut a);
        }
        assert_eq!(a.title.as_deref(), Some("Fix 日本語"));
        assert_eq!(a.state.as_deref(), Some("running"));
        o.feed(b"\x1b]133;D;1\x07", &mut a);
        assert_eq!(a.last_exit_code, Some(1));
        o.feed(b"\x1b]777;nekko;attention;Claude Code needs permission\x07", &mut a);
        assert_eq!(a.state.as_deref(), Some("attention"));
    }
    #[test]
    fn bounded_and_recovers() {
        let mut o = Observer::default();
        let mut a = TerminalActivity::default();
        o.feed(b"\x1b]2;", &mut a);
        o.feed(&vec![b'a'; 100_000], &mut a);
        o.feed(b"\x07", &mut a);
        assert!(a.title.is_none());
        assert!(o.osc.len() <= 4096);
        o.feed(&vec![b'x'; 100_000], &mut a);
        assert!(o.word.len() <= 512);
        o.feed(b"\n\x1b]2;Recovered\x07", &mut a);
        assert_eq!(a.title.as_deref(), Some("Recovered"));
    }
    #[test]
    fn pr_links_are_exact_and_chunk_safe() {
        let mut o = Observer::default();
        let mut a = TerminalActivity::default();
        for b in b"https://github.com/example/repo/pull/42\n" {
            o.feed(&[*b], &mut a);
        }
        assert_eq!(a.pull_request_url.as_deref(), Some("https://github.com/example/repo/pull/42"));
        for s in [
            "https://github.com.evil/a/b/pull/1",
            "https://github.com/a/b/pull/1/evil",
            "https://github.com/a/b/pull/0",
            "https://github.com/a/b/pull/1?token=secret",
        ] {
            assert!(!valid_pr(s));
        }
    }
    #[test]
    fn local_paths_and_untrusted_notifications() {
        let mut o = Observer::default();
        let mut a = TerminalActivity::default();
        o.feed(b"\x1b]7;file:///tmp/my%20project\x07", &mut a);
        assert_eq!(a.cwd.as_deref(), Some("/tmp/my project"));
        o.feed(b"\x1b]7;file://remote/etc\x07", &mut a);
        assert_eq!(a.cwd.as_deref(), Some("/tmp/my project"));
        o.feed(b"\x1b]777;notify;Claude Code;Needs permission\x07", &mut a);
        assert_eq!(a.state.as_deref(), Some("attention"));
        assert!(decode_path("/bad%00path").is_none());
    }
}
