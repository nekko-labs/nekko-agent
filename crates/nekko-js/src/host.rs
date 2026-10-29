//! What the TS services asked Node for (`Date.now()`, `crypto.randomUUID()`,
//! `os.homedir()`), once for every crate that ports one.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()`: milliseconds since the epoch, 0 for a clock set before it.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// [`now_ms`] as the double JavaScript holds it.
pub fn now_ms_f64() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// `crypto.randomUUID()`: a version 4 UUID, lower-case hex. Without entropy
/// the bytes stay zero (with the version bits set), which no caller treats as
/// a secret.
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    format_uuid(b)
}

/// [`uuid`], or the error when the system has no entropy to give.
pub fn try_uuid() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| e.to_string())?;
    Ok(format_uuid(b))
}

fn format_uuid(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `os.homedir()`: libuv reads `USERPROFILE` on Windows and `HOME` elsewhere.
/// `None` when it is unset.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// [`home_dir`] as a string, empty when it is unset or not Unicode.
pub fn home_dir_string() -> String {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(id.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(uuid(), uuid());
        assert_eq!(try_uuid().unwrap().len(), 36);
    }

    #[test]
    fn the_clock_reads_the_same_in_both_types() {
        let (a, b) = (now_ms(), now_ms_f64());
        assert!(b >= a as f64 && b - (a as f64) < 1000.0);
    }
}
