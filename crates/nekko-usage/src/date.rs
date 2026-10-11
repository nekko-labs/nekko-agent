//! The slice of JavaScript's `Date` the accounting needs: `Date.parse` for
//! the formats providers send (ISO 8601 as ECMAScript defines it, RFC 1123
//! and RFC 850 HTTP dates) and the date half of `toISOString`.
//!
//! Anything else is `NaN` here. V8's legacy parser also reads looser strings
//! (`"Fri Oct 10 12:00:00 2025"`, a bare `"5"` as May 2001); no provider sends
//! those, and `parse_retry_after` and the usage JSON treat `NaN` as absent.

use chrono::{Local, LocalResult, NaiveDate, TimeZone};

/// ECMAScript's TimeClip bound, in ms either side of the epoch.
const MAX_TIME: f64 = 8.64e15;

/// TimeClip: `NaN` past the bound, else the integer part.
pub fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > MAX_TIME { f64::NAN } else { t.trunc() + 0.0 }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// MakeDay + MakeTime in UTC; overflowing fields roll over as `Date.UTC` does.
fn utc_ms(y: i64, mon: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    let y = y + (mon - 1).div_euclid(12);
    let mon = (mon - 1).rem_euclid(12) + 1;
    let days = days_from_civil(y, mon, 1) + d - 1;
    (days as f64) * 86_400_000.0 + ((h * 3600 + mi * 60 + s) * 1000 + ms) as f64
}

/// `new Date(t).toISOString().slice(0, 10)`, or `None` for an invalid date
/// (where `toISOString` throws).
pub fn iso_date(t: f64) -> Option<String> {
    let t = time_clip(t);
    if t.is_nan() {
        return None;
    }
    let days = (t / 86_400_000.0).floor() as i64;
    let (y, m, d) = civil_from_days(days);
    let full = if (0..=9999).contains(&y) {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        let sign = if y < 0 { '-' } else { '+' };
        format!("{sign}{:06}-{m:02}-{d:02}", y.abs())
    };
    Some(full.chars().take(10).collect())
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn digits(&mut self, n: usize) -> Option<i64> {
        let s = self.b.get(self.i..self.i + n)?;
        if !s.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.i += n;
        std::str::from_utf8(s).ok()?.parse().ok()
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn done(&self) -> bool {
        self.i == self.b.len()
    }
}

/// The local-time reading of a wall-clock instant, as V8 resolves one.
fn local_ms(y: i64, mon: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    let as_utc = utc_ms(y, mon, d, h, mi, s, ms);
    if !as_utc.is_finite() {
        return f64::NAN;
    }
    let Some(naive) = chrono::DateTime::from_timestamp_millis(as_utc as i64).map(|d| d.naive_utc()) else {
        return f64::NAN;
    };
    let offset_ms = match Local.offset_from_local_datetime(&naive) {
        LocalResult::Single(o) | LocalResult::Ambiguous(o, _) => i64::from(o.local_minus_utc()) * 1000,
        // A wall time skipped by a forward change: V8 reads it with the offset before the change.
        LocalResult::None => {
            Local.offset_from_utc_datetime(&naive).local_minus_utc().checked_mul(1000).map(i64::from).unwrap_or(0)
        }
    };
    as_utc - offset_ms as f64
}

/// ECMAScript's Date Time String Format, plus the two looseness V8 adds that
/// providers use: a space for the `T`, and an offset without its colon.
fn parse_iso(s: &str) -> Option<f64> {
    let mut c = Cursor { b: s.as_bytes(), i: 0 };
    let year = if c.eat(b'+') {
        c.digits(6)?
    } else if c.eat(b'-') {
        let y = c.digits(6)?;
        if y == 0 {
            return None;
        }
        -y
    } else {
        c.digits(4)?
    };
    let (mut mon, mut day) = (1, 1);
    if c.eat(b'-') {
        mon = c.digits(2)?;
        if c.eat(b'-') {
            day = c.digits(2)?;
        }
    }
    if !(1..=12).contains(&mon) || !(1..=31).contains(&day) {
        return None;
    }
    if c.done() {
        return Some(time_clip(utc_ms(year, mon, day, 0, 0, 0, 0)));
    }
    if !(c.eat(b'T') || c.eat(b't') || c.eat(b' ')) {
        return None;
    }
    let h = c.digits(2)?;
    if !c.eat(b':') {
        return None;
    }
    let mi = c.digits(2)?;
    let (mut sec, mut ms) = (0, 0);
    if c.eat(b':') {
        sec = c.digits(2)?;
        if c.eat(b'.') {
            let start = c.i;
            while c.b.get(c.i).is_some_and(u8::is_ascii_digit) {
                c.i += 1;
            }
            let frac = &s[start..c.i];
            if frac.is_empty() {
                return None;
            }
            let three: String = frac.chars().chain("000".chars()).take(3).collect();
            ms = three.parse().ok()?;
        }
    }
    if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi, sec, ms) != (0, 0, 0)) {
        return None;
    }
    let offset_min = if c.eat(b'Z') || c.eat(b'z') {
        Some(0)
    } else if c.b.get(c.i).is_some_and(|&b| b == b'+' || b == b'-') {
        let sign = if c.b[c.i] == b'+' { 1 } else { -1 };
        c.i += 1;
        let oh = c.digits(2)?;
        c.eat(b':');
        let om = c.digits(2)?;
        if oh > 23 || om > 59 {
            return None;
        }
        Some(sign * (oh * 60 + om))
    } else {
        None
    };
    if !c.done() {
        return None;
    }
    Some(time_clip(match offset_min {
        Some(off) => utc_ms(year, mon, day, h, mi, sec, ms) - (off * 60_000) as f64,
        None => local_ms(year, mon, day, h, mi, sec, ms),
    }))
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// `Fri, 10 Oct 2025 12:00:00 GMT`, `10 Oct 2025 12:00:00 GMT` and RFC 850's
/// `Friday, 10-Oct-25 12:00:00 GMT`.
fn parse_http(s: &str) -> Option<f64> {
    let rest = match s.split_once(',') {
        Some((day, rest)) if day.chars().all(|c| c.is_ascii_alphabetic()) => rest.trim_start(),
        Some(_) => return None,
        None => s,
    };
    let parts: Vec<&str> = rest.split_ascii_whitespace().collect();
    let (d, mon, y, time, zone) = match parts.as_slice() {
        [date, time, zone] => {
            let mut it = date.split('-');
            let (d, m, y) = (it.next()?, it.next()?, it.next()?);
            if it.next().is_some() {
                return None;
            }
            (d, m, y, *time, *zone)
        }
        [d, m, y, time, zone] => (*d, *m, *y, *time, *zone),
        _ => return None,
    };
    if !zone.eq_ignore_ascii_case("GMT") && !zone.eq_ignore_ascii_case("UTC") && zone != "Z" {
        return None;
    }
    let day: i64 = d.parse().ok()?;
    let mon = MONTHS.iter().position(|m| mon.len() >= 3 && mon[..3].eq_ignore_ascii_case(m))? as i64 + 1;
    let mut year: i64 = y.parse().ok()?;
    if y.len() == 2 {
        // V8 reads a two-digit year below 50 as 20xx, the rest as 19xx.
        year += if year < 50 { 2000 } else { 1900 };
    }
    let t: Vec<i64> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let (h, mi, sec) = match t.as_slice() {
        [h, m] => (*h, *m, 0),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    if !(1..=31).contains(&day) || h > 24 || mi > 59 || sec > 59 {
        return None;
    }
    NaiveDate::from_ymd_opt(year as i32, mon as u32, 1)?;
    Some(time_clip(utc_ms(year, mon, day, h, mi, sec, 0)))
}

/// `Date.parse(s)` for the formats above; `NaN` for anything else.
pub fn parse(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return f64::NAN;
    }
    parse_iso(t).or_else(|| parse_http(t)).unwrap_or(f64::NAN)
}

/// `new Date(v).getTime()` for a parsed JSON value.
pub fn from_value(v: Option<&serde_json::Value>) -> f64 {
    use serde_json::Value;
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => time_clip(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => parse(s),
        Some(_) => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_what_providers_send() {
        assert_eq!(parse("2026-10-12T10:00:00.123456789Z"), 1_791_799_200_123.0);
        assert_eq!(parse("2026-10-12T10:00:00+0530"), 1_791_779_400_000.0);
        assert_eq!(parse("2026-10-12T10:00:00+05:30"), 1_791_779_400_000.0);
        assert_eq!(parse("2026-10-12"), 1_791_763_200_000.0);
        assert_eq!(parse("2026-10"), 1_790_812_800_000.0);
        assert_eq!(parse("2026"), 1_767_225_600_000.0);
        assert_eq!(parse("+002026-10-12T00:00:00Z"), 1_791_763_200_000.0);
        assert_eq!(parse("2026-02-30T00:00:00Z"), 1_772_409_600_000.0);
        assert_eq!(parse("2026-10-12T24:00:00Z"), 1_791_849_600_000.0);
        assert_eq!(parse("2026-10-12 10:00:00Z"), 1_791_799_200_000.0);
        assert_eq!(parse("Fri, 10 Oct 2025 12:00:00 GMT"), 1_760_097_600_000.0);
        assert_eq!(parse("10 Oct 2025 12:00:00 GMT"), 1_760_097_600_000.0);
        assert_eq!(parse("Friday, 10-Oct-25 12:00:00 GMT"), 1_760_097_600_000.0);
        for bad in ["soon", "", "2026-13-01T00:00:00Z", "30", "1.5x", "2026-10-12T10:00:00Zjunk"] {
            assert!(parse(bad).is_nan(), "{bad}");
        }
    }

    #[test]
    fn a_time_without_an_offset_is_local() {
        let local = parse("2026-10-12T10:00:00");
        let utc = parse("2026-10-12T10:00:00Z");
        let off =
            Local.offset_from_utc_datetime(&chrono::DateTime::from_timestamp_millis(utc as i64).unwrap().naive_utc());
        assert_eq!(utc - local, f64::from(off.local_minus_utc()) * 1000.0);
    }

    #[test]
    fn iso_dates_match_to_iso_string() {
        assert_eq!(iso_date(0.0).unwrap(), "1970-01-01");
        assert_eq!(iso_date(-86_400_001.0).unwrap(), "1969-12-30");
        assert_eq!(iso_date(1.9).unwrap(), "1970-01-01");
        assert_eq!(iso_date(8.64e15).unwrap(), "+275760-09");
        assert_eq!(iso_date(-8.64e15).unwrap(), "-271821-04");
        assert!(iso_date(8.64e15 + 1.0).is_none());
        assert!(iso_date(f64::NAN).is_none());
    }
}
