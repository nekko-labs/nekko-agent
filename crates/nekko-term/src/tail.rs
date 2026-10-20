//! A capped tail of a terminal's scrollback, for viewers on a slow link (a
//! paired phone over the relay).
//!
//! The full ring is up to [`crate::RING_CAP`] (2 MB); a phone asks for the
//! last few dozen kilobytes instead. Cutting at an arbitrary byte replays as
//! garbage when the cut lands inside a UTF-8 character or an escape sequence,
//! so [`tail_cut`] moves the start forward to a clean boundary, preferring the
//! start of a line when one is close.

/// What `terminal:tail` sends when the caller names no size.
pub const TAIL_DEFAULT: usize = 64 * 1024;
/// The most `terminal:tail` sends, whatever the caller asks for.
pub const TAIL_MAX: usize = 512 * 1024;

/// How far back from the cut to look for the escape sequence it may be inside.
/// OSC strings (titles, hyperlinks) are the long ones; past this, give up.
const ESC_LOOKBACK: usize = 4096;
/// How far past the cut to look for a newline to restart on.
const LINE_SEEK: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Where the last at most `max` bytes of `buf` should start so they replay
/// cleanly: never inside a UTF-8 character or an escape sequence, and at a
/// line start when one is within [`LINE_SEEK`] bytes. `buf[result..]` is at
/// most `max` bytes long; when everything fits the result is 0.
pub fn tail_cut(buf: &[u8], max: usize) -> usize {
    let len = buf.len();
    if len <= max {
        return 0;
    }
    let mut start = len - max;

    // Inside an escape sequence: skip to its end.
    let from = start.saturating_sub(ESC_LOOKBACK);
    if let Some(esc) = buf[from..start].iter().rposition(|&b| b == ESC).map(|i| from + i) {
        match sequence_end(buf, esc) {
            Some(end) if end > start => start = end,
            Some(_) => {}
            // Unterminated to the end of the buffer: nothing after it is clean.
            None => return len,
        }
    }

    // Inside a UTF-8 character: skip its continuation bytes.
    while start < len && (buf[start] & 0xC0) == 0x80 {
        start += 1;
    }

    // Prefer a line start when one is near.
    let limit = (start + LINE_SEEK).min(len);
    if let Some(nl) = buf[start..limit].iter().position(|&b| b == b'\n') {
        start += nl + 1;
    }
    start
}

/// The index just past the escape sequence that starts at `buf[esc]` (an
/// ESC), or `None` when it runs off the end of the buffer.
fn sequence_end(buf: &[u8], esc: usize) -> Option<usize> {
    let mut i = esc + 1;
    let first = *buf.get(i)?;
    match first {
        // CSI: parameters 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E.
        b'[' => {
            i += 1;
            while let Some(&b) = buf.get(i) {
                match b {
                    0x20..=0x3F => i += 1,
                    0x40..=0x7E => return Some(i + 1),
                    // Anything else aborts the sequence; the byte stands alone.
                    _ => return Some(i),
                }
            }
            None
        }
        // OSC, DCS, SOS, PM, APC: a string ended by BEL or ST (ESC \).
        b']' | b'P' | b'X' | b'^' | b'_' => {
            i += 1;
            while let Some(&b) = buf.get(i) {
                if b == BEL {
                    return Some(i + 1);
                }
                if b == ESC {
                    return if buf.get(i + 1) == Some(&b'\\') { Some(i + 2) } else { Some(i) };
                }
                i += 1;
            }
            None
        }
        // Two-byte (or with intermediates) escapes: ESC ( B, ESC =, ESC 7...
        _ => {
            while let Some(&b) = buf.get(i) {
                match b {
                    0x20..=0x2F => i += 1,
                    0x30..=0x7E => return Some(i + 1),
                    _ => return Some(i),
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(buf: &[u8], max: usize) -> &[u8] {
        let cut = tail_cut(buf, max);
        assert!(buf.len() - cut <= max, "tail longer than {max}");
        &buf[cut..]
    }

    #[test]
    fn everything_fits() {
        assert_eq!(tail(b"hello", 10), b"hello");
        assert_eq!(tail(b"", 10), b"");
    }

    #[test]
    fn prefers_the_next_line_start() {
        assert_eq!(tail(b"first line\nsecond\n", 12), b"second\n");
    }

    #[test]
    fn never_starts_inside_a_utf8_character() {
        // No newline to restart on: the cut lands inside a 3-byte character.
        let buf = "ab猫cd".as_bytes();
        let t = tail(buf, 4);
        assert_eq!(t, b"cd");
        assert!(std::str::from_utf8(t).is_ok());
        // Every cut of a multibyte string decodes.
        let s = "é猫😀x".repeat(20);
        for max in 0..s.len() {
            assert!(std::str::from_utf8(tail(s.as_bytes(), max)).is_ok(), "max {max}");
        }
    }

    #[test]
    fn never_starts_inside_a_csi_sequence() {
        let buf = b"\x1b[38;5;196mred";
        // Cut after "\x1b[3": skip to just past the final 'm'.
        assert_eq!(tail(buf, buf.len() - 3), b"red");
        // Cut exactly at the ESC keeps the whole sequence.
        assert_eq!(tail(buf, buf.len()), &buf[..]);
    }

    #[test]
    fn never_starts_inside_an_osc_string() {
        let buf = b"\x1b]0;a long window title\x07$ ls";
        assert_eq!(tail(buf, 10), b"$ ls");
        let st = b"\x1b]8;;https://example.com\x1b\\link";
        assert_eq!(tail(st, 8), b"link");
    }

    #[test]
    fn a_finished_sequence_before_the_cut_does_not_move_it() {
        let buf = b"\x1b[0mabcdefgh";
        assert_eq!(tail(buf, 4), b"efgh");
    }

    #[test]
    fn an_unterminated_sequence_leaves_nothing() {
        let buf = b"abc\x1b]0;still going";
        assert_eq!(tail(buf, 5), b"");
    }

    #[test]
    fn short_escapes_end_after_their_final_byte() {
        let buf = b"\x1b(Bxyz";
        assert_eq!(tail(buf, 5), b"xyz");
    }
}
